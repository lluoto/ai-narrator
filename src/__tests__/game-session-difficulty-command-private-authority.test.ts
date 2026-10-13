import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GameSession } from "../api/game-session";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";
import { createCompiledDurableTestHost } from "./helpers/compiled-durable-host";

const CONFIG = {
  apiKey: "sk-difficulty-command-authority",
  baseUrl: "http://difficulty-command-authority.invalid/v1",
  model: "fixture",
  maxTokens: 32,
  temperature: 0,
};

function fresh(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada");
}

function canonicalDifficulty(session: GameSession): string | null | undefined {
  return session.exportOrdinarySessionSnapshot().state.activeDifficulty;
}

function eventContents(response: Awaited<ReturnType<GameSession["act"]>>): string[] {
  return response.events.map((event) => event.content);
}

function expectHardConfirmation(
  session: GameSession,
  response: Awaited<ReturnType<GameSession["act"]>>,
  expectedRound: number,
): void {
  const contents = eventContents(response);
  expect(response.error).toBeUndefined();
  expect(response.state.round).toBe(expectedRound);
  expect(canonicalDifficulty(session)).toBe("hard");
  expect(contents.some((content) => content.includes("难度设为 hard"))).toBe(true);
  expect(contents.some((content) => content.includes("forged difficulty"))).toBe(false);
  expect(session.getPlayerHistory("p1").messages.some((event) => event.content.includes("难度设为 hard"))).toBe(true);
}

const OWN_SHADOWS: ReadonlyArray<{
  label: string;
  install: (session: GameSession) => void;
}> = [
  {
    label: "no-op",
    install: (session) => Object.defineProperty(session, "setDifficulty", {
      configurable: true,
      value: () => ({ ok: true, value: { changes: [] } }),
    }),
  },
  {
    label: "fake-reject",
    install: (session) => Object.defineProperty(session, "setDifficulty", {
      configurable: true,
      value: () => ({ ok: false, error: { code: "forged difficulty reject" } }),
    }),
  },
  {
    label: "redirect-to-easy",
    install: (session) => {
      const canonical = session.setDifficulty;
      Object.defineProperty(session, "setDifficulty", {
        configurable: true,
        value: () => canonical.call(session, "easy"),
      });
    },
  },
  {
    label: "throwing",
    install: (session) => Object.defineProperty(session, "setDifficulty", {
      configurable: true,
      value: () => { throw new Error("forged difficulty throw"); },
    }),
  },
];

for (const shadow of OWN_SHADOWS) {
  it(`does not let an own ${shadow.label} setDifficulty shadow alter or DoS /diff`, async () => {
    const session = fresh(`difficulty-command-own-${shadow.label}-${crypto.randomUUID()}`);
    try {
      shadow.install(session);
      const response = await session.act("/diff hard");
      expectHardConfirmation(session, response, 1);
    } finally {
      session.close();
    }
  });
}

for (const shadow of OWN_SHADOWS.slice(0, 1).concat(OWN_SHADOWS.slice(2))) {
  it(`does not let a temporary ${shadow.label} setDifficulty prototype shadow contaminate independent /diff sessions`, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(GameSession.prototype, "setDifficulty");
    if (!descriptor) throw new Error("fixture requires the public setDifficulty wrapper");
    const left = fresh(`difficulty-command-prototype-left-${shadow.label}-${crypto.randomUUID()}`);
    const right = fresh(`difficulty-command-prototype-right-${shadow.label}-${crypto.randomUUID()}`);
    try {
      if (shadow.label === "redirect-to-easy") {
        const canonical = descriptor.value as GameSession["setDifficulty"];
        Object.defineProperty(GameSession.prototype, "setDifficulty", {
          configurable: true,
          writable: true,
          value: function(this: GameSession) { return canonical.call(this, "easy"); },
        });
      } else if (shadow.label === "throwing") {
        Object.defineProperty(GameSession.prototype, "setDifficulty", {
          configurable: true,
          writable: true,
          value: () => { throw new Error("forged difficulty prototype throw"); },
        });
      } else {
        Object.defineProperty(GameSession.prototype, "setDifficulty", {
          configurable: true,
          writable: true,
          value: () => ({ ok: true, value: { changes: [] } }),
        });
      }
      expectHardConfirmation(left, await left.act("/diff hard"), 1);
      expectHardConfirmation(right, await right.act("/diff hard"), 1);
    } finally {
      Object.defineProperty(GameSession.prototype, "setDifficulty", descriptor);
      left.close();
      right.close();
    }
  });
}

