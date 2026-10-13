import { afterEach, expect, test } from "bun:test";
import { GameSession } from "../api/game-session";

const CONFIG = {
  apiKey: "sk-npc-history-private-authority",
  baseUrl: "http://npc-history-private-authority.invalid/v1",
  model: "fixture",
  maxTokens: 128,
  temperature: 0,
};

const ENV_KEYS = ["LLM_DISABLED", "LLM_MODE", "LLM_API_KEY", "OPENAI_API_KEY"] as const;
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
const SAVED_FETCH = globalThis.fetch;

const BARN_LOAD = "\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3";
const BARN_BAR = "\u7ef4\u68ee\u9152\u5427";
const BOUNCER = "\u9152\u5427\u4fdd\u9556";
const MOVE_TO_BAR = `\u524d\u5f80 ${BARN_BAR}`;
const TALK_TO_BOUNCER = `\u8ddf${BOUNCER}\u8bf4\u8bdd`;
const CANONICAL_MARKER = "CANONICAL NPC HISTORY MARKER";
const FORGED_MARKER = "FORGED NPC HISTORY MARKER";
const NPC_REPLY = "\u6211\u4f1a\u7559\u610f\u95e8\u53e3\u7684\u52a8\u9759\u3002";
const GENERIC_NON_RESPONSE = "\u6ca1\u6709\u56de\u5e94";
const INTENT_SYSTEM_MARKER = "\u610f\u56fe\u89e3\u6790\u5668";
const NPC_SYSTEM_MARKER = "TRPG";

type ShadowTarget = "own" | "prototype";
type ShadowKind = "fake" | "throw";
type PublicGetHistory = GameSession["getHistory"];
type ChatRequest = { messages?: Array<{ content?: unknown }> };

const sessions: GameSession[] = [];

afterEach(() => {
  while (sessions.length > 0) sessions.pop()!.close();
  globalThis.fetch = SAVED_FETCH;
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

function enableLocalLLM(): void {
  delete process.env.LLM_DISABLED;
  delete process.env.LLM_MODE;
  process.env.LLM_API_KEY = CONFIG.apiKey;
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

function shadowPublicHistory(session: GameSession, target: ShadowTarget, kind: ShadowKind): () => void {
  const receiver = target === "own" ? session : GameSession.prototype;
  const original = Object.getOwnPropertyDescriptor(receiver, "getHistory");
  const replacement: PublicGetHistory = kind === "fake"
    ? () => ({
      messages: [{ speaker: "FORGED", content: FORGED_MARKER, type: "system" }],
      total: 1,
    })
    : () => { throw new Error("forged public getHistory failure"); };
  Object.defineProperty(receiver, "getHistory", {
    configurable: true,
    writable: true,
    value: replacement,
  });
  return () => restoreProperty(receiver, "getHistory", original);
}

function assertPublicShadowRemainsObservable(session: GameSession, kind: ShadowKind): void {
  if (kind === "fake") {
    expect(session.getHistory(10).messages.map((message) => message.content)).toEqual([FORGED_MARKER]);
    return;
  }
  expect(() => session.getHistory(10)).toThrow("forged public getHistory failure");
}

async function loadedBarnBouncerSession(): Promise<GameSession> {
  const session = new GameSession(
    `npc-history-private-authority-${crypto.randomUUID()}`,
    "cosmic-horror",
    CONFIG,
    "investigator",
    "Ada",
  );
  sessions.push(session);
  expect((await session.act(BARN_LOAD)).error).toBeUndefined();
  expect((await session.act(MOVE_TO_BAR)).error).toBeUndefined();
  expect(session.registry.has(BOUNCER)).toBe(true);
  return session;
}

function installLocalFetch(
  requests: ChatRequest[],
  intentRequests: ChatRequest[],
  npcRequests: ChatRequest[],
): void {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as ChatRequest;
    requests.push(request);
    const system = String(request.messages?.[0]?.content ?? "");
    if (system.includes(INTENT_SYSTEM_MARKER)) {
      intentRequests.push(request);
      const input = String(request.messages?.at(-1)?.content ?? "");
      const intent = input === MOVE_TO_BAR
        ? { action: "move", target: BARN_BAR }
        : input === TALK_TO_BOUNCER
          ? { action: "talk", target: BOUNCER }
          : null;
      if (!intent) throw new Error(`unexpected intent request: ${input}`);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intent) } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (system.includes(NPC_SYSTEM_MARKER)) {
      npcRequests.push(request);
      return new Response(JSON.stringify({ choices: [{ message: { content: NPC_REPLY } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected local fetch system prompt: ${system.slice(0, 80)}`);
  }) as typeof fetch;
}

for (const target of ["own", "prototype"] as const) {
  for (const kind of ["fake", "throw"] as const) {
    test(`${target} ${kind} getHistory shadow remains public-only during a real Barn NPC talk`, async () => {
      enableLocalLLM();
      const requests: ChatRequest[] = [];
      const intentRequests: ChatRequest[] = [];
      const npcRequests: ChatRequest[] = [];
      installLocalFetch(requests, intentRequests, npcRequests);

      const session = await loadedBarnBouncerSession();
      expect(session.sendMessage("KP", CANONICAL_MARKER, "narration")).toBe(true);
      expect(session.getHistory().messages.some((message) => message.content === CANONICAL_MARKER)).toBe(true);

      // All module-load and movement requests happened before the attack setup.
      // The talk assertion below therefore proves exactly which request saw history.
      requests.length = 0;
      intentRequests.length = 0;
      npcRequests.length = 0;
      const restoreShadow = shadowPublicHistory(session, target, kind);
      try {
        assertPublicShadowRemainsObservable(session, kind);

        const response = await session.act(TALK_TO_BOUNCER);

        expect(requests).toHaveLength(2);
        expect(intentRequests).toHaveLength(1);
        expect(npcRequests).toHaveLength(1);
        const npcPrompt = JSON.stringify(npcRequests[0]);
        expect(npcPrompt).toContain(CANONICAL_MARKER);
        expect(npcPrompt).not.toContain(FORGED_MARKER);

        const dialogue = response.events.find((event) => event.speaker === BOUNCER && event.type === "dialogue");
        expect(dialogue?.content).toBe(NPC_REPLY);
        expect(response.narrative).toBe(NPC_REPLY);
        expect(response.narrative).not.toContain(GENERIC_NON_RESPONSE);
      } finally {
        restoreShadow();
      }

      // The public observation wrapper is restored before checking state. This
      // preserves the negative control while proving talk wrote canonical history.
      const history = session.getHistory().messages;
      expect(history.some((message) => message.content === CANONICAL_MARKER)).toBe(true);
      expect(history.some((message) => message.speaker === BOUNCER && message.content === NPC_REPLY)).toBe(true);
    });
  }
}
