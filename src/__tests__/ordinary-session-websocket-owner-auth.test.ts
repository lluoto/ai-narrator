import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CompilerPrincipalRole, CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession } from "../api/game-session";
import { OrdinarySessionSnapshotStore } from "../api/ordinary-session-snapshot-store";
import {
  authorizeOrdinarySessionWebSocketUpgrade,
  compiledSessionWebSocketRefusal,
  handleRequest,
  type OrdinarySessionAccessOptions,
  type OrdinarySessionWebSocketUpgradeDependencies,
  type SessionRuntimeDependencies,
} from "../api/server";
import { SessionNamespaceCoordinator } from "../api/session-namespace-coordinator";
import type { WsConnectionData } from "../api/ws-handler";

const ownerId = "keeper:ordinary-ws-owner";
const foreignId = "keeper:ordinary-ws-foreign";
const OFFLINE_LLM_CONFIG = {
  apiKey: "sk-placeholder",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

function authenticated(role: CompilerPrincipalRole, id: string): CompilerRequestAuthenticator {
  return () => ({ status: "authenticated", principal: { role, id } });
}

interface OrdinaryFixture {
  root: string;
  sessionId: string;
  snapshots: OrdinarySessionSnapshotStore;
  namespace: SessionNamespaceCoordinator;
  created: () => number;
}

async function createOrdinaryFixture(): Promise<OrdinaryFixture> {
  const root = mkdtempSync(join(tmpdir(), "ordinary-ws-owner-auth-"));
  const registry = new Map<string, GameSession>();
  let created = 0;
  const dependencies: SessionRuntimeDependencies = {
    registry,
    createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, runtimeDependencies }) => {
      created++;
      const session = new GameSession(id, ruleset, OFFLINE_LLM_CONFIG, archetypeId, characterName, persona, storage, access, "development_fallback", runtimeDependencies);
      session.getOpeningScene = async () => "opening";
      return session;
    },
  };
  const sessionRoot = join(root, "sessions");
  const response = await handleRequest(
    new Request("http://test/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruleset: "cosmic-horror", archetype: "investigator", characterName: "Ada", owner: foreignId }),
    }),
    undefined,
    undefined,
    { careerRoot: join(root, "careers"), sessionRoot },
    {},
    {},
    authenticated("keeper", ownerId),
    undefined,
    undefined,
    undefined,
    { mode: "required" },
    dependencies,
  );
  expect(response.status).toBe(201);
  const { sessionId } = await response.json() as { sessionId: string };
  return {
    root,
    sessionId,
    snapshots: new OrdinarySessionSnapshotStore({ root: join(sessionRoot, "ordinary-snapshots") }),
    namespace: new SessionNamespaceCoordinator(sessionRoot),
    created: () => created,
  };
}

function wsRequest(sessionId: string, query = "role=player&playerId=caller-selected-player"): Request {
  return new Request(`http://test/ws?session=${encodeURIComponent(sessionId)}&${query}`);
}

function asResponse(result: WsConnectionData | Response): Response {
  expect(result).toBeInstanceOf(Response);
  return result as Response;
}

