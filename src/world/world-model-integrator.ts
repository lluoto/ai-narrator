// 世界模型 → 跑团集成层（v18 适配）
// 将 v18 的 383K 条目按小说/场景/行为/因果/D&D 规则注入游戏运行时
// 支持多小说路由和 D&D 5e / CoC 7e 双规则集

import type { WorldModelLoader, V18Entry } from "./world-model-loader";

// ============================================================
// 场景上下文
// ============================================================

/** 在场 NPC 人设卡 — 供 KP 上下文注入（防止 LLM 臆造年龄/性别/状态） */
export interface NPCPresentProfile {
  name: string;
  /** 年龄（模组权威值；缺失时以 background 文本为准） */
  age?: number;
  /** 性别（模组权威值；缺失时以 background 文本为准） */
  gender?: "male" | "female";
  /** 身份角色（如 "委托人"、"失踪者"） */
  role?: string;
  /** 当前场景状态（如 "在篮球场玩耍"、"昏迷不醒"） */
  currentState?: string;
  /** 背景（模组原文，权威事实） */
  background?: string;
  /** 对话提示（供 LLM 生成符合人设的言行） */
  dialogHints?: string[];
}

export interface SceneContext {
  sceneId: string;
  sceneName: string;
  /** 场景中的关键词（用于匹配世界模型） */
  keywords: string[];
  /** 在场 NPC 名 */
  presentNPCs: string[];
  /** 在场 NPC 人设卡（与 presentNPCs 对应，供 KP 注入权威元数据） */
  npcProfiles?: NPCPresentProfile[];
  /** 玩家已发现的线索 */
  discoveredClues: string[];
  /** 当前回合 */
  round: number;
  /** 可选：当前激活的小说上下文（如 "黎明之剑"） */
  activeNovel?: string;
  /** 可选：当前规则集（"dnd5e" | "cosmic-horror" | "grail"） */
  ruleset?: string;
  /** 可选：模组原文场景描写（来自场景表 description，权威事实层） */
  sceneDescription?: string;
  /** 可选：场景内可互动物品（item 实体名列表） */
  presentItems?: string[];
  /** 可选：游戏内当前时间标签（如 "第一天 · 下午"），由会话层注入 */
  gameTime?: string;
  /** 可选：当前时段环境修饰语（如 "午后时光，光线渐渐西斜。"） */
  periodAtmosphere?: string;
}

// ============================================================
// 世界模型注入结果
// ============================================================

interface WorldModelInjection {
  /** 当前场景的势力关系上下文 */
  factionContext: string;
  /** 当前场景中 NPC 可能触发的行为模式 */
  npcBehaviorHints: string[];
  /** 可触发的因果事件链 */
  availableEvents: Array<{
    cause: string;
    effect: string;
    mechanism: string;
    confidence: string;
  }>;
  /** 当前场景的资源/环境信息 */
  resourceContext: string;
  /** D&D 规则线索（game_rule/mechanic 条目） */
  dndRuleHints: string[];
  /** 当前小说上下文标识 */
  novelContext: string;
}

// ============================================================
// 公用字段提取（兼容 v15+v16 flat 字段 + v17 flat 字段）
// ============================================================

/**
 * 把 v18 条目字段压成文本。
 *
 * V18Entry 用 `[key: string]: unknown` 兜底，cause/effect/mechanism/
 * direction_confidence 都未显式声明，因此取值类型是 unknown。而且不能想当然当成
 * string——实测 20 万条数据：effect 有 2 条是对象、2 条是数组，mechanism 有 4 条是数组。
 * 直接拼接会把 "[object Object]" 或逗号串喂进注入给 KP 的世界模型上下文。
 */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("；");
  if (value && typeof value === "object") return Object.values(value).map(asText).filter(Boolean).join("；");
  return "";
}

/**
 * Prompt rendering accepts historical JSONL fields that are structurally less
 * strict than the TypeScript compatibility facade. Preserve their selection
 * data, but normalize every rendered field through asText at the boundary.
 */
