import { describe, expect, it } from "bun:test";
import {
  PlayerSession,
} from "../session/player-session";
import {
  PLAYER_SESSION_SNAPSHOT_LIMITS,
  PLAYER_SESSION_SNAPSHOT_VERSION,
  validatePlayerSessionSnapshot,
  type PlayerSessionSnapshot,
} from "../session/player-session-snapshot";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeSession() {
  const scenes = new Map([
    ["character-a", "library"],
    ["character-b", "cellar"],
  ]);
  return new PlayerSession((characterId) => scenes.get(characterId));
}

function semanticRevision(session: PlayerSession): bigint {
  return (session as PlayerSession & { readonly semanticRevision: bigint }).semanticRevision;
}

function populatedSession() {
  const session = makeSession();
  session.join("alice", "Alice", "character-a");
  session.join("bob", "Bob", "character-b");
  session.discover("alice", "bloodstain");
  session.discover("bob", "locked-drawer");
  session.push({
    speaker: "KP",
    content: "Everyone hears the bell.",
    type: "narration",
    verbatim: true,
    mood: "calm",
    timestamp: 1,
    visibility: "public",
    discoverer: "alice",
  });
  session.push({ speaker: "KP", content: "Alice only.", type: "system", timestamp: 2 }, "discoverer_only", "alice");
  session.switchActive("bob");
  session.push({ speaker: "KP", content: "Bob only.", type: "action", timestamp: 3 }, "private");
  return session;
}

function validSnapshot(): PlayerSessionSnapshot {
  return populatedSession().exportSnapshot();
}

/** A pre-retirement persisted document, not a new PlayerSession write. */
function legacyVisibleToSnapshot(): PlayerSessionSnapshot {
  const snapshot = validSnapshot();
  snapshot.globalMessages[0]!.visible_to = ["alice", "bob"];
  for (const player of snapshot.players) {
    player.messageHistory[0]!.visible_to = ["alice", "bob"];
  }
  return snapshot;
}