it("reports the first /diff hard transition and then its idempotent no-op without drifting", async () => {
  const session = fresh(`difficulty-command-repeat-${crypto.randomUUID()}`);
  try {
    const first = await session.act("/diff hard");
    expectHardConfirmation(session, first, 1);

    const second = await session.act("/diff hard");
    expect(second.error).toBeUndefined();
    expect(second.state.round).toBe(2);
    expect(canonicalDifficulty(session)).toBe("hard");
    expect(eventContents(second).some((content) => content.includes("难度已经是 hard"))).toBe(true);
    expect(session.getPlayerHistory("p1").messages.some((event) => event.content.includes("难度已经是 hard"))).toBe(true);
  } finally {
    session.close();
  }
});

it("keeps the public setDifficulty wrapper shadowable without letting its candidate leak into /diff", () => {
  const session = fresh(`difficulty-command-public-boundary-${crypto.randomUUID()}`);
  try {
    const forged = { ok: false, error: { code: "forged public wrapper" } };
    Object.defineProperty(session, "setDifficulty", { configurable: true, value: () => forged });
    expect((session as unknown as { setDifficulty(diff: string): unknown }).setDifficulty("hard")).toBe(forged);
    expect(canonicalDifficulty(session)).toBeNull();
  } finally {
    session.close();
  }
});

it("rejects /diff impossible before any public setDifficulty decoy can run", async () => {
  const session = fresh(`difficulty-command-invalid-${crypto.randomUUID()}`);
  try {
    let decoyCalls = 0;
    Object.defineProperty(session, "setDifficulty", {
      configurable: true,
      value: () => { decoyCalls++; throw new Error("forged difficulty should not run for invalid input"); },
    });
    const response = await session.act("/diff impossible");
    expect(response.error).toBeUndefined();
    expect(canonicalDifficulty(session)).toBeNull();
    expect(decoyCalls).toBe(0);
    expect(eventContents(response).some((content) => content.includes("难度设为"))).toBe(false);
    expect(eventContents(response).some((content) => content.includes("forged difficulty"))).toBe(false);
  } finally {
    session.close();
  }
});

it("keeps the compiled action codec ahead of ordinary /diff dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "difficulty-command-compiled-"));
  let session: GameSession | undefined;
  try {
    const host = createCompiledDurableTestHost();
    const fixture = await compiledModuleHttpFixture("difficulty-command-compiled");
    const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
    const saved = catalog.saveBundle(fixture.resolved.artifact, fixture.projection);
    if (saved.status !== "ok") throw new Error(saved.message);
    const bundle = catalog.loadBundle(saved.value.id);
    if (bundle.status !== "ok") throw new Error(bundle.message);
    session = new GameSession("difficulty-command-compiled", "cosmic-horror", CONFIG, "investigator", "Ada", undefined, { careerRoot: join(root, "careers") }, undefined, "preferred", host.runtimeDependencies);
    expect(session.loadDurableCompiledModule(bundle.value)).toMatchObject({ status: "loaded" });
    const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
    const initial = host.snapshot(session);
    expect(snapshots.save(initial)).toMatchObject({ status: "ok" });
    host.acknowledge(session, initial);
    Object.defineProperty(session, "setDifficulty", {
      configurable: true,
      value: () => { throw new Error("forged ordinary difficulty dispatch"); },
    });

    const response = await session.act("/diff hard");
    expect(response.error?.code).toBe("compiled_action_contract_required");
    expect(response.state.round).toBe(0);
    expect(session.getCompiledGeneration()).toBe(0);
  } finally {
    session?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
