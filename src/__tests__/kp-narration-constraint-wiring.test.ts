// GameSession-level wiring tests for the KP narration constraint contract.
// KPAgent itself is covered separately; these assertions keep the real
// session boundary observable without replacing its private KP authority.

import { describe, expect, it } from "bun:test";
import { GameSession } from "../api/game-session";
import { isolatedProviderSeamIt } from "./helpers/provider-seam-child";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 128, temperature: 0,
};
const NARRATION_CAPTURE_CFG = { ...CFG, apiKey: "test-kp-narration-capture-key" };
const LOAD_BARN = "加载模组 普瑞米尔的谷仓";
const CONTROL_ROOM = "中控室";

function makeSession(id: string): GameSession & Record<string, any> {
  return new GameSession(id, "cosmic-horror", CFG, "investigator", "Ada") as any;
}

/** Build a provider-capable session only inside this file's isolated child. */
function makeNarrationCaptureSession(id: string): GameSession & Record<string, any> {
  return new GameSession(id, "cosmic-horror", NARRATION_CAPTURE_CFG, "investigator", "Ada") as any;
}

type CapturedKpRequest = { messages?: Array<{ role?: unknown; content?: unknown }> };

function requestText(request: CapturedKpRequest): string {
  return (request.messages ?? [])
    .map((message) => typeof message.content === "string" ? message.content : "")
    .join("\n");
}

/**
 * Capture real provider requests from GameSession's canonical KP. The local
 * deterministic response and finally restoration make this independent of any
 * configured external provider.
 */
