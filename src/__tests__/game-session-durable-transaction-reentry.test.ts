import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { GameSession, runOrdinaryDurableActionTransaction } from "../api/game-session";
import { handleRequest, type SessionRuntimeDependencies } from "../api/server";

async function afterPromiseJobs(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function trusted<T>(
  session: GameSession,
  capability: object,
  operation: Parameters<typeof runOrdinaryDurableActionTransaction<T>>[2],
): Promise<T> {
  return runOrdinaryDurableActionTransaction(session, capability, operation);
}

test("a same-session nested trusted durable transaction rejects before waiting on its own FIFO", async () => {
  const capability = {};
  const session = new GameSession(
    `durable-transaction-reentry-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "development_fallback",
    { ordinaryDurableHostCapability: capability },
  );
  let inner: Promise<"inner"> | undefined;
  try {
    const outer = runOrdinaryDurableActionTransaction(session, capability, async () => {
      inner = runOrdinaryDurableActionTransaction(session, capability, async () => "inner" as const);
      const outcome = await Promise.race([
        inner.then(
          () => ({ status: "resolved" as const }),
          (error: unknown) => ({
            status: "rejected" as const,
            code: error instanceof Error && "code" in error
              ? (error as Error & { code?: unknown }).code
              : undefined,
          }),
        ),
        afterPromiseJobs().then(() => ({ status: "still-pending" as const })),
      ]);
      expect(outcome).toEqual({ status: "rejected", code: "ordinary_durable_transaction_reentry" });
      return "outer";
    });

    expect(await outer).toBe("outer");
    if (!inner) throw new Error("test setup did not create the nested transaction");
    await inner.catch(() => undefined);
  } finally {
    session.close();
  }
});

test("independent trusted transactions on one session remain FIFO rather than being treated as reentry", async () => {
  const capability = {};
  const session = new GameSession(
    `durable-transaction-fifo-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "development_fallback",
    { ordinaryDurableHostCapability: capability },
  );
  const releaseFirst = deferred();
  const events: string[] = [];
  try {
    const first = trusted(session, capability, async () => {
      events.push("first-entered");
      await releaseFirst.promise;
      events.push("first-released");
      return "first";
    });
    await afterPromiseJobs();
    expect(events).toEqual(["first-entered"]);

    const second = trusted(session, capability, async () => {
      events.push("second-entered");
      return "second";
    });
    await afterPromiseJobs();
    expect(events).toEqual(["first-entered"]);

    releaseFirst.resolve();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(events).toEqual(["first-entered", "first-released", "second-entered"]);
  } finally {
    releaseFirst.resolve();
    session.close();
  }
});

test("a rejected trusted transaction clears its context and depth before later durable and public actions", async () => {
  const capability = {};
  const session = new GameSession(
    `durable-transaction-cleanup-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "required",
    {
      ordinaryDurableHostCapability: capability,
      sessionIntentClient: { chat: async () => JSON.stringify({ action: "legacy" }) },
    },
  );
  try {
    await expect(trusted(session, capability, async () => {
      throw new Error("durable outer rejection");
    })).rejects.toThrow("durable outer rejection");

    expect(await trusted(session, capability, async () => "recovered")).toBe("recovered");
    expect((await session.act("保存角色")).error).toEqual({ code: "ordinary_durable_transaction_required" });
  } finally {
    session.close();
  }
});

test("a detached descendant may reuse its session after its trusted ancestor has settled", async () => {
  const capability = {};
  const session = new GameSession(
    `durable-transaction-detached-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "development_fallback",
    { ordinaryDurableHostCapability: capability },
  );
  const releaseDescendant = deferred();
  let descendant: Promise<string> | undefined;
  try {
    expect(await trusted(session, capability, async () => {
      descendant = (async () => {
        await releaseDescendant.promise;
        return trusted(session, capability, async () => "detached-success");
      })();
      return "outer-complete";
    })).toBe("outer-complete");

    releaseDescendant.resolve();
    if (!descendant) throw new Error("test setup did not start the detached descendant");
    expect(await descendant).toBe("detached-success");
  } finally {
    releaseDescendant.resolve();
    if (descendant) await descendant.catch(() => undefined);
    session.close();
  }
});

test("one trusted call chain may nest transactions for distinct source and candidate sessions", async () => {
  const sourceCapability = {};
  const candidateCapability = {};
  const source = new GameSession(
    `durable-transaction-source-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "development_fallback",
    { ordinaryDurableHostCapability: sourceCapability },
  );
  const candidate = new GameSession(
    `durable-transaction-candidate-${crypto.randomUUID()}`,
    "cosmic-horror",
    undefined,
    "investigator",
    "Ada",
    undefined,
    undefined,
    undefined,
    "development_fallback",
    { ordinaryDurableHostCapability: candidateCapability },
  );
  try {
    const result = await trusted(source, sourceCapability, async () => {
      return trusted(candidate, candidateCapability, async () => "candidate-complete");
    });
    expect(result).toBe("candidate-complete");
  } finally {
    source.close();
    candidate.close();
  }
});

test("ordinary durable HTTP source-to-candidate staging remains a legal cross-session nesting", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-transaction-http-reentry-"));
  const registry = new Map<string, GameSession>();
  const auth: CompilerRequestAuthenticator = () => ({
    status: "authenticated",
    principal: { role: "keeper", id: "durable-transaction-http-owner" },
  });
  const config = {
    apiKey: "sk-placeholder",
    baseUrl: "http://durable-transaction-http-reentry.invalid/v1",
    model: "durable-transaction-http-reentry",
    maxTokens: 32,
    temperature: 0,
  };
  const dependencies: SessionRuntimeDependencies = {
    registry,
    ordinaryIntentPolicy: "development_fallback",
    createOrdinarySession: ({ id, ruleset, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies }) => {
      const session = new GameSession(id, ruleset, config, archetypeId, characterName, persona, storage, access, intentPolicy, runtimeDependencies);
      session.getOpeningScene = async () => "opening";
      return session;
    },
  };
  const request = (path: string, body?: unknown): Promise<Response> => handleRequest(
    new Request(`http://test${path}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    undefined,
    undefined,
    { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") },
    {},
    {},
    auth,
    undefined,
    undefined,
    undefined,
    { mode: "required" },
    dependencies,
  );
  try {
    const created = await request("/api/sessions", { archetype: "investigator", characterName: "Ada" });
    expect(created.status).toBe(201);
    const id = (await created.json() as { sessionId: string }).sessionId;

    const action = await request(`/api/sessions/${id}/action`, {
      input: "保存角色", actionId: "durable-transaction-http-save-0001", expectedGeneration: 0,
    });
    expect(action.status).toBe(200);
    expect(action.headers.get("X-Ordinary-Action-Disposition")).toBe("committed");
    expect(await action.json()).toMatchObject({ ordinaryGeneration: 1 });
  } finally {
    for (const session of registry.values()) session.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
