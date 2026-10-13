import { describe, expect, test } from "bun:test";
import { applyLlmExpanded } from "../llm/generate-llm-expanded";
import { generateNpcReply, type SceneContext } from "../llm/npc-dialogue-prompts";
import type { ModuleNPC } from "../module/types";

const SCENE: SceneContext = {
  sceneName: "测试场景",
  sceneDescription: "没有额外事实的测试场景。",
  presentNpcs: [],
  knownClues: [],
  recentEvents: [],
};

function npc(overrides: Partial<ModuleNPC>): ModuleNPC {
  return {
    id: "source-aware-probe",
    name: "阿棠",
    role: "路人",
    description: "测试 NPC",
    personality: { traits: ["平静"], speech: "普通", attitude: "中立" },
    knowledge: ["北墙有一道蓝色粉笔记号", "门锁上留着新鲜的划痕", "院子里的脚印通向河边"],
    secrets: [],
    sceneId: "probe",
    ...overrides,
  };
}

function expand(overrides: Partial<ModuleNPC>): ModuleNPC {
  const value = npc(overrides);
  applyLlmExpanded(value);
  return value;
}

describe("source-aware llmExpanded fallback", () => {
  test("child framing preserves every supplied fact without inventing an adult or mother as its source", () => {
    const child = expand({
      personality: { traits: ["天真"], speech: "童言", attitude: "中立" },
    });
    const reveals = child.llmExpanded!.knowledgeReveals;

    expect(reveals).toHaveLength(child.knowledge.length);
    child.knowledge.forEach((fact, index) => expect(reveals[index]).toContain(fact));
    expect(reveals.join("\n")).not.toMatch(/听大人说|妈妈是这么讲|大人|妈妈/);
  });

  test("formal framing preserves every supplied fact without inventing files or procedures", () => {
    const formal = expand({
      personality: { traits: ["正式"], speech: "公事公办", attitude: "中立" },
    });
    const reveals = formal.llmExpanded!.knowledgeReveals;

    expect(reveals).toHaveLength(formal.knowledge.length);
    formal.knowledge.forEach((fact, index) => expect(reveals[index]).toContain(fact));
    expect(reveals.join("\n")).not.toMatch(/案卷|记录在案|按流程/);
    expect(reveals.slice(0, -1).join("\n")).not.toContain("我能说的就这些");
    expect(reveals.at(-1)).toContain("我能说的就这些");
  });

  test("generic first encounter neither self-labels nor assumes an existing investigation", () => {
    const generic = expand({});
    const first = generic.llmExpanded!.firstEncounter;

    expect(first).not.toContain("我就是阿棠");
    expect(first).not.toContain("听说你们在调查");
    expect(first).toContain("有什么事吗");
  });

  test("child revisit stays childlike without inventing a ball, a brother, or a family search", () => {
    const child = expand({
      personality: { traits: ["天真"], speech: "童言", attitude: "中立" },
      knowledge: ["窗沿上有一枚蓝色的扣子"],
    });
    const revisit = child.llmExpanded!.revisitEncounter!;

    expect(revisit).not.toMatch(/皮球|哥哥|找到/);
    expect(revisit).toContain("又是你们呀");
    expect(revisit).toContain("有什么想问的");
  });

  test("runtime generateNpcReply fallback returns the selected full source fact rather than clipping it", async () => {
    const source = "门锁上留着新鲜的划痕，边缘还有一道很长的裂纹";
    const runtimeNpc = expand({ knowledge: ["北墙有一道蓝色粉笔记号", source, "院子里的脚印通向河边"] });

    const reply = await generateNpcReply(runtimeNpc, "门锁怎么样？", SCENE, undefined, new Set(), 1);

    expect(reply).toContain(source);
    expect(reply).not.toContain("来源测试不应泄露");
  });
});
