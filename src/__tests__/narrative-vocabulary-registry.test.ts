// 开发·真相链路 任务③：叙事用词必须能落到线索/场景上——可复用判据。
//
// 不是"叙事用词必须在原文里"（太严，创作层允许新词），是更窄的一条：
// **引擎叙事里出现的可交互对象称呼，玩家说出来必须能命中对应线索/
// 场景**。登记表见 src/investigation/narrative-vocabulary-registry.ts，
// 与 KNOWN_UNREACHABLE/FABRICATION_REGISTRY 同一种"显式登记 + 判据对
// 每一条断言"模式。
//
// ⚠ 覆盖面同登记表文件头的能力边界声明：只管登记过的词，不做散文分词——
// 判据本身也不假装能发现新的断链，只保证已登记的不会静默失效。
//
// bun test src/__tests__/narrative-vocabulary-registry.test.ts

import { describe, it, expect } from "bun:test";
import { GameSession } from "../api/game-session";
import { decideClueMatch, type ClueMatchCandidate } from "../investigation/clue-match";
import { resolveSceneTarget, type SceneRow } from "../play/scene-resolve";
import { NARRATIVE_VOCABULARY_REGISTRY } from "../investigation/narrative-vocabulary-registry";

async function loadedSession(id: string): Promise<GameSession> {
  process.env.LLM_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  const session = new GameSession(id, "cosmic-horror", {
    apiKey: "sk-placeholder", baseUrl: "http://localhost:9999", model: "mock", maxTokens: 1024, temperature: 0.7,
  }, "investigator", "调查员");
  await session.act("加载模组 普瑞米尔的谷仓");
  return session;
}

/** 从真实会话取一个场景里带 matchTexts 的线索候选集——与 GameSession.matchCurrentSceneClue 同一份筛选口径。 */
function clueCandidatesForScene(session: GameSession, sceneName: string): ClueMatchCandidate[] {
  const investigation = session.investigation;
  const ids = investigation.getSceneClues(sceneName);
  return ids
    .map((id) => ({ id, info: investigation.getClueMatchInfo(id) }))
    .filter((c): c is { id: string; info: Readonly<{ matchTexts: readonly string[]; displayName: string }> } => c.info !== null && c.info.matchTexts.length > 0)
    .map((c) => ({ id: c.id, texts: [...c.info.matchTexts] }));
}

describe("**主判据**：登记表每一条叙事用词都能命中它登记的目标", () => {
  for (const entry of NARRATIVE_VOCABULARY_REGISTRY) {
    const label = `「${entry.phrase}」→ ${entry.target.kind === "clue" ? entry.target.clueId : entry.target.sceneId}`;

    const target = entry.target;
    if (target.kind === "clue") {
      it(`${label}（decideClueMatch）`, async () => {
        const session = await loadedSession(`vocab-clue-${entry.phrase}-${Math.random()}`);
        const candidates = clueCandidatesForScene(session, target.sceneName);
        expect(candidates.length).toBeGreaterThan(0); // 场景本身要先真的有候选，不然判据在测空气
        const decision = decideClueMatch(entry.phrase, candidates);
        expect(decision).toEqual({ kind: "resolve", clueId: target.clueId });
      });
    } else {
      it(`${label}（resolveSceneTarget）`, async () => {
        const session = await loadedSession(`vocab-scene-${entry.phrase}-${Math.random()}`);
        const rows: SceneRow[] = session.world.listScenes().map((r: any) => ({ id: r.id, name: r.name }));
        const statics = session.exportOrdinarySessionSnapshot().state;
        const hit = resolveSceneTarget({
          said: entry.phrase,
          displayNames: statics.sceneDisplayNames,
          aliases: statics.sceneAliases,
          rows,
        });
        expect(hit.sceneId).toBe(target.sceneId);
        expect(hit.via).toBe("alias"); // 必须是登记的别名本身命中，不是碰巧被弱匹配（bigram/contains）捞中
      });
    }
  }
});

describe("登记表本身诚实——每条都必须给出理由，不能只列词不说为什么", () => {
  it("note 不为空", () => {
    for (const entry of NARRATIVE_VOCABULARY_REGISTRY) {
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  it("clue 目标的 clueId/sceneName 真实存在于 BARN_OF_PREMIER 数据里，不是登记了一个不存在的占位符", async () => {
    const session = await loadedSession(`vocab-sanity-${Math.random()}`);
    for (const entry of NARRATIVE_VOCABULARY_REGISTRY) {
      if (entry.target.kind === "clue") {
        expect(session.investigation.hasClueType(entry.target.clueId)).toBe(true);
      } else {
        expect(session.exportOrdinarySessionSnapshot().state.sceneDisplayNames[entry.target.sceneId]).toBeDefined();
      }
    }
  });
});

describe("覆盖面如实——至少覆盖任务①②要求的两类回归（brain_jars 别名 + 维修室 场景别名）", () => {
  it("培养缸/玻璃缸/一大一小 → clue_final_brain_jars 三条都在表里", () => {
    const phrases = NARRATIVE_VOCABULARY_REGISTRY
      .filter((e) => e.target.kind === "clue" && e.target.clueId === "clue_final_brain_jars")
      .map((e) => e.phrase);
    for (const p of ["培养缸", "玻璃缸", "一大一小"]) expect(phrases).toContain(p);
  });

  it("维修室 → 维修间 在表里（2c38d2c 那次修复的回归保护）", () => {
    const entry = NARRATIVE_VOCABULARY_REGISTRY.find((e) => e.phrase === "维修室");
    expect(entry).toBeDefined();
    expect(entry!.target).toEqual({ kind: "scene", sceneId: "维修间" });
  });
});