async function captureKpNarration(
  session: GameSession,
  input: string,
  replies: readonly string[],
): Promise<{ response: Awaited<ReturnType<GameSession["act"]>>; narrationRequests: CapturedKpRequest[] }> {
  const previousFetch = globalThis.fetch;
  const requests: CapturedKpRequest[] = [];
  let replyIndex = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("KP narration request body was not JSON text");
    const request = JSON.parse(init.body) as CapturedKpRequest;
    const isNarration = (request.messages ?? []).some((message) =>
      typeof message.content === "string" && message.content.includes("请以 KP 的口吻描述结果"),
    );
    if (!isNarration) {
      // This probe deliberately exercises the normal intent boundary too.
      // Keep that response invalid so the existing regex fallback reaches the
      // KP branch, without consuming a scripted KP narration response.
      return new Response(JSON.stringify({ choices: [{ message: { content: "not an intent response" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    requests.push(request);
    const reply = replies[Math.min(replyIndex++, replies.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const response = await session.act(input);
    return { response, narrationRequests: requests };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function captureKpOpening(
  session: GameSession,
  reply: string,
): Promise<{ opening: string; openingRequests: CapturedKpRequest[] }> {
  const previousFetch = globalThis.fetch;
  const openingRequests: CapturedKpRequest[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("KP opening request body was not JSON text");
    const request = JSON.parse(init.body) as CapturedKpRequest;
    const isOpening = (request.messages ?? []).some((message) =>
      typeof message.content === "string" && message.content.includes("请描述当前场景中玩家能看到"),
    );
    if (!isOpening) throw new Error("unexpected non-opening provider request");
    openingRequests.push(request);
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const opening = await session.getOpeningScene();
    return { opening, openingRequests };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

describe("currentUndiscoveredClueKeys", () => {
  it("includes current-scene display names and split aliases", async () => {
    const session = makeSession(`clue-keys-${Math.random()}`) as any;
    try {
    await session.act(LOAD_BARN);
    session.movePlayerToScene(CONTROL_ROOM);
    const keys: string[] = session.currentUndiscoveredClueKeys();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((key) => key.includes("冰箱"))).toBe(true);
    expect(keys.some((key) => key.includes("储物柜"))).toBe(true);
    } finally {
      session.close();
    }
  });

  it("is empty after every current-scene clue is discovered", async () => {
    const session = makeSession(`clue-keys-discovered-${Math.random()}`) as any;
    try {
    await session.act(LOAD_BARN);
    session.movePlayerToScene(CONTROL_ROOM);
    const realRandom = Math.random;
    Math.random = () => 0;
    try {
      await session.act("检查冰箱", "p1");
      await session.act("拉一下拉杆", "p1");
    } finally {
      Math.random = realRandom;
    }
    expect(session.currentUndiscoveredClueKeys()).toEqual([]);
    } finally {
      session.close();
    }
  });

  it("is safely empty before any module is loaded", () => {
    const session = makeSession(`clue-keys-nomodule-${Math.random()}`) as any;
    try {
    expect(() => session.currentUndiscoveredClueKeys()).not.toThrow();
    expect(session.currentUndiscoveredClueKeys()).toEqual([]);
    } finally {
      session.close();
    }
  });
});

const providerSeamIt = isolatedProviderSeamIt("src/__tests__/kp-narration-constraint-wiring.test.ts");

describe("GameSession KP narration constraint wiring", () => {
  providerSeamIt("uses the current ordinary source scene for an opening without exposing hidden notes", async () => {
    const session = makeNarrationCaptureSession(`kp-wiring-opening-${Math.random()}`) as any;
    try {
    await session.act(LOAD_BARN);
    const { opening, openingRequests } = await captureKpOpening(session, "本地确定性开场");

    expect(opening).toBe("本地确定性开场");
    expect(openingRequests).toHaveLength(1);
    const prompt = requestText(openingRequests[0]!);
    expect(prompt).toContain("篮球场");
    expect(prompt).toContain("院子一旁的拖车房");
    expect(prompt).toContain("拍打皮球");
    expect(prompt).not.toContain("黑袋子中的手枪");
    expect(prompt).not.toContain("终局的那一幕");
    } finally {
      session.close();
    }
  });

  providerSeamIt("sends free text through the real session-owned KP request boundary", async () => {
    const session = makeNarrationCaptureSession(`kp-wiring-capture-${Math.random()}`) as any;
    try {
    await session.act(LOAD_BARN);
    const input = "我对着空荡的走廊轻声哼唱一段从未听过的曲子";
    const { response, narrationRequests } = await captureKpNarration(session, input, ["本地确定性叙事"]);

    expect(narrationRequests).toHaveLength(1);
    const prompt = requestText(narrationRequests[0]!);
    expect(prompt).toContain("篮球场");
    expect(prompt).toContain("院子一旁的拖车房");
    expect(prompt).not.toContain("拍打皮球");
    const finalUserMessage = narrationRequests[0]?.messages?.at(-1)?.content;
    expect(typeof finalUserMessage).toBe("string");
    expect(finalUserMessage).toContain(`玩家行动: ${input}`);
    expect(response.narrative).toBe("本地确定性叙事");

    const isolated = makeNarrationCaptureSession(`kp-wiring-isolated-${Math.random()}`) as any;
    try {
      const isolatedCapture = await captureKpNarration(isolated, input, ["隔离会话叙事"]);
      expect(isolatedCapture.narrationRequests).toHaveLength(1);
      const isolatedPrompt = requestText(isolatedCapture.narrationRequests[0]!);
      expect(isolatedPrompt).not.toContain("篮球场");
      expect(isolatedPrompt).not.toContain("院子一旁的拖车房");
    } finally {
      isolated.close();
    }
    } finally {
      session.close();
    }
  });

  providerSeamIt("uses current-scene undiscovered clues to reject a named false denial and regenerate", async () => {
    const session = makeNarrationCaptureSession(`kp-wiring-capture-scene-${Math.random()}`) as any;
    try {
    await session.act(LOAD_BARN);
    session.movePlayerToScene(CONTROL_ROOM);
    const currentKeys: string[] = session.currentUndiscoveredClueKeys();
    expect(currentKeys.some((key) => key.includes("冰箱"))).toBe(true);

    const { response, narrationRequests } = await captureKpNarration(session, "翻找这里", [
      "冰箱与储物柜空空如也，什么都没有。",
      "你仔细翻找，但还需要进一步检查才能看清里面有什么。",
    ]);

    expect(narrationRequests).toHaveLength(2);
    expect(response.narrative).toBe("你仔细翻找，但还需要进一步检查才能看清里面有什么。");
    const firstPrompt = requestText(narrationRequests[0]!);
    expect(firstPrompt).toContain("3个显示器");
    expect(firstPrompt).not.toContain("篮球场");
    expect(firstPrompt).not.toContain("拍打皮球");
    const correctivePrompt = narrationRequests[1]?.messages?.at(-1)?.content;
    expect(typeof correctivePrompt).toBe("string");
    expect(correctivePrompt).toContain("空的/没有/已经搜过");
    } finally {
      session.close();
    }
  });
});