function asPromptEntry(entry: V18Entry): V18Entry {
  const rendered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    rendered[key] = key === "properties" && value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).map(([property, propertyValue]) => [property, asText(propertyValue)]))
      : asText(value);
  }
  return rendered as V18Entry;
}

function getEntryName(e: V18Entry): string {
  return asText(e.name) || asText(e.trigger) || asText(e.cause) || asText(e.type) || "未知";
}

function getEntryDescription(e: V18Entry): string {
  return asText(e.description) || asText(e.response) || asText(e.effect) || asText(e.mechanism) || "";
}

function getEntryText(e: V18Entry): string {
  return `${getEntryName(e)} ${getEntryDescription(e)} ${e.quote_abridged || ""} ${e.mechanic || ""} ${e.dnd_mapping || ""}`.toLowerCase();
}

/** 提取势力关系文本（兼容 v15+v16 的 name/description 结构和 v13 的 a/b/relation 结构） */
function extractRelationText(e: V18Entry): string {
  e = asPromptEntry(e);
  if (e.name && e.description) {
    // v15+v16 风格: name="贵族与巫师的关系", description="..."
    const props = asText(e.properties);
    return `${e.name}: ${e.description.slice(0, 60)}${props ? ` (${props})` : ""}`;
  }
  // v13 风格 (a/b/relation) — v17 可能保留
  const a = (e as any).a || e.name || "未知";
  const b = (e as any).b || "未知";
  const relation = (e as any).relation || "未知关系";
  return `${a}与${b}: ${relation}`;
}

/** 提取行为模式文本 */
function extractBehaviorText(e: V18Entry): string {
  e = asPromptEntry(e);
  if (e.trigger && e.response) {
    // v17 风格
    return `当「${e.trigger}」→ 倾向于「${e.response}」`;
  }
  // v15+v16 风格: 从 name/description 提取
  return `${e.name || "该角色"}: ${e.description || "有特定行为模式"}`;
}

/** 提取因果文本 */
function extractCausalText(e: V18Entry): { cause: string; effect: string; mechanism: string; confidence: string } {
  const cause = asText(e.cause) || asText(e.name) || "未知原因";
  const effect = asText(e.effect) || asText(e.description) || "未知结果";
  const mechanism = (asText(e.mechanism) || asText(e.mechanic)).slice(0, 120);
  const confidence = asText(e.direction_confidence)
    || asText(e.causal_precheck?.direction_confidence)
    || "inferred";
  return { cause, effect, mechanism, confidence };
}

// ============================================================
// 集成器
// ============================================================

export class WorldModelIntegrator {
  private loader: WorldModelLoader;

  constructor(loader: WorldModelLoader) {
    this.loader = loader;
  }

  /**
   * 为当前场景生成世界模型注入上下文
   */
  buildInjection(ctx: SceneContext): WorldModelInjection {
    const novel = ctx.activeNovel;
    const keywords = ctx.keywords;

    // ── 层 0: 小说上下文 ──
    const novelCount = novel ? this.loader.getByNovel(novel).length : 0;
    const novelContext = novel
      ? `当前世界观: ${novel} (${novelCount} 条世界模型条目)`
      : `当前场景 (${this.loader.getNovelNames().length} 部可用小说)`;

    // ── 层 1: 势力关系 ──
    const relations = novel
      ? this.loader.getByNovelAndType(novel, "faction_relation")
      : this.loader.getFactionRelations();
    const relevantRelations = relations
      .filter((r: V18Entry) => {
        const text = getEntryText(r);
        return keywords.some((kw) => text.includes(kw.toLowerCase()));
      })
      .slice(0, 3);

    const factionContext = relevantRelations.length > 0
      ? relevantRelations.map((r: V18Entry) => extractRelationText(r)).join("; ")
      : "当前场景无特殊势力关系";

    // ── 层 2: NPC 行为模式 ──
    const behaviors = novel
      ? this.loader.getByNovelAndType(novel, "behavior")
      : this.loader.getBehaviors();
    const npcHints: string[] = [];

    for (const npcName of ctx.presentNPCs) {
      const relevantBehaviors = behaviors
        .filter((b: V18Entry) => {
          const text = getEntryText(b);
          return text.includes(npcName.toLowerCase()) ||
                 keywords.some((kw) => text.includes(kw.toLowerCase()));
        })
        .slice(0, 2);

      for (const b of relevantBehaviors) {
        npcHints.push(`${npcName}: ${extractBehaviorText(b)}`);
      }
    }

    // ── 层 3: 因果事件 ──
    const causals = novel
      ? this.loader.getByNovelAndType(novel, "causal")
      : this.loader.getByType("causal");
    const scoredCausals = causals
      .map((e: V18Entry) => {
        const text = getEntryText(e);
        const score = keywords.reduce((s, kw) => text.includes(kw.toLowerCase()) ? s + 10 : s, 0);
        return { entry: e, score };
      })
      .filter((s: any) => s.score > 0)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 3);