describe("PlayerSession portable snapshot", () => {
  it("round-trips every player, private history, secrets, active receiver, and scene delegate without sharing references", () => {
    // `visible_to` remains readable legacy snapshot data even though it is no
    // longer accepted by the new live write boundary.
    const source = makeSession();
    source.restoreSnapshot(legacyVisibleToSnapshot());
    const exported = source.exportSnapshot();
    expect(exported).toMatchObject({
      kind: "player-session",
      schemaVersion: PLAYER_SESSION_SNAPSHOT_VERSION,
      activePlayerName: "bob",
      players: [
        { name: "alice", characterName: "Alice", characterId: "character-a", knownSecrets: ["bloodstain"] },
        { name: "bob", characterName: "Bob", characterId: "character-b", knownSecrets: ["locked-drawer"] },
      ],
    });
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
    expect(exported.globalMessages[0]!.visible_to).toEqual(["alice", "bob"]);
    expect(exported.players[0]!.messageHistory[0]!.visible_to).toEqual(["alice", "bob"]);

    const restored = makeSession();
    restored.restoreSnapshot(exported);
    expect(restored.getActive()?.name).toBe("bob");
    expect(restored.knowsSecret("alice", "bloodstain")).toBe(true);
    expect(restored.knowsSecret("bob", "locked-drawer")).toBe(true);
    expect(restored.getPlayerHistory("alice").map((message) => message.content)).toEqual([
      "Everyone hears the bell.",
      "Alice only.",
    ]);
    expect(restored.getPlayerHistory("bob").map((message) => message.content)).toEqual([
      "Everyone hears the bell.",
      "Bob only.",
    ]);
    expect(restored.getPlayerHistory("alice")[0]!.visible_to).toEqual(["alice", "bob"]);
    expect(restored.getRecentGlobal(3)[0]!.visible_to).toEqual(["alice", "bob"]);

    // Restored character IDs still query the injected authoritative scene source.
    restored.switchActive("alice");
    restored.push({ speaker: "KP", content: "library-only", type: "narration", timestamp: 4 }, "scene_restricted");
    restored.switchActive("bob");
    restored.push({ speaker: "KP", content: "cellar-only", type: "narration", timestamp: 5 }, "scene_restricted");
    expect(restored.getPlayerHistory("alice").map((message) => message.content)).toContain("library-only");
    expect(restored.getPlayerHistory("alice").map((message) => message.content)).not.toContain("cellar-only");
    expect(restored.getPlayerHistory("bob").map((message) => message.content)).toContain("cellar-only");
    expect(restored.getPlayerHistory("bob").map((message) => message.content)).not.toContain("library-only");

    exported.players[0]!.knownSecrets.push("tampered");
    exported.players[0]!.messageHistory[0]!.content = "tampered";
    exported.players[0]!.messageHistory[0]!.visible_to!.push("tampered-player-viewer");
    exported.globalMessages[0]!.content = "global-tampered";
    exported.globalMessages[0]!.visible_to!.push("tampered-global-viewer");
    expect(source.knowsSecret("alice", "tampered")).toBe(false);
    expect(source.getPlayerHistory("alice")[0]!.content).toBe("Everyone hears the bell.");
    expect(source.getPlayerHistory("alice")[0]!.visible_to).toEqual(["alice", "bob"]);
    expect(source.getRecentGlobal(3)[0]!.content).toBe("Everyone hears the bell.");
    expect(source.getRecentGlobal(3)[0]!.visible_to).toEqual(["alice", "bob"]);
    expect(restored.knowsSecret("alice", "tampered")).toBe(false);
    expect(restored.getPlayerHistory("alice")[0]!.content).toBe("Everyone hears the bell.");
    expect(restored.getPlayerHistory("alice")[0]!.visible_to).toEqual(["alice", "bob"]);
  });

  it("keeps every public player and message view writable but detached from authoritative state", () => {
    const session = populatedSession();
    const joined = session.join("charlie", "Charlie", "character-c");

    joined.characterName = "Forged Charlie";
    joined.knownSecrets.add("forged-join-secret");
    joined.messageHistory.push({ speaker: "KP", content: "forged join history", type: "system", timestamp: 10 });

    const active = session.getActive()!;
    active.characterName = "Forged Bob";
    active.knownSecrets.add("forged-active-secret");
    active.messageHistory[0]!.content = "forged active content";

    const byName = session.get("alice")!;
    byName.characterId = "forged-alice-id";
    byName.knownSecrets.add("forged-get-secret");

    const fromAll = session.getAll().find((player) => player.name === "alice")!;
    fromAll.characterName = "Forged Alice";

    const inScene = session.getPlayersInScene("library")[0]!;
    inScene.characterName = "Forged Scene Alice";
    inScene.knownSecrets.add("forged-scene-secret");

    const history = session.getPlayerHistory("alice");
    history[0]!.content = "forged history content";
    history.push({ speaker: "KP", content: "forged history entry", type: "system", timestamp: 11 });

    const activeHistory = session.getActiveHistory();
    activeHistory[0]!.content = "forged active history content";
    activeHistory.pop();

    const recent = session.getRecentGlobal(10);
    recent[0]!.content = "forged recent content";
    recent.pop();

    expect(session.get("charlie")!).toMatchObject({
      characterName: "Charlie",
      knownSecrets: new Set(),
      messageHistory: [],
    });
    expect(session.get("bob")!).toMatchObject({ characterName: "Bob" });
    expect(session.get("alice")!).toMatchObject({ characterName: "Alice", characterId: "character-a" });
    expect(session.knowsSecret("alice", "forged-get-secret")).toBe(false);
    expect(session.knowsSecret("alice", "forged-scene-secret")).toBe(false);
    expect(session.knowsSecret("bob", "forged-active-secret")).toBe(false);
    expect(session.getPlayerHistory("alice").map((message) => message.content)).toEqual([
      "Everyone hears the bell.",
      "Alice only.",
    ]);
    expect(session.getActiveHistory().map((message) => message.content)).toEqual([
      "Everyone hears the bell.",
      "Bob only.",
    ]);
    expect(session.getRecentGlobal(10).map((message) => message.content)).toEqual([
      "Everyone hears the bell.",
      "Alice only.",
      "Bob only.",
    ]);
  });

  it("captures nested PlayerSlot state when the detached view is returned", () => {
    const session = populatedSession();
    const view = session.get("alice")!;

    // Do not touch either nested field before authority changes. A detached
    // view is a snapshot at return time, not a delayed read through to source.
    session.discover("alice", "discovered-after-view");
    session.push({ speaker: "KP", content: "history after view", type: "system", timestamp: 15 }, "discoverer_only", "alice");

    expect([...view.knownSecrets]).toEqual(["bloodstain"]);
    expect(view.messageHistory.map((message) => message.content)).toEqual([
      "Everyone hears the bell.",
      "Alice only.",
    ]);
    const historySnapshot = view.messageHistory;
    const secretsSnapshot = view.knownSecrets;
    expect(view.messageHistory).toBe(historySnapshot);
    expect(view.knownSecrets).toBe(secretsSnapshot);

    const assignedHistory = [{
      speaker: "KP",
      content: "local assigned history",
      type: "system" as const,
      timestamp: 16,
      visible_to: ["alice"],
    }];
    const assignedSecrets = new Set(["local assigned secret"]);
    view.messageHistory = assignedHistory;
    view.knownSecrets = assignedSecrets;
    assignedHistory[0]!.visible_to.push("forged setter viewer");
    assignedSecrets.add("forged setter secret");
    view.messageHistory[0]!.content = "local rewritten history";
    view.knownSecrets.add("local rewritten secret");

    expect(view.messageHistory).toMatchObject([
      { content: "local rewritten history", visible_to: ["alice"] },
    ]);
    expect([...view.knownSecrets]).toEqual(["local assigned secret", "local rewritten secret"]);
    expect(session.knowsSecret("alice", "local assigned secret")).toBe(false);
    expect(session.knowsSecret("alice", "local rewritten secret")).toBe(false);
    expect(session.getPlayerHistory("alice").map((message) => message.content)).toEqual([
      "Everyone hears the bell.",
      "Alice only.",
      "history after view",
    ]);
    expect(session.knowsSecret("alice", "discovered-after-view")).toBe(true);
  });

  it("fail-closes new own visible_to writes before any delivery, audit, or revision side effect", () => {
    const session = makeSession();
    session.join("alice", "Alice", "character-a");
    session.join("bob", "Bob", "character-b");
    const before = session.exportSnapshot();
    const revision = semanticRevision(session);

    const timestamped = {
      speaker: "KP",
      content: "timestamped input",
      type: "system" as const,
      timestamp: 12,
      visible_to: ["alice"],
    };
    // The previous implementation ignored this field for routing and broadcast
    // it under the default public rule, including to Bob.
    expect(() => session.push(timestamped)).toThrow("does not accept message.visible_to");
    expect(session.getPlayerHistory("bob")).toEqual([]);

    const explicitlyUndefined = {
      speaker: "KP",
      content: "own undefined visible_to is also ambiguous",
      type: "system" as const,
      visible_to: undefined,
    };
    expect(() => session.push(explicitlyUndefined)).toThrow("does not accept message.visible_to");
    expect(session.exportSnapshot()).toEqual(before);
    expect(semanticRevision(session)).toBe(revision);
  });

  it("retires the per-receiver writer from the PlayerSession prototype", () => {
    const prototype = PlayerSession.prototype as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(prototype, "pushPerPlayer")).toBe(false);
    expect(prototype.pushPerPlayer).toBeUndefined();
  });

  it("keeps private and scene-restricted delivery on the internal active slot", () => {
    const session = populatedSession();
    session.switchActive("alice");
    session.push({ speaker: "KP", content: "private after public views", type: "system", timestamp: 13 }, "private");
    session.push({ speaker: "KP", content: "library after public views", type: "system", timestamp: 14 }, "scene_restricted");

    expect(session.getPlayerHistory("alice").map((message) => message.content)).toContain("private after public views");
    expect(session.getPlayerHistory("alice").map((message) => message.content)).toContain("library after public views");
    expect(session.getPlayerHistory("bob").map((message) => message.content)).not.toContain("library after public views");
  });

  it("revises each routine semantic mutation once and leaves routine no-ops unchanged", () => {
    const session = makeSession();
    expect(semanticRevision(session)).toBe(0n);

    session.join("alice", "Alice", "character-a");
    expect(semanticRevision(session)).toBe(1n);
    expect(() => session.join("alice", "Duplicate", "duplicate")).toThrow();
    expect(semanticRevision(session)).toBe(1n);

    expect(session.switchActive("alice")).toBe(true);
    expect(semanticRevision(session)).toBe(1n);
    expect(session.switchActive("nobody")).toBe(false);
    expect(semanticRevision(session)).toBe(1n);

    session.join("bob", "Bob", "character-b");
    expect(semanticRevision(session)).toBe(2n);
    expect(session.switchActive("bob")).toBe(true);
    expect(semanticRevision(session)).toBe(3n);

    expect(session.leave("nobody")).toBe(false);
    session.discover("nobody", "missing-secret");
    expect(semanticRevision(session)).toBe(3n);
    session.discover("bob", "real-secret");
    expect(semanticRevision(session)).toBe(4n);
    session.discover("bob", "real-secret");
    expect(semanticRevision(session)).toBe(4n);

    session.push({ speaker: "KP", content: "targeted", type: "system", timestamp: 20 }, "targeted", undefined, ["bob", "alice", "bob"]);
    expect(semanticRevision(session)).toBe(5n);
    expect(session.getPlayerHistory("alice").map((message) => message.content)).toEqual(["targeted"]);
    expect(session.getPlayerHistory("bob").map((message) => message.content)).toEqual(["targeted", "targeted"]);

    // A global audit-log write is semantic even when no player receives it.
    session.push({ speaker: "KP", content: "global only", type: "system", timestamp: 21 }, "targeted", undefined, ["nobody"]);
    expect(semanticRevision(session)).toBe(6n);
    expect(session.getRecentGlobal(1)[0]!.content).toBe("global only");

    // Targeted delivery is the sole live routing model. Even an empty target
    // set records its global audit event, so it is not a mutator no-op.
    session.push({ speaker: "KP", content: "targeted empty", type: "system", timestamp: 22 }, "targeted", undefined, []);
    expect(semanticRevision(session)).toBe(7n);
    expect(session.getRecentGlobal(1)[0]!.content).toBe("targeted empty");
    session.push({ speaker: "KP", content: "Alice receives this", type: "system", timestamp: 23 }, "targeted", undefined, ["alice"]);
    expect(semanticRevision(session)).toBe(8n);
    expect(session.getPlayerHistory("alice").map((message) => message.content)).toEqual(["targeted", "Alice receives this"]);

    expect(session.leave("bob")).toBe(true);
    expect(semanticRevision(session)).toBe(9n);
    expect(session.getActive()?.name).toBe("alice");
  });

  it("does not partially write a scene-restricted push when scene lookup throws", () => {
    const session = new PlayerSession((characterId) => {
      if (characterId === "character-b") throw new Error("scene lookup failed");
      return "library";
    });
    session.join("alice", "Alice", "character-a");
    session.join("bob", "Bob", "character-b");
    const before = session.exportSnapshot();
    const revision = semanticRevision(session);

    expect(() => session.push(
      { speaker: "KP", content: "only same room", type: "system", timestamp: 22 },
      "scene_restricted",
    )).toThrow("scene lookup failed");

    expect(session.exportSnapshot()).toEqual(before);
    expect(semanticRevision(session)).toBe(revision);
  });

  it("validates exactly, including each optional AgentMessage field and membership invariants", () => {
    const valid = validSnapshot();
    const cases: Array<[string, unknown]> = [];

    const unknownTopLevel = clone(valid) as any;
    unknownTopLevel.unexpected = true;
    cases.push(["unknown top-level key", unknownTopLevel]);

    const unknownPlayerKey = clone(valid) as any;
    unknownPlayerKey.players[0].unexpected = true;
    cases.push(["unknown player key", unknownPlayerKey]);

    const unknownMessageKey = clone(valid) as any;
    unknownMessageKey.globalMessages[0].unexpected = true;
    cases.push(["unknown message key", unknownMessageKey]);

    const wrongVersion = clone(valid) as any;
    wrongVersion.schemaVersion = 0;
    cases.push(["unsupported version", wrongVersion]);

    const unsafeJoinedAt = clone(valid) as any;
    unsafeJoinedAt.players[0].joinedAt = Number.MAX_SAFE_INTEGER + 1;
    cases.push(["unsafe joinedAt", unsafeJoinedAt]);

    const duplicatePlayer = clone(valid) as any;
    duplicatePlayer.players.push(clone(duplicatePlayer.players[0]));
    cases.push(["duplicate player", duplicatePlayer]);

    const duplicateSecret = clone(valid) as any;
    duplicateSecret.players[0].knownSecrets.push(duplicateSecret.players[0].knownSecrets[0]);
    cases.push(["duplicate secret", duplicateSecret]);

    const missingActivePlayer = clone(valid) as any;
    missingActivePlayer.activePlayerName = "nobody";
    cases.push(["missing active player", missingActivePlayer]);

    const forgedPrivateHistory = clone(valid) as any;
    forgedPrivateHistory.players[0].messageHistory.push({ speaker: "KP", content: "forged private history", type: "system" });
    cases.push(["history message absent from global audit", forgedPrivateHistory]);

    const reorderedPrivateHistory = clone(valid) as any;
    reorderedPrivateHistory.players[0].messageHistory.reverse();
    cases.push(["history message out of global audit order", reorderedPrivateHistory]);

    const malformedOptionalFields: Array<[string, unknown]> = [
      ["verbatim", "yes"],
      ["mood", "paranoid"],
      ["visible_to", ["alice", 7]],
      ["timestamp", Number.NaN],
      ["visibility", "everyone"],
      ["discoverer", 7],
    ];
    for (const [field, value] of malformedOptionalFields) {
      const malformed = clone(valid) as any;
      malformed.globalMessages[0][field] = value;
      cases.push([`malformed message ${field}`, malformed]);
    }

    const prototypeObject = Object.assign(Object.create({ inherited: true }), valid);
    cases.push(["prototype object", prototypeObject]);

    const hiddenRequiredField = clone(valid) as any;
    Object.defineProperty(hiddenRequiredField, "schemaVersion", {
      value: PLAYER_SESSION_SNAPSHOT_VERSION,
      enumerable: false,
    });
    cases.push(["non-enumerable required field", hiddenRequiredField]);

    const arrayWithNonIndexProperty = clone(valid) as any;
    Object.defineProperty(arrayWithNonIndexProperty.globalMessages, "4294967295", {
      value: undefined,
      enumerable: true,
    });
    cases.push(["array non-index property", arrayWithNonIndexProperty]);

    const sparseGlobalMessages = clone(valid) as any;
    delete sparseGlobalMessages.globalMessages[1];
    cases.push(["sparse global messages", sparseGlobalMessages]);

    const getterMessage = clone(valid) as any;
    Object.defineProperty(getterMessage.globalMessages, "0", {
      enumerable: true,
      get: () => valid.globalMessages[0],
    });
    cases.push(["message getter", getterMessage]);

    for (const [name, snapshot] of cases) {
      expect(() => validatePlayerSessionSnapshot(snapshot), name).toThrow();
    }
  });

  it("enforces bounded arrays and leaves the current session untouched when restore rejects", () => {
    const target = populatedSession();
    const before = target.exportSnapshot();
    const bad = clone(validSnapshot()) as any;
    bad.globalMessages = Array.from(
      { length: PLAYER_SESSION_SNAPSHOT_LIMITS.maxGlobalMessages + 1 },
      () => ({ speaker: "KP", content: "x", type: "system" }),
    );
    expect(() => target.restoreSnapshot(bad)).toThrow();
    expect(target.exportSnapshot()).toEqual(before);

    const tooManyRecipients = clone(validSnapshot()) as any;
    tooManyRecipients.globalMessages[0].visible_to = Array.from(
      { length: PLAYER_SESSION_SNAPSHOT_LIMITS.maxVisibleTo + 1 },
      (_, index) => `player-${index}`,
    );
    expect(() => validatePlayerSessionSnapshot(tooManyRecipients)).toThrow();

    const tooManyHistoryMessages = clone(validSnapshot()) as any;
    tooManyHistoryMessages.players[0].messageHistory = Array.from(
      { length: PLAYER_SESSION_SNAPSHOT_LIMITS.maxMessagesPerPlayer + 1 },
      () => ({ speaker: "KP", content: "x", type: "system" }),
    );
    expect(() => validatePlayerSessionSnapshot(tooManyHistoryMessages)).toThrow();

    const tooManyPlayers = clone(validSnapshot()) as any;
    tooManyPlayers.players = Array.from(
      { length: PLAYER_SESSION_SNAPSHOT_LIMITS.maxPlayers + 1 },
      (_, index) => ({
        ...clone(tooManyPlayers.players[0]),
        name: `player-${index}`,
        messageHistory: [],
        knownSecrets: [],
      }),
    );
    tooManyPlayers.activePlayerName = "player-0";
    expect(() => validatePlayerSessionSnapshot(tooManyPlayers)).toThrow();

    const tooManySecrets = clone(validSnapshot()) as any;
    tooManySecrets.players[0].knownSecrets = Array.from(
      { length: PLAYER_SESSION_SNAPSHOT_LIMITS.maxKnownSecretsPerPlayer + 1 },
      (_, index) => `secret-${index}`,
    );
    expect(() => validatePlayerSessionSnapshot(tooManySecrets)).toThrow();
  });

  it("uses the same versioned validator for checkpoint snapshots and restores cloned input", () => {
    const source = populatedSession();
    const checkpoint = source.snapshot();
    expect(validatePlayerSessionSnapshot(checkpoint)).toEqual(checkpoint);

    const target = makeSession();
    target.restoreSnapshot(checkpoint);
    checkpoint.activePlayerName = "alice";
    checkpoint.players[1]!.knownSecrets.push("not-shared");
    checkpoint.globalMessages[0]!.content = "not-shared";
    expect(target.getActive()?.name).toBe("bob");
    expect(target.knowsSecret("bob", "not-shared")).toBe(false);
    expect(target.getRecentGlobal(3)[0]!.content).toBe("Everyone hears the bell.");
  });

  it("revises only semantic whole-state replacements and leaves exact or invalid restores unchanged", () => {
    const target = populatedSession();
    const before = target.exportSnapshot();
    const semanticBefore = semanticRevision(target);
    expect(target.stateReplacementRevision).toBe(0n);

    target.restoreSnapshot(clone(before));
    expect(target.stateReplacementRevision).toBe(0n);
    expect(semanticRevision(target)).toBe(semanticBefore);
    expect(target.exportSnapshot()).toEqual(before);

    const invalid = clone(before) as any;
    invalid.unexpected = true;
    expect(() => target.restoreSnapshot(invalid)).toThrow();
    expect(target.stateReplacementRevision).toBe(0n);
    expect(semanticRevision(target)).toBe(semanticBefore);
    expect(target.exportSnapshot()).toEqual(before);

    const changed = clone(before);
    changed.players[0]!.knownSecrets.push("temporary-restore-secret");
    target.restoreSnapshot(changed);
    expect(target.stateReplacementRevision).toBe(1n);
    expect(semanticRevision(target)).toBe(semanticBefore + 1n);
    expect(target.knowsSecret("alice", "temporary-restore-secret")).toBe(true);

    target.restoreSnapshot(before);
    expect(target.stateReplacementRevision).toBe(2n);
    expect(semanticRevision(target)).toBe(semanticBefore + 2n);
    expect(target.exportSnapshot()).toEqual(before);
  });

  it("keeps authoritative state insulated from a legacy own players alias", () => {
    const target = populatedSession();
    const checkpoint = target.exportSnapshot();
    const revision = target.stateReplacementRevision;
    const semantic = semanticRevision(target);

    Object.defineProperty(target, "players", {
      value: new Map([[
        "alice",
        { messageHistory: [{ speaker: "KP", content: "forged", type: "system", timestamp: 9 }] },
      ]]),
      configurable: true,
      writable: false,
    });
    try {
      expect(target.exportSnapshot()).toEqual(checkpoint);
      target.restoreSnapshot(checkpoint);
      expect(target.stateReplacementRevision).toBe(revision);
      expect(semanticRevision(target)).toBe(semantic);
      expect(target.exportSnapshot()).toEqual(checkpoint);
    } finally {
      delete (target as any).players;
    }
  });

  it("covers restoreSinglePlayer without treating a fresh Date.now observation as change", () => {
    const target = makeSession();
    const history: Parameters<PlayerSession["restoreSinglePlayer"]>[2] = [
      { speaker: "KP", content: "restored", type: "system", timestamp: 7 },
    ];

    target.restoreSinglePlayer("p1", "Ada", history);
    expect(target.stateReplacementRevision).toBe(1n);
    expect(semanticRevision(target)).toBe(1n);
    const first = target.exportSnapshot();

    target.restoreSinglePlayer("p1", "Ada", clone(history));
    expect(target.stateReplacementRevision).toBe(1n);
    expect(semanticRevision(target)).toBe(1n);
    expect(target.exportSnapshot()).toEqual(first);

    target.restoreSinglePlayer("p1", "Ada", [
      ...history,
      { speaker: "KP", content: "changed", type: "system", timestamp: 8 },
    ]);
    expect(target.stateReplacementRevision).toBe(2n);
    expect(semanticRevision(target)).toBe(2n);
  });
});
