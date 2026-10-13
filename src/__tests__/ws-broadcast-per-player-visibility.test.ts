// todo-25：WS live 广播按玩家过滤。
//
// 背景：ws-handler.ts 的 broadcastToSession 对同一 session 的所有连接发
// 同一份 msg，server.ts 用它推 action-result（含完整 narrative）——而
// 存储层（PlayerSession.push）早就按可见性过滤（含 discoverer_only），
// GET /history?pcId= 只返回该玩家可见的消息。同一份内容，存储层过滤、
// 推送层不过滤，两条路口径不一致，是信息泄漏。
//
// clue-visibility-and-per-player-history.test.ts 测的是【存储】那条路
// （GET /history 的等价物 getPlayerHistory），这份测的是【WS 推送】
// 那条路——此前完全没有判据覆盖，这正是它漏了这么久的原因。
//
// 修法：broadcastActionResult（server.ts）按连接分别算该发什么，player
// 连接只发 session.getPlayerHistory(pcId) 这一回合新增的部分——直接复用
// GET /history 已经在用、且被 5b 那份测试验证过的同一条存储层过滤路径，
// 不重新发明一套可见性判定。
//
// bun test src/__tests__/ws-broadcast-per-player-visibility.test.ts

import { describe, it, expect, afterEach } from "bun:test";
import { GameSession, type ActionResponse } from "../api/game-session";
import { runAction, broadcastActionResult } from "../api/server";
import { createWsClient, removeWsClient, listSessionPlayerIds } from "../api/ws-handler";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";
import type { ServerWebSocket } from "bun";
import type { WsConnectionData } from "../api/ws-handler";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 512, temperature: 0.7,
};
const TRANSIENT_RUNTIME = { careerEntryPersistence: "transient" } as const;

const TransientGameSession = new Proxy(GameSession, {
  construct(target, args, newTarget) {
    const forwarded = [...args];
    const runtime = forwarded[9] as Record<string, unknown> | undefined;
    forwarded[9] = { ...runtime, careerEntryPersistence: "transient" };
    return Reflect.construct(target, forwarded, newTarget);
  },
});