describe("ordinary WebSocket authenticated owner replacement", () => {
  it("authenticates before locator/store reads, admits only the durable owner, and derives kp-only connection data", async () => {
    const fixture = await createOrdinaryFixture();
    try {
      let authenticates = 0;
      const owner = await authorizeOrdinarySessionWebSocketUpgrade(
        wsRequest(fixture.sessionId),
        {
          compilerAuthenticator: () => {
            authenticates++;
            return { status: "authenticated", principal: { role: "keeper", id: ownerId } };
          },
          ordinarySnapshots: fixture.snapshots,
          sessionNamespace: fixture.namespace,
          ordinarySessionAccess: { mode: "required" },
        },
      );
      expect(authenticates).toBe(1);
      expect(owner).toEqual({ sessionId: fixture.sessionId, role: "kp" });
      expect((owner as WsConnectionData).playerId).toBeUndefined();

      const before = fixture.created();
      const foreign = asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest(fixture.sessionId, "role=kp&playerId=forged-owner"), {
        compilerAuthenticator: authenticated("keeper", foreignId), ordinarySnapshots: fixture.snapshots,
        sessionNamespace: fixture.namespace, ordinarySessionAccess: { mode: "required" },
      }));
      const unknown = asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest("11111111-1111-4111-8111-111111111111"), {
        compilerAuthenticator: authenticated("keeper", foreignId), ordinarySnapshots: fixture.snapshots,
        sessionNamespace: fixture.namespace, ordinarySessionAccess: { mode: "required" },
      }));
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await foreign.text()).toBe(await unknown.text());
      const player = asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest(fixture.sessionId), {
        compilerAuthenticator: authenticated("player", ownerId), ordinarySnapshots: fixture.snapshots,
        sessionNamespace: fixture.namespace, ordinarySessionAccess: { mode: "required" },
      }));
      expect(player.status).toBe(404);
      expect(fixture.created()).toBe(before);

      let locatorReads = 0;
      const unauthenticated = asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest(fixture.sessionId), {
        compilerAuthenticator: () => ({ status: "unauthenticated" }),
        ordinarySnapshots: { read: () => { locatorReads++; throw new Error("snapshot must not be read"); } },
        sessionNamespace: { read: () => { locatorReads++; throw new Error("namespace must not be read"); } },
        ordinarySessionAccess: { mode: "required" },
      }));
      expect(unauthenticated.status).toBe(401);
      expect(locatorReads).toBe(0);
      const unavailable = asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest(fixture.sessionId), {
        compilerAuthenticator: () => ({ status: "unavailable" }),
        ordinarySnapshots: { read: () => { locatorReads++; throw new Error("snapshot must not be read"); } },
        sessionNamespace: { read: () => { locatorReads++; throw new Error("namespace must not be read"); } },
        ordinarySessionAccess: { mode: "required" },
      }));
      expect(unavailable.status).toBe(503);
      expect(locatorReads).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed for orphaned, non-committed, wrong-kind, mismatched, missing, and corrupt durable evidence without construction", async () => {
    const fixture = await createOrdinaryFixture();
    try {
      const envelope = fixture.snapshots.read(fixture.sessionId);
      expect(envelope.status).toBe("ok");
      if (envelope.status !== "ok") throw new Error("fixture envelope is unavailable");
      const identity = {
        hash: envelope.value.envelopeHash,
        generation: envelope.value.generation,
        format: "ordinary-session-envelope-v1",
      };
      const before = fixture.created();
      const options: OrdinarySessionWebSocketUpgradeDependencies = {
        compilerAuthenticator: authenticated("keeper", ownerId),
        ordinarySnapshots: fixture.snapshots,
        ordinarySessionAccess: { mode: "required" },
      };

      const orphan = new SessionNamespaceCoordinator(join(fixture.root, "orphan-namespace"));
      expect(asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest(fixture.sessionId), { ...options, sessionNamespace: orphan })).status).toBe(404);

      const wrongKind = new SessionNamespaceCoordinator(join(fixture.root, "wrong-kind-namespace"));
      wrongKind.reconcileObserved({ sessionId: fixture.sessionId, kind: "compiled", observedIdentity: identity });
      expect(asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest(fixture.sessionId), { ...options, sessionNamespace: wrongKind })).status).toBe(404);

      const reserved = new SessionNamespaceCoordinator(join(fixture.root, "reserved-namespace"));
      reserved.reserve({ sessionId: fixture.sessionId, kind: "ordinary" });
      expect(asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest(fixture.sessionId), { ...options, sessionNamespace: reserved })).status).toBe(404);

      const prepared = new SessionNamespaceCoordinator(join(fixture.root, "prepared-namespace"));
      const reservation = prepared.reserve({ sessionId: fixture.sessionId, kind: "ordinary" });
      prepared.prepare({ reservation, expectedIdentity: identity });
      expect(asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest(fixture.sessionId), { ...options, sessionNamespace: prepared })).status).toBe(404);

      const quarantined = new SessionNamespaceCoordinator(join(fixture.root, "quarantined-namespace"));
      quarantined.reconcileObserved({ sessionId: fixture.sessionId, kind: "ordinary", reasonCode: "TEST_QUARANTINED" });
      expect(asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest(fixture.sessionId), { ...options, sessionNamespace: quarantined })).status).toBe(404);

      const mismatched = new SessionNamespaceCoordinator(join(fixture.root, "mismatched-namespace"));
      mismatched.reconcileObserved({
        sessionId: fixture.sessionId,
        kind: "ordinary",
        observedIdentity: { ...identity, hash: "0".repeat(64) },
        observedPredecessorHash: null,
      });
      expect(asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest(fixture.sessionId), {
        ...options,
        sessionNamespace: mismatched,
      })).status).toBe(404);

      const missingSnapshots = new OrdinarySessionSnapshotStore({ root: join(fixture.root, "missing-snapshots") });
      expect(asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest(fixture.sessionId), {
        ...options, ordinarySnapshots: missingSnapshots, sessionNamespace: fixture.namespace,
      })).status).toBe(404);
      const corruptRoot = join(fixture.root, "corrupt-snapshots");
      mkdirSync(corruptRoot, { recursive: true });
      writeFileSync(join(corruptRoot, `${fixture.sessionId}.ordinary-current.json`), "{", "utf8");
      const corruptSnapshots = new OrdinarySessionSnapshotStore({ root: corruptRoot });
      expect(asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest(fixture.sessionId), {
        ...options, ordinarySnapshots: corruptSnapshots, sessionNamespace: fixture.namespace,
      })).status).toBe(404);
      expect(fixture.created()).toBe(before);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves non-production anonymous legacy query compatibility, rejects it in production, and never opens compiled legacy WS", async () => {
    const development: OrdinarySessionAccessOptions = { mode: "development_anonymous", environment: { NODE_ENV: "test" } };
    const legacy = await authorizeOrdinarySessionWebSocketUpgrade(wsRequest("legacy-ordinary", "role=player&playerId=legacy-player"), {
      ordinarySessionAccess: development,
    });
    expect(legacy).toEqual({ sessionId: "legacy-ordinary", role: "player", playerId: "legacy-player" });

    const production = asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest("legacy-ordinary"), {
      ordinarySessionAccess: { mode: "development_anonymous", environment: { NODE_ENV: "production" } },
    }));
    expect(production.status).toBe(503);

    const closedCompiled = asResponse(await authorizeOrdinarySessionWebSocketUpgrade(wsRequest("compiled-session"), {
      ordinarySessionAccess: development,
      compiledLegacyRefusal: (sessionId) => compiledSessionWebSocketRefusal(
        sessionId,
        new Map([["compiled-session", { getCompiledGeneration: () => 0 }]]),
        { isOccupied: () => false },
      ),
    }));
    expect(closedCompiled.status).toBe(403);
  });
});