    const availableEvents = scoredCausals.map((s: any) => {
      const { cause, effect, mechanism, confidence } = extractCausalText(s.entry);
      return { cause, effect, mechanism, confidence };
    });

    // ── 层 4: 资源/环境 ──
    const resources = novel
      ? this.loader.getByNovelAndType(novel, "resource")
      : this.loader.getByType("resource");
    const relevantResources = resources
      .filter((r: V18Entry) => {
        const text = getEntryText(r);
        return keywords.some((kw) => text.includes(kw.toLowerCase()));
      })
      .slice(0, 2);

    const resourceContext = relevantResources.length > 0
      ? relevantResources.map((r: V18Entry) => {
          r = asPromptEntry(r);
          const name = r.name || "未知资源";
          const scarcity = (r as any).scarcity || r.properties?.accessibility || "未知";
          const drives = (r as any).drives || r.description?.slice(0, 60) || "";
          return `${name}(可访问性: ${scarcity}): ${drives}`;
        }).join("; ")
      : "当前场景无特殊资源信息";

    // ── 层 5: D&D 规则线索 ──
    const dndRules = novel
      ? this.loader.getDndRules(novel)
      : this.loader.getDndRules();
    const relevantDnd = keywords.length > 0
      ? dndRules.filter((r: V18Entry) => {
          const text = getEntryText(r);
          return keywords.some((kw) => text.includes(kw.toLowerCase()));
        }).slice(0, 3)
      : [];

    const dndRuleHints = relevantDnd.map((r: V18Entry) => {
      r = asPromptEntry(r);
      const name = r.name || "规则";
      const mechanic = r.mechanic ? ` (机制: ${r.mechanic.slice(0, 60)})` : "";
      const mapping = r.dnd_mapping ? ` [D&D: ${r.dnd_mapping}]` : "";
      return `${name}${mechanic}${mapping}`;
    });