/** 一个只有 send() 的假连接，捕获发给它的每一条消息（不真的开 socket/端口）。 */
function fakeSocket() {
  const sent: any[] = [];
  const ws = { send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as ServerWebSocket<WsConnectionData>;
  return { ws, sent };
}

const liveClients: Array<Parameters<typeof removeWsClient>[0]> = [];
afterEach(() => {
  while (liveClients.length) removeWsClient(liveClients.pop()!);
});

async function twoPcArenaAt(sceneName: string) {
  const GameSession = TransientGameSession;
  const session: any = new GameSession(`ws-vis-${Math.random()}`, "cosmic-horror", CFG, undefined, "调查员", undefined, undefined, undefined, "preferred", TRANSIENT_RUNTIME);
  await session.act("创建角色 investigator 甲"); // p1
  await session.act("创建队友 乙 investigator"); // p2
  await session.act("加载模组 普瑞米尔的谷仓");
  session.movePlayerToScene(sceneName);
  return session as GameSession & Record<string, any>;
}

/** 复刻 server.ts POST /action 端点里"广播前拍快照"那一步，供测试直接调用。 */
function priorCounts(sessionId: string, session: any): Map<string, number> {
  const m = new Map<string, number>();
  for (const pid of listSessionPlayerIds(sessionId)) {
    if (session.session.get(pid)) m.set(pid, session.getPlayerHistory(pid).total);
  }
  return m;
}

describe("todo-25：action-result 按连接过滤，不再对 session 内所有连接发同一份 msg", () => {
  it("**正确**：p1 发现 discoverer_only 线索 → p1 的 WS 连接收到揭示内容，p2 的 WS 连接收不到", async () => {
    const s = await twoPcArenaAt("加比的拖车房");
    const sessionId = s.id ?? "sid-1";
    const p1 = fakeSocket();
    const p2 = fakeSocket();
    createWsClient(p1.ws, sessionId, "player", "p1");
    createWsClient(p2.ws, sessionId, "player", "p2");
    liveClients.push(p1.ws, p2.ws);

    const before = priorCounts(sessionId, s);
    const real = Math.random;
    Math.random = () => 0; // 逼检定成功
    let ar: any;
    try {
      const result = await runAction(s, { input: "侦查床底", pcId: "p1" });
      ar = result.body;
    } finally { Math.random = real; }
    broadcastActionResult(sessionId, s, before, ar);

    const p1Text = p1.sent.map((m) => m.data.narrative).join("\n");
    const p2Text = p2.sent.map((m) => m.data.narrative).join("\n");
    expect(p1Text).toMatch(/手枪/);
    expect(p2Text).not.toMatch(/手枪/);
    // p2 仍会收到这一回合里公开的部分（比如"甲侦查了床底"这类行动
    // 播报，谁都能看到有人做了什么），错误行为红线卡的是"揭示正文
    // 不能在这份内容里出现"，不是"这个连接这回合必须一条都收不到"——
    // 那与 5b 号称的 discoverer_only 语义（隐藏内容，不隐藏"有人在查"
    // 这件事本身）是同一个口径。
    expect(p1.sent.length).toBeGreaterThan(0);
  });

  it("**目标行为错误的对照**：普通（public）行动仍然广播给所有玩家连接——本轮改动不影响常见路径", async () => {
    const s = await twoPcArenaAt("普瑞米尔");
    const sessionId = s.id ?? "sid-2";
    const p1 = fakeSocket();
    const p2 = fakeSocket();
    createWsClient(p1.ws, sessionId, "player", "p1");
    createWsClient(p2.ws, sessionId, "player", "p2");
    liveClients.push(p1.ws, p2.ws);

    const before = priorCounts(sessionId, s);
    const result = await runAction(s, { input: "看看四周", pcId: "p1" });
    broadcastActionResult(sessionId, s, before, result.body as any);

    // public 消息两边都该收到——不是"只有行动者自己收到"
    expect(p1.sent.length).toBeGreaterThan(0);
    expect(p2.sent.length).toBeGreaterThan(0);
  });

  it("**KP 连接仍能看到全部**：discoverer_only 线索揭示对 KP 连接不过滤", async () => {
    const s = await twoPcArenaAt("加比的拖车房");
    const sessionId = s.id ?? "sid-3";
    const kp = fakeSocket();
    createWsClient(kp.ws, sessionId, "kp");
    liveClients.push(kp.ws);

    const before = priorCounts(sessionId, s);
    const real = Math.random;
    Math.random = () => 0;
    let ar: any;
    try {
      const result = await runAction(s, { input: "侦查床底", pcId: "p1" });
      ar = result.body;
    } finally { Math.random = real; }
    broadcastActionResult(sessionId, s, before, ar);

    const kpText = kp.sent.map((m) => m.data.narrative).join("\n");
    expect(kpText).toMatch(/手枪/);
  });

  it("**错误行为红线**：role=player 但没有 playerId（或 playerId 不是已知 pcId）的连接 fail-closed，不收到任何内容", async () => {
    const s = await twoPcArenaAt("加比的拖车房");
    const sessionId = s.id ?? "sid-4";
    const anon = fakeSocket();
    const bogus = fakeSocket();
    createWsClient(anon.ws, sessionId, "player"); // 没传 playerId
    createWsClient(bogus.ws, sessionId, "player", "p99"); // 未知 pcId
    liveClients.push(anon.ws, bogus.ws);

    const before = priorCounts(sessionId, s);
    const real = Math.random;
    Math.random = () => 0;
    let ar: any;
    try {
      const result = await runAction(s, { input: "侦查床底", pcId: "p1" });
      ar = result.body;
    } finally { Math.random = real; }
    broadcastActionResult(sessionId, s, before, ar);

    expect(anon.sent.length).toBe(0);
    expect(bogus.sent.length).toBe(0);
  });
});

// Ordinary terminality is not reducible to `dead`: an ordinary module
// departure is terminal while `dead === false`. Keep this at the existing
// per-connection broadcaster boundary, where the former hand-written view
// had dropped the new discriminant for every WebSocket-only client.
describe("ordinary action-result terminal projection", () => {
  async function depart(session: GameSession): Promise<ActionResponse> {
    await session.act("\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3");
    await session.act("\u6211\u4eec\u51b3\u5b9a\u79bb\u5f00\u8fd9\u91cc\uff0c\u7ed3\u675f\u8fd9\u6b21\u8c03\u67e5");
    return session.act("\u786e\u5b9a");
  }

  function lastActionData(socket: ReturnType<typeof fakeSocket>): Record<string, unknown> {
    const message = socket.sent.at(-1);
    expect(message?.event).toBe("action-result");
    return message.data as Record<string, unknown>;
  }

  it("delivers the exact non-death departure terminal to KP, observer, and the authorized player", async () => {
    const GameSession = TransientGameSession;
    const session = new GameSession("ws-terminal-departure", "cosmic-horror", CFG, "detective", "\u8c03\u67e5\u5458");
    const sessionId = session.id!;
    const kp = fakeSocket();
    const observer = fakeSocket();
    const player = fakeSocket();
    createWsClient(kp.ws, sessionId, "kp");
    createWsClient(observer.ws, sessionId, "observer");
    createWsClient(player.ws, sessionId, "player", "p1");
    liveClients.push(kp.ws, observer.ws, player.ws);

    try {
      const before = priorCounts(sessionId, session);
      const result = await depart(session);
      expect(result).toMatchObject({ dead: false, terminal: { kind: "module_departure" } });
      if (result.terminal?.kind !== "module_departure") throw new Error("expected ordinary departure terminal");
      broadcastActionResult(sessionId, session, before, result);

      for (const socket of [kp, observer, player]) {
        const data = lastActionData(socket);
        expect(data.dead).toBe(false);
        // Identity and display name are distinct durable fields; neither may
        // disappear behind the legacy `dead` compatibility flag.
        expect(data.terminal).toEqual(result.terminal);
        expect(data.terminal).toMatchObject({
          kind: "module_departure",
          endingId: result.terminal.endingId,
          endingName: result.terminal.endingName,
        });
      }
    } finally {
      session.close();
    }
  });

  it("delivers a real ordinary death terminal rather than treating all terminal states as departure", async () => {
    let session = new GameSession("ws-terminal-death", "cosmic-horror", CFG, "detective", "\u8c03\u67e5\u5458");
    const sessionId = session.id!;
    const kp = fakeSocket();
    const observer = fakeSocket();
    const player = fakeSocket();
    createWsClient(kp.ws, sessionId, "kp");
    createWsClient(observer.ws, sessionId, "observer");
    createWsClient(player.ws, sessionId, "player", "p1");
    liveClients.push(kp.ws, observer.ws, player.ws);
    const previousRandom = Math.random;

    try {
      const prepared = new GameSession(session.id, "cosmic-horror", CFG);
      try {
        restoreSignedOrdinaryWorld(prepared, CFG, (world) => {
          const scene = world.getCurrentState().scene;
          world.upsertEntity({
            id: "ws-terminal-death-monster", name: "ws terminal monster", type: "monster",
            hp: 200, maxHp: 200, ac: 0, status: [], position: scene, scene_id: scene,
          });
        }, session);
      } catch (error) {
        prepared.close();
        throw error;
      }
      session.close();
      session = prepared;
      expect(session.setPlayerHp("p1", 1)).toMatchObject({ ok: true });
      const rolls = [0, 0, 0.99, 0, 0, 0.99, 0, 0, 0, 0.99, 0.99];
      let index = 0;
      Math.random = () => rolls[index++] ?? 0.99;
      const before = priorCounts(sessionId, session);
      const death = await session.act("\u653b\u51fb ws terminal monster");
      expect(death).toMatchObject({ dead: true, terminal: { kind: "death" } });
      broadcastActionResult(sessionId, session, before, death);

      for (const socket of [kp, observer, player]) {
        const data = lastActionData(socket);
        expect(data.dead).toBe(true);
        expect(data.terminal).toEqual({ kind: "death" });
      }
    } finally {
      Math.random = previousRandom;
      session.close();
    }
  });

  it("sends explicit terminal:null for a live ordinary action, never a stale terminal from an earlier result", async () => {
    const session = new GameSession("ws-terminal-live", "cosmic-horror", CFG, "detective", "\u8c03\u67e5\u5458");
    const sessionId = session.id!;
    const player = fakeSocket();
    createWsClient(player.ws, sessionId, "player", "p1");
    liveClients.push(player.ws);

    try {
      const before = priorCounts(sessionId, session);
      const live = await session.act("observe");
      expect(live.terminal).toBeNull();
      broadcastActionResult(sessionId, session, before, live);
      const data = lastActionData(player);
      expect(Object.hasOwn(data, "terminal")).toBe(true);
      expect(data.terminal).toBeNull();
    } finally {
      session.close();
    }
  });

  it("does not guess terminal:null for a legacy ordinary response that never declared terminal", async () => {
    const session = new GameSession("ws-terminal-legacy", "cosmic-horror", CFG, "detective", "\u8c03\u67e5\u5458");
    const sessionId = session.id!;
    const player = fakeSocket();
    createWsClient(player.ws, sessionId, "player", "p1");
    liveClients.push(player.ws);

    try {
      const before = priorCounts(sessionId, session);
      const current = await session.act("observe");
      const { terminal: _removedTerminal, ...legacyResponse } = current;
      broadcastActionResult(sessionId, session, before, legacyResponse);
      const data = lastActionData(player);
      expect(Object.hasOwn(data, "terminal")).toBe(false);
    } finally {
      session.close();
    }
  });

  it("does not invent an ordinary terminal field for a real compiled action response", async () => {
    const session = new GameSession("ws-terminal-compiled", "cosmic-horror", CFG, "detective", "\u8c03\u67e5\u5458");
    const sessionId = session.id!;
    const kp = fakeSocket();
    createWsClient(kp.ws, sessionId, "kp");
    liveClients.push(kp.ws);
    try {
      const fixture = await compiledModuleHttpFixture("ws-terminal-compiled");
      expect(session.loadCompiledModule(fixture.resolved.artifact.payload as any, fixture.projection).status).toBe("loaded");
      const state = session.getState();
      const compiledResponse = {
        narrative: "compiled action",
        events: [],
        state,
        dead: false,
        // A forged ordinary discriminant must not cross the compiled boundary
        // merely because ActionResponse is shared by both session kinds.
        terminal: { kind: "module_departure" as const, endingId: "forged", endingName: "forged" },
      } as ActionResponse;
      broadcastActionResult(sessionId, session, new Map(), compiledResponse);
      const data = lastActionData(kp);
      expect(Object.hasOwn(data, "terminal")).toBe(false);
    } finally {
      session.close();
    }
  });
});
