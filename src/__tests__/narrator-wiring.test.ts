// 网页端(GameSession)战斗叙述接线。
//
// 起因：`llm/narrator.ts` 那套五档比例分级 + LLM 叙事，全仓只有 CLI
// （index.ts:55 的 setNarratorLLM）接了。网页端的 handleAttack / npcCounterAttack
// 原先只印「造成 N 点伤害」，没有任何画面——和 CLI 是两种体验。
//
// ⚠ 随机量钉死到 0：GameSession 的攻击判定、伤害骰、文案池选取全部走
//   Math.random()，不钉住的话「读到了正确的文案」只是撞对，红不了。
import { afterEach, describe, test, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { SCRATCH_TEMPLATES, CRIT_PREFIX } from "../llm/narrator-pools";
import { restoreSignedOrdinaryWorld } from "./helpers/ordinary-world-fixture";

const CFG = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 64, temperature: 0,
};

type Ent = { id: string; name: string; type: string; hp: number; maxHp: number; ac: number; status: string[]; position: string; scene_id?: string };
type S = {
  world: { getCurrentState: () => { scene: string; entities: Record<string, Ent> } };
  act: (input: string) => Promise<{ events: Array<{ content: string }> }>;
};

const sessions: GameSession[] = [];
afterEach(() => {
  while (sessions.length) sessions.pop()!.close();
});

function render(t: string, attacker: string, defender: string, weapon: string): string {
  return t.replace(/\{attacker\}/g, attacker).replace(/\{defender\}/g, defender).replace(/\{weapon\}/g, weapon);
}

async function arena(enemyHp = 200) {
  const source = new GameSession(`nw-${Math.random()}`, "cosmic-horror", CFG, "investigator", "甲");
  const target = new GameSession(source.id, "cosmic-horror", CFG);
  try {
    restoreSignedOrdinaryWorld(target, CFG, (world) => {
      const scene = world.getCurrentState().scene;
      world.upsertEntity({
        id: "m1", name: "食尸鬼", type: "monster", hp: enemyHp, maxHp: enemyHp,
        ac: 0, status: [], position: scene, scene_id: scene,
      });
    }, source);
  } finally {
    source.close();
  }
  sessions.push(target);
  return target as unknown as S;
}

describe("GameSession 攻击要有分级叙述，不能只印数字", () => {
  test("**错误行为的红线**：PC 攻击命中后，播报里要有 📖 叙述行", async () => {
    const s = await arena();
    const real = Math.random;
    Math.random = () => 0; // 必中 + 暴击 + 伤害骰最小值 + 池首条
    let r: { events: Array<{ content: string }> };
    try { r = await s.act("攻击 食尸鬼"); } finally { Math.random = real; }
    const narrLine = r.events.find((m) => m.content.startsWith("📖 "));
    expect(narrLine).toBeDefined();
  }, 20_000);

  test("**正确**：叙述内容确实来自分级文案池，不是随便拼的占位句", async () => {
    // effectiveRoll=1（必中）、skill=50 → isCrit（1<=2.5）、dmg=6+0=6，
    // 目标 maxHp=200 → 6/200=3% → scratch 档；随机数钉 0 → 池首条。
    const s = await arena(200);
    const real = Math.random;
    Math.random = () => 0;
    let r: { events: Array<{ content: string }> };
    try { r = await s.act("攻击 食尸鬼"); } finally { Math.random = real; }
    const narrLine = r.events.find((m) => m.content.startsWith("📖 "));
    const expected = "📖 " + CRIT_PREFIX[0] + render(SCRATCH_TEMPLATES[0]!, "你", "食尸鬼", "拳头");
    expect(narrLine?.content).toBe(expected);
  }, 20_000);

  test("**正确**：敌人还手命中玩家时，玩家也能读到叙述", async () => {
    const s = await arena();
    const real = Math.random;
    // Equal critical levels now favor dodge. Make the defender's dodge a
    // fumble so this still proves a real NPC counterhit emits narration.
    // The first two draws are the encounter's SAN check and zero SAN loss.
    const rolls = [0, 0, 0, 0, 0, 0, 0, 0.99, 0, 0, 0, 0.99, 0.99];
    let rollIndex = 0;
    Math.random = () => rolls[rollIndex++] ?? 0.99;
    let r: { events: Array<{ content: string }> };
    try { r = await s.act("攻击 食尸鬼"); } finally { Math.random = real; }
    // 玩家挨打的那条叙述以「📖 」开头、且不是玩家自己打怪的那条
    // （区分靠内容里出现「食尸鬼」作为 attacker 而不是 defender）
    const narrLines = r.events.filter((m) => m.content.startsWith("📖 "));
    expect(narrLines.length).toBeGreaterThanOrEqual(2); // 玩家的攻击 + 敌人的反击
  }, 20_000);
});