    return {
      factionContext,
      npcBehaviorHints: npcHints,
      availableEvents,
      resourceContext,
      dndRuleHints,
      novelContext,
    };
  }

  /**
   * 生成注入 KP 叙事 prompt 的上下文文本
   */
  buildKPContext(ctx: SceneContext): string {
    const injection = this.buildInjection(ctx);

    const lines: string[] = [];
    lines.push("[世界模型上下文]");

    // ── 层 0: 当前时间（游戏内昼夜循环，权威事实层）──
    if (ctx.gameTime) {
      lines.push(`[当前时间] ${ctx.gameTime}${ctx.periodAtmosphere ? `（${ctx.periodAtmosphere}）` : ""}`);
    }

    // ── 层 -1: 模组原文场景描写（权威事实层，优先于世界模型推断）──
    if (ctx.sceneDescription && ctx.sceneDescription.trim()) {
      lines.push(`[模组场景描写] ${ctx.sceneDescription.trim()}`);
      // 事实边界约束（世界状态层）：场景描写是「静态事实清单」，禁止对物品状态推断其原因。
      // 例：被褥凌乱 ≠ 挣扎/搏斗；玻璃破损 ≠ 闯入；地面痕迹 ≠ 血迹——除非玩家调查/线索明确指向。
      lines.push(
        "[事实边界] 以上场景描写是静态事实（物品存在、状态如此），不代表其成因。禁止把静态状态（乱、脏、旧、破损、痕迹、未整理）脑补成事件因果（挣扎、搏斗、绑架、闯入、血迹、离奇事件），除非玩家明确调查或已有线索指向该结论。严格以原文列出的物品、状态和空间为闭世界；不得凭空添加原文没有的物品、声音、气味、天气、光线、时间或动作。推断留给玩家自己做。"
      );
    }

    if (ctx.presentNPCs && ctx.presentNPCs.length > 0) {
      if (ctx.npcProfiles && ctx.npcProfiles.length > 0) {
        // 有权威人设卡 → 输出带元数据 + 负面约束的人设表，防止 LLM 臆造年龄/性别/状态
        lines.push("[在场角色（权威人设，叙事必须遵守）]");
        for (const p of ctx.npcProfiles) {
          const meta: string[] = [];
          if (p.age !== undefined) meta.push(`${p.age}岁`);
          if (p.gender === "female") meta.push("女性");
          if (p.gender === "male") meta.push("男性");
          if (p.role) meta.push(p.role);
          const metaText = meta.length > 0 ? `（${meta.join(" · ")}）` : "";
          lines.push(`- ${p.name}${metaText}`);
          if (p.currentState) lines.push(`  当前状态: ${p.currentState}`);
          if (p.background) lines.push(`  背景: ${p.background}`);
          if (p.dialogHints && p.dialogHints.length > 0) {
            lines.push(`  言行提示: ${p.dialogHints.join("；")}`);
          }
          // 负面约束：根据权威元数据生成不可违背的硬性规则
          const hardRules: string[] = [];
          if (p.age !== undefined && p.age <= 7) {
            hardRules.push("未成年幼童：严禁描写为成年人或青少年，言行必须符合其幼童年龄的认知与词汇");
          } else if (p.age !== undefined && p.age < 18) {
            hardRules.push("未成年人：严禁出现成人化言行或超出其年龄的成熟表达");
          }
          if (p.gender === "female") hardRules.push("女性角色：严禁以男性称谓/动作描写，代名词必须使用她");
          if (p.gender === "male") hardRules.push("男性角色：代名词必须使用他");
          // 状态约束检测：currentState + background 联合（背景文本常含"瘫痪/昏迷/缸中脑"等权威状态词）
          const stateText = `${p.currentState ?? ""} ${p.background ?? ""}`;
          if (/昏迷|瘫痪|无意识|沉睡|不省人事|缸中脑|无法行动|被麻醉/.test(stateText)) {
            const stateWord = (stateText.match(/昏迷|瘫痪|无意识|沉睡|不省人事|缸中脑|无法行动|被麻醉/) ?? [""])[0];
            hardRules.push(`该角色当前处于「${p.currentState ?? stateWord}」状态：严禁让该角色主动行动、正常说话或做出超出该状态的言行`);
          }
          if (hardRules.length > 0) {
            lines.push(`  【禁止】${hardRules.join("；")}`);
          }
        }
        lines.push("仅上述 NPC 已确认在当前场景中；模组中存在但未列出的角色、仅在背景中提及的角色，以及失踪、被绑架、昏迷或位于其他场景的角色，均不得自行现身。叙事中必须至少让一位已列 NPC 以举止、神态或言语方式在场，且人设必须与上述权威信息严格一致，不得臆造与之冲突的外貌、年龄、性别或行为。");
      } else {
        lines.push(`[必须在叙事中呈现的在场 NPC] ${ctx.presentNPCs.join("、")}。以上 NPC 出现在当前场景，描写玩家所见时务必让其中至少一位以举止、神态或言语方式在场，不得只描写环境而不写 NPC。`);
      }
    } else {
      lines.push(`[在场角色] 当前场景没有已确认在场的 NPC。未列出的角色（包括仅在模组背景中提及、失踪、被绑架、昏迷或位于其他场景的角色）不得现身；本轮仅描写有原文依据的环境与玩家可观察事实。`);
    }

    if (ctx.presentItems && ctx.presentItems.length > 0) {
      lines.push(`场景物品: ${ctx.presentItems.join("、")}`);
    }

    // 小说上下文
    lines.push(injection.novelContext);

    if (injection.factionContext !== "当前场景无特殊势力关系") {
      lines.push(`势力关系: ${injection.factionContext}`);
    }

    if (injection.resourceContext !== "当前场景无特殊资源信息") {
      lines.push(`环境/资源: ${injection.resourceContext}`);
    }

    // 规则参考：仅当模组指定对应规则集时才引入（避免 D&D 规则污染 CoC 模组叙事）。
    // v18 无 CoC 规则库 → cosmic-horror 模组跳过规则参考，但保留常规世界模型信息（势力/行为/事件/资源）。
    if (ctx.ruleset === "dnd5e" && injection.dndRuleHints.length > 0) {
      lines.push("D&D 规则参考:");
      for (const hint of injection.dndRuleHints) {
        lines.push(`  - ${hint}`);
      }
    }

    if (injection.npcBehaviorHints.length > 0) {
      lines.push("NPC 行为倾向:");
      for (const hint of injection.npcBehaviorHints) {
        lines.push(`  - ${hint}`);
      }
    }

    if (injection.availableEvents.length > 0) {
      lines.push("可推进的事件方向:");
      for (const evt of injection.availableEvents) {
        lines.push(`  - ${evt.cause} → ${evt.effect} [${evt.confidence}]`);
      }
    }

    if (ctx.sceneDescription && ctx.sceneDescription.trim()) {
      lines.push("[叙事输出最终约束] 本场景必须严格受模组原文约束。只描写原文明确列出的物品、空间、状态，以及玩家已明确执行的动作结果；不得新增原文未列出的气味、声音、天气、光线、时间、人物、动作或因果。若信息不足，保持中性，不要补全。上述约束优先于世界模型参考与常识联想。");
    }

    return lines.join("\n");
  }

  /**
   * 为 NPC Agent 提供行为指导
   */
  getNPCGuidance(npcName: string, ctx: SceneContext): string {
    const novel = ctx.activeNovel;
    const behaviors = novel
      ? this.loader.getByNovelAndType(novel, "behavior")
      : this.loader.getBehaviors();

    const relevant = behaviors
      .filter((b: V18Entry) => {
        const text = getEntryText(b);
        return text.includes(npcName.toLowerCase()) ||
               ctx.keywords.some((kw) => text.includes(kw.toLowerCase()));
      })
      .slice(0, 3)
      .map(asPromptEntry);

    if (relevant.length === 0) return "";

    return "世界模型行为参考:\n" +
      relevant.map((b: V18Entry) => `  当「${b.trigger || b.name || "特定情况"}」→ 该角色倾向于「${b.response || b.description || "有特定行为"}」`).join("\n");
  }

  /**
   * 按规则集路由查询
   */
  getRuleHints(ruleset: string, ctx: SceneContext): string[] {
    const novel = ctx.activeNovel;
    if (ruleset === "dnd5e") {
      const rules = novel
        ? this.loader.getDndRules(novel)
        : this.loader.getDndRules();
      return rules
        .filter((r: V18Entry) => {
          const text = getEntryText(r);
          return ctx.keywords.some((kw) => text.includes(kw.toLowerCase()));
        })
        .slice(0, 5)
        .map((r: V18Entry) => {
          r = asPromptEntry(r);
          const mapping = r.dnd_mapping ? ` [${r.dnd_mapping}]` : "";
          const mechanic = r.mechanic ? `: ${r.mechanic.slice(0, 80)}` : "";
          return `${r.name || "规则"}${mechanic}${mapping}`;
        });
    }

    // CoC: 从 behavior/causal 条目提取源
    if (ruleset === "cosmic-horror") {
      const causals = novel
        ? this.loader.getByNovelAndType(novel, "causal")
        : this.loader.getByType("causal");
      return causals
        .filter((c: V18Entry) => {
          const text = getEntryText(c);
          return ctx.keywords.some((kw) => text.includes(kw.toLowerCase()));
        })
        .slice(0, 3)
        .map((c: V18Entry) => {
          const { cause, effect, mechanism } = extractCausalText(c);
          return `[事件] ${cause} → ${effect} (${mechanism.slice(0, 60)})`;
        });
    }

    return [];
  }
}
