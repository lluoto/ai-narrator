/**
 * NPC LLM预生成对话自动管线
 * ==========================
 *
 * 职责：为 ModuleData 中所有带 knowledge[] 的 NPC 自动生成 llmExpanded。
 * 使得模块读取后，NPC 对话内容立即可用，无需运行时模板拼凑。
 *
 * 工作模式（优先级）：
 *   1. 已有 llmExpanded → 跳过（尊重手动编写的黄金标准）
 *   2. LLMClient API 可用 → 通过 LLM 生成高质量对话
 *   3. 无 API → 降级到模板生成（基于 NPC personality.traits/speech/role 组装）
 *
 * 用法：
 *   import { applyLlmExpanded } from "./llm/generate-llm-expanded";
 *   applyLlmExpanded(moduleData);
 */

import type { ModuleNPC } from "../module/types";
import type { LLMClient } from "./client";
import { extractJson } from "./json";
import { checkDialogueText } from "../world/world-constraint";
import { MYTHOS_CREATURES } from "../rules/mythos-expansion";
import { log } from "../log";

/** 模板生成的 llmExpanded 标记（区别于手写黄金标准，允许被 LLM 结果覆盖） */
const templateGenerated = new WeakSet<object>();

// ============================================================
// 降级模板 — 利用 NPC 人格特征组装自然对话
// ============================================================

/** 从 NPC 人格标签判断语气特征 */
function analyseNpc(npc: ModuleNPC): {
  isChild: boolean;
  isAnxious: boolean;
  isFormal: boolean;
  isWarm: boolean;
  isHostile: boolean;
  isRough: boolean;
  isSilent: boolean;
} {
  const traits = npc.personality.traits.map(t => t.toLowerCase());
  const speech = npc.personality.speech.toLowerCase();
  const attitude = npc.personality.attitude.toLowerCase();

  return {
    isChild: traits.some(t => /天真|幼|孩|child|naive/.test(t)) || /童言|幼/.test(speech),
    isAnxious: traits.some(t => /焦虑|不安|anxious|紧张/.test(t)) || /焦虑|急切|颤抖/.test(speech) || /焦虑/.test(attitude),
    isFormal: traits.some(t => /正式|公事|formal|official/.test(t)) || /公事|官方/.test(speech) || /冷漠|neutral/.test(attitude),
    isWarm: /友好|热心|合作|friendly|warm|cooperative/.test(attitude) || traits.some(t => /热心|友好/.test(t)),
    isHostile: /敌意|警惕|hostile|wary/.test(attitude) || traits.some(t => /敌意|警惕/.test(t)),
    isRough: traits.some(t => /粗鲁|粗|rough|暴躁/.test(t)) || /粗声|不耐烦/.test(speech),
    isSilent: /昏迷|瘫痪|无法|沉默|unconscious|paralyzed/.test(speech) || /无法.*交流/.test(speech),
  };
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 根据 NPC 特征选择第一句语调桥 */
function pickToneBridge(npc: ModuleNPC): string {
  // 早年这里还手工提了一份 traits（小写化），后来判断全交给 analyseNpc 了，
  // 那一份就没人读了 —— 删掉免得看着像还有一条并行的判断路径。
  // speech 仍在用（下面按原文关键词兜底）。
  const speech = npc.personality.speech;
  const a = analyseNpc(npc);

  if (a.isSilent) return "";
  if (a.isChild) return pick(["奶声奶气地说：", "歪着头天真地说：", "眨巴着眼睛说："]);
  if (a.isAnxious) return pick(["声音发颤地说：", "急切地开口道：", "焦虑不安地说："]);
  if (a.isFormal) return pick(["面无表情地说：", "用公事公办的口吻说：", "语气平淡地说："]);
  if (a.isWarm) return pick(["温和地笑了笑说：", "友善地开口道：", "热情地说："]);
  if (a.isHostile) return pick(["警惕地打量着你们说：", "冷冷地说：", "语气不善地说："]);
  if (a.isRough) return pick(["粗声粗气地说：", "叼着烟含糊地说：", "不耐烦地咂了咂嘴说："]);
  if (/温和|温柔|gentle/.test(speech)) return pick(["温和地说：", "语气轻柔地说："]);
  return pick(["开口说道：", "点了点头说：", "看向你们说："]);
}

/**
 * 说话时的**神态**（不带标点，由调用方决定怎么接）。
 *
 * ⚠ 这个函数返工过，原先叫 `pickImpression`，返回的是带逗号的**句首前缀**，
 * 拼出来是 `${神态}${名字}${语调桥}`：
 *
 *     眉头紧锁，菲碧·特里坎声音发颤地说：
 *     表情严肃，警员语气平淡地说：
 *
 * 一个没有主语的神态词起头，读起来是**剧本的舞台指示**，不是小说叙述。
 * 中文自然的写法是人在前、神态在后：「菲碧·特里坎眉头紧锁，声音发颤地说：」。
 *
 * 另一条更糟：`isChild` 那支原先返回的是 `${年龄}孩子` —— 一个**名词标签**，
 * 拼出来是「孩子米尔·特里坎眨巴着眼睛说：」，等于把角色分类写进了正文。
 * 现在直接返回空：孩子这件事由语调桥（「眨巴着眼睛说」「奶声奶气地说」）
 * 和出场描写各自交代，不需要在说话引导里贴个标签。
 */
function pickDemeanor(npc: ModuleNPC): string {
  const speech = npc.personality.speech;
  const a = analyseNpc(npc);

  if (a.isSilent) return "";
  if (a.isChild) return ""; // 童稚由语调桥表达，不贴「孩子」这个标签
  if (a.isAnxious) return pick(["神色焦虑", "面带忧色", "眉头紧锁"]);
  if (a.isFormal) return pick(["表情严肃", "态度公事公办"]);
  if (a.isWarm) return pick(["面带微笑", "态度友善"]);
  if (a.isHostile) return pick(["神情戒备", "面色不善"]);
  if (a.isRough) return pick(["看起来不太好惹"]);
  if (/温和|温柔|gentle/.test(speech)) return pick(["态度温和"]);
  return "";
}

/** 生成首次见面对话 */
/**
 * 自报家门时怎么称呼自己。
 *
 * 有些 NPC 只有身份没有姓名 —— 模组里那名警察的 name 和 role 都是"警员"。
 * 无条件拼成 `${role}${name}` 就得到「你们好。我是警员警员。请说明来意。」，
 * 实跑原文见 docs/evidence/run-2026-08-18T06-50-07.txt。
 *
 * 判据用 includes 而不是全等：还有"艾伦警长"这种名字本身已经含着身份的情况，
 * 再前置一个身份同样是重复。
 */
export function selfIntroduction(role: string | undefined, name: string): string {
  const r = (role ?? "").trim();
  if (!r || name.includes(r)) return name;
  return `${r}${name}`;
}

function templateFirstEncounter(npc: ModuleNPC): string {
  const a = analyseNpc(npc);
  if (a.isSilent) return "";

  const demeanor = pickDemeanor(npc);
  const bridge = pickToneBridge(npc);
  const name = npc.name.replace(/[（(].*[）)]$/, "").trim();
  const knowledge = npc.knowledge;

  let line = "";
  if (a.isChild) {
    line = `你们……你们是来找${knowledge.length > 0 ? "人" : "我"}的吗？`;
  } else if (a.isAnxious) {
    // 焦虑者：承接调查员自报家门后的回应，案情细节留给后续 knowledgeReveals 自然说出
    line = knowledge.length > 0
      ? `你们总算来了……我一直盼着有人能来帮帮我。`
      : `你们总算来了……我等你们好久了。`;
  } else if (a.isFormal) {
    line = `你们好。我是${selfIntroduction(npc.role, name)}。请说明来意。`;
  } else if (a.isHostile) {
    line = `你们是什么人？来这里有什么事？`;
  } else if (a.isWarm) {
    line = `欢迎！快请进。有什么需要我帮忙的，尽管说。`;
  } else {
    // 初见时没有调查进度或自报身份的来源，不能替 NPC 猜测两者。
    line = `你好。有什么事吗？`;
  }

  // 人在前、神态在后 —— 不要用无主语的神态词起头，那是舞台指示不是叙述。
  // 神态与语调桥同源（都从 traits 抽），会撞成同义反复：
  //   「警员**态度公事公办**，**用公事公办的口吻**说：」
  // 撞了就只留语调桥 —— 它挂在「说」上，信息量更大。
  const kept = overlaps(demeanor, bridge) ? "" : demeanor;
  return `${name}${kept ? `${kept}，` : ""}${bridge}${line}`;
}

/**
 * 两段短语是不是在说同一件事。
 *
 * 判据够用就好：**共有一个 2 字以上的词**就算撞。
 * 神态与语调桥都是短语（「态度公事公办」/「用公事公办的口吻说：」），
 * 共有「公事」「公办」这种就足以说明重复了。
 */
export function overlaps(a: string, b: string): boolean {
  if (!a || !b) return false;
  for (let i = 0; i + 2 <= a.length; i++) {
    if (b.includes(a.slice(i, i + 2))) return true;
  }
  return false;
}

/** 生成线索揭示文本（把 NPC.knowledge 转为自然的引用形式） */
/**
 * 降级为什么发生要说出来。
 *
 * 三条降级路径原先都是静默 return null，结果是模组的速记笔记被原样念出来
 * （"镇上最近有多起失踪案。"），而看日志的人完全不知道这里曾经尝试过 LLM 并失败。
 * 实跑里整局只有警员这一个 NPC 这样，别人都正常 —— 没有这条日志就无从查起。
 */
function warnFallback(npc: ModuleNPC, reason: string): void {
  console.warn(`[llm-expanded] ${npc.id}（${npc.name}）降级为模板：${reason}`);
}

/**
 * 无 LLM 时的知识台词。
 *
 * 模组里的 knowledge 是速记笔记，不是台词："镇上最近有多起失踪案"。
 * 原先只补一个句号就当台词用，念出来是新闻标题不是人说话。模板没法真的改写中文，
 * 但不能为速记补造信息来源（例如儿童并不必然是听父母转述，正式角色
 * 也未必看过案卷）。这里只保留原有事实与说话者当下可表达的收尾语。
 */
function templateKnowledgeReveals(npc: ModuleNPC): string[] {
  const a = analyseNpc(npc);

  // ⚠ 收尾语（「我知道的就这些了」）**只能挂在最后一条**。
  //
  // 原先 frame() 不看位置，给每一条都套同一个尾巴，于是焦虑型 NPC
  // 每次开口都以「……我知道的就这些了」收场：
  //   「加比比较叛逆，喜欢出去玩，十五岁就搬到外面拖车住了……我知道的就这些了。」
  //   「我已经半个多月没有他的消息了……我知道的就这些了。」
  // 两个毛病叠在一起：读起来复读机；而且**语义是错的** ——
  // 第一条就说「就这些了」，可她明明还知道别的，说完还会继续说。
  const closing = (body: string): string => {
    if (a.isChild) return `${body}。我知道的就这么多啦。`;
    if (a.isAnxious) return `${body}……我知道的就这些了。`;
    if (a.isFormal) return `${body}。我能说的就这些。`;
    if (a.isHostile) return `${body}。就这些，别再问了。`;
    if (a.isWarm) return `${body}。我能想起来的就这么多。`;
    return `${body}。`;
  };
  const total = npc.knowledge.length;
  return npc.knowledge.map((k, i) => {
    // 句子已自带标点时不再追加"。"，避免"。。"双句号；去掉尾部残句标点后补全
    const trimmed = k.replace(/[。！？…]+$/, "");
    if (i === total - 1) return closing(trimmed);
    // 中间条目不能补写目击/转述关系、文书或群众反应——这些都不在 knowledge 里。
    return `${trimmed}。`;
  });
}

/** 生成再次返回对话 */
function templateRevisitEncounter(npc: ModuleNPC): string {
  const a = analyseNpc(npc);
  if (a.isSilent) return "";

  const bridge = pickToneBridge(npc);
  const name = npc.name.replace(/[（(].*[）)]$/, "").trim();

  if (a.isChild) {
    return `${name}歪着头天真地说：\n……又是你们呀。有什么想问的？`;
  }
  if (a.isAnxious) {
    return `${name}焦虑不安地搓着手说：\n你们回来了！怎么样？有消息吗？`;
  }
  if (a.isFormal) {
    return `${name}面无表情地说：\n又是你们。还有什么需要协助的吗？`;
  }
  if (a.isWarm) {
    return `${name}温和地说：\n你们回来了！快请坐。`;
  }
  if (a.isHostile) {
    return `${name}警惕地说：\n你们怎么又来了？`;
  }
  return `${name}${bridge}\n你们回来了。还有什么要问的吗？`;
}

// ============================================================
// API 生成路径（LLMClient 可用时调用，失败降级到模板）
// ============================================================

/** LLM 生成 llmExpanded 的 SYSTEM_PROMPT */
const SYSTEM_PROMPT = `你是《克苏鲁的呼唤 7e》模组剧本的 NPC 对话设计师。为给定 NPC 生成自然的中文对话数据，输出严格 JSON（不要 markdown 代码块）。

要求：
- firstEncounter: 调查员第一次见到 NPC 时，NPC 的开场白，需符合人物性格与处境；**1-3 句话，不超过 80 字**
- **默认直接开口说话**：不要把括号里的神态描写当固定开头。真人不会先摆一个表情再说话，"（面带忧虑）我儿子失踪了"读起来是剧本提示而不是人话。神态确有必要时，穿插在句中或句末（如"我不知道……（声音低下去）她已经三天没回来了"），或改用叙述句自然带出
- **NPC 已被告知来意**：生成 firstEncounter 时，假设调查员敲门后已经自报家门（表明身份与来意），NPC 的回应是承接这个前提的自然反应——不要写"你们是来干什么的？"这类再次询问来意的句子（除非 NPC 性格警惕/敌意）
- **不要写进屋/落座的过渡动作**（让进屋里、示意坐下、关门等场景过渡由引擎在私宅场景统一处理），firstEncounter 只写台词与神态，避免与引擎插入的过渡重复
- **不要跳进案情正题**：firstEncounter 只做"迎接/寒暄/表露情绪"，具体案情（孩子失踪、凶案等）留给 knowledgeReveals 由 NPC 自然说出，不要在开场白里一口气倒出全部案情
- knowledgeReveals: 数组，每条对应一条 NPC.knowledge 素材。**用叙述性交代自然带出信息**：优先用转述口吻（"她断断续续地告诉你们……"）或直接开口说；神态只在必要时穿插句中（如"加比那孩子……（声音发抖）十五岁就搬出去住了"），**不要用括号描写起头**；把素材信息揉进叙述里；**不要逐条直述成"念设定"的台词**（"加比比较叛逆，喜欢出去玩，十五岁就搬出去了"这类干巴巴复述禁止）。每条 1-2 句话，不超过 60 字
- **动作括号只允许情绪/神态/语气/视线类**（如（她垂下眼帘）、（声音发颤）、（目光躲闪））；**禁止依赖场景道具的肢体动作**（从抽屉/柜子/口袋取物、坐下、绞桌布、翻文件、倒茶、递东西、拍桌子）——预生成时无法预知调查员所处阶段（可能在门口、路上、屋内），此类动作会造成叙述穿越
- revisitEncounter: 调查员再次到访时 NPC 的回应（可省略，缺省用 firstEncounter）；**1-2 句话，不超过 50 字**
- 全部用简体中文，符合 1920 年代风格；**台词要简短克制，像真人交谈，不要长篇大论**
- **情绪优先于职业身份**：NPC 当前处境中「情感状态」（如对失踪亲人的焦虑、悲伤、恐惧、慌乱）必须主导台词；职业身份（银行职员/警员等）只是背景装点，绝不能把情绪化的人物演成冷静客套、公事公办的谈判对象。例如焦虑的母亲开口应该是急切、坐立难安、恳求式的，而不是"我的时间很宝贵"这类职场口吻
- **禁止职业事务台词**：台词中不得提及工作安排/职业事务（如"我只有十分钟，之后还要去处理账目""还有会议要开""得回去上班"）——深陷情绪处境的人不会在求助交谈时谈这些
- **禁止编造其他 NPC 的即时行为**：firstEncounter 不得提及同场景其他 NPC 正在做/刚做过的事（如"米尔已经带路""刚才XX说的"）——其他 NPC 是否在场、做了什么，只以开场氛围与场景描述为准，不得编造超出其范围的互动

JSON 结构：
{"firstEncounter": string, "knowledgeReveals": string[], "revisitEncounter"?: string}`;

/** 组装单条 NPC 的 LLM prompt */
function buildApiPrompt(npc: ModuleNPC, scenes?: Array<{ id: string; name: string; description: string; openingAtmosphere?: string }>): string {
  const lines: string[] = [];
  lines.push(`NPC 名: ${npc.name}`);
  lines.push(`身份/角色: ${npc.role}`);
  lines.push(`性格标签: ${(npc.personality.traits ?? []).join("、")}`);
  lines.push(`说话风格: ${npc.personality.speech}`);
  lines.push(`态度: ${npc.personality.attitude}`);
  // 神话生物外观注入：NPC 是神话生物时注入设定外观，防止 LLM 凭场景氛围/流行印象自由发挥
  const creature = MYTHOS_CREATURES.find(c =>
    npc.id.toLowerCase().includes(c.id.toLowerCase()) || npc.name.includes(c.name)
  );
  if (creature) {
    lines.push(`外貌设定(必须严格遵守，禁止写成机械/金属): ${creature.description}`);
  }
  // 场景原文注入：NPC 所在场景的名称与描述，台词须与场景一致，禁止凭想象改写
  const homeScene = scenes?.find(s => s.id === npc.sceneId);
  if (homeScene) {
    lines.push(`所在场景: ${homeScene.name}`);
    lines.push(`场景描述(原文): ${homeScene.description}`);
    // 开场氛围注入：NPC 首见时的场景状态（如"孩子在院里拍球，看到你们后跑回屋内"）。
    // firstEncounter 的动作/神态必须与此一致，禁止编造与开场氛围矛盾的状态。
    if (homeScene.openingAtmosphere) {
      lines.push(`开场氛围(原文): ${homeScene.openingAtmosphere}`);
      lines.push(`（firstEncounter 须承接开场氛围：氛围里已发生的事不要重复演一遍，氛围里 NPC 已进屋就不要写她在屋外玩耍）`);
      lines.push(`（其他 NPC 状态（硬性）：开场氛围中出现的其他人物与调查员没有任何交谈——他们看到调查员后跑回屋内/继续做事即可，没有说过话、没有带过路、没有介绍过任何人。firstEncounter 中一律不得提及他们的言语、行为或与调查员/本 NPC 的互动，只允许当前 NPC 说话）`);
    }
  }
  if (npc.secrets?.length) lines.push(`隐藏秘密: ${npc.secrets.join("；")}`);
  lines.push(`已知信息(knowledge):`);
  npc.knowledge.forEach((k, i) => lines.push(`  ${i + 1}. ${k}`));
  return lines.join("\n");
}

/**
 * 用 LLM 生成单条 NPC 的 llmExpanded。
 * 返回生成的扩展数据；LLM 失败/解析失败返回 null（由调用方降级到模板）。
 */
async function generateViaAPI(
  npc: ModuleNPC,
  client: LLMClient,
  scenes?: Array<{ id: string; name: string; description: string; openingAtmosphere?: string }>,
): Promise<NonNullable<ModuleNPC["llmExpanded"]> | null> {
  const prompt = buildApiPrompt(npc, scenes);
  let raw: string;
  try {
    raw = await client.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      { jsonMode: true, timeout: 120000 },
    );
  } catch (e) {
    // 这里原先是裸 catch。实跑遇到 401（令牌失效）时，异常在这一层就被吃掉，
    // 后面那三条 warnFallback 一条都跑不到 —— 结果是整局 NPC 都在念模组速记笔记，
    // 而日志里没有任何迹象说明 LLM 曾被调用且失败。降级本身可以接受，无声不行。
    warnFallback(npc, `LLM 调用失败: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  try {
    // ⚠ 同 llm/intent.ts 的教训：曾经是裸 JSON.parse(raw)，围栏一裹就抛异常。
    // 这里虽然被下面的 catch 接住不会崩，但"同类潜伏"——本次实跑没有触发，
    // 不代表以后不会（这个消费方目前默认不启用，见 applyLlmExpandedWithLLM
    // 的调用条件），一并改用 extractJson 是趁手就修，不是因为查到了新实例。
    const data = extractJson(raw) as any;
    if (!data || typeof data !== "object") {
      warnFallback(npc, "LLM 返回的内容里抠不出 JSON 对象");
      return null;
    }
    const firstEncounter = typeof data.firstEncounter === "string" ? data.firstEncounter : "";
    const knowledgeReveals = Array.isArray(data.knowledgeReveals)
      ? data.knowledgeReveals.filter((k: unknown): k is string => typeof k === "string")
      : [];
    if (!firstEncounter || knowledgeReveals.length === 0) {
      warnFallback(npc, "LLM 返回的 JSON 结构不完整");
      return null;
    }

    // 世界模型约束：LLM 生成的对话文本不得含时代科技/ meta 词汇，命中 → 降级模板（模板无违规词）
    const textsToCheck = [firstEncounter, ...knowledgeReveals];
    if (typeof data.revisitEncounter === "string") textsToCheck.push(data.revisitEncounter);
    const offending = textsToCheck.find(t => checkDialogueText(t));
    if (offending) {
      warnFallback(npc, `世界观约束命中: ${offending.slice(0, 40)}`);
      return null;
    }

    const expanded: NonNullable<ModuleNPC["llmExpanded"]> = {
      firstEncounter,
      knowledgeReveals,
    };
    if (typeof data.revisitEncounter === "string" && data.revisitEncounter) {
      expanded.revisitEncounter = data.revisitEncounter;
    }
    return expanded;
  } catch (e) {
    warnFallback(npc, `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 尝试 LLM 生成；失败时回退模板。返回 true = 使用了 LLM 结果。 */
async function applyLlmExpandedWithLLM(
  npc: ModuleNPC,
  client: LLMClient,
  scenes?: Array<{ id: string; name: string; description: string; openingAtmosphere?: string }>,
): Promise<boolean> {
  // 手写黄金标准 → 绝不覆盖
  if (npc.llmExpanded && !templateGenerated.has(npc.llmExpanded)) return false;
  // 没有 knowledge → 无需生成
  if (!npc.knowledge || npc.knowledge.length === 0) return false;

  const apiResult = await generateViaAPI(npc, client, scenes);
  if (apiResult) {
    // ⚠ 原先是 `npc.llmExpanded = apiResult` —— **整个对象替换**。
    //   而 `revisitEncounter` 是**可选**的：LLM 没吐这个字段时 apiResult 里就没有，
    //   于是模板/模组原本准备好的那句回访台词被一并丢掉。
    //   下游 `revisitEncounter ?? firstEncounter` 就永远回落到首见 ——
    //   **玩家每次重进同一个场景，NPC 都把打招呼那句原样再说一遍**。
    //
    //   实跑一局抓到的：酒吧保镖那句「不想挨揍就老实点……」连说四次，
    //   一字不差。（模组里本来写着「你们回来了。还有什么要问的吗？」）
    //
    //   已经有的字段不该被一次不完整的生成抹掉。
    npc.llmExpanded = {
      ...npc.llmExpanded,
      ...apiResult,
      revisitEncounter: apiResult.revisitEncounter ?? npc.llmExpanded?.revisitEncounter,
    };
    return true;
  }
  // 降级模板（已有模板生成的 llmExpanded 时保持不变）
  if (!npc.llmExpanded) applyLlmExpanded(npc);
  return false;
}

/**
 * 批量尝试 LLM 生成（逐个失败降级模板）。
 * 并发执行：每个 NPC 的生成相互独立（各自解析/校验/降级），
 * 使用有界工作池（默认 4 并发）避免一次性打爆 API 限流。
 * 熔断语义保持：首个连接失败置 _defeated 后，尚未发出的调用立即抛错 → 各自降级模板。
 */
export async function applyAllLlmExpandedWithLLM(
  npcs: ModuleNPC[],
  client: LLMClient,
  scenes?: Array<{ id: string; name: string; description: string; openingAtmosphere?: string }>,
  concurrency: number = 4,
): Promise<void> {
  const queue = [...npcs];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const npc = queue.shift()!;
      try {
        await applyLlmExpandedWithLLM(npc, client, scenes);
      } catch (e) {
        // 单 NPC 生成失败（熔断/网络）→ 该 NPC 降级模板，不影响其他。
        // 不影响其他不等于不用说：熔断之后每个 NPC 都从这里过，全静默的话
        // 整局台词退化成模组笔记，而日志上一个字都不会提。
        warnFallback(npc, `生成中断: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });
  await Promise.all(workers);
}

// ============================================================
// 管线入口
// ============================================================

/**
 * 为 ModuleData 中所有带 knowledge[] 但无 llmExpanded 的 NPC
 * 自动生成 llmExpanded 对话数据。
 *
 * 已有 llmExpanded（手动编写的黄金标准）不会被覆盖。
 */
export function applyLlmExpanded(npc: ModuleNPC): void {
  // 已有 llmExpanded → 跳过（手写黄金标准或已生成）
  if (npc.llmExpanded) {
    // 读取路径时代校验：手写黄金标准同样可能含跨时代内容（历史数据/人工编写时引入）。
    // 命中 → 只预警不覆盖（手写标准是模块数据，不在此层改动）；
    // 运行时输出兜底由 npc-dialogue-prompts.ts templateReply / narrator / agent 层负责。
    const revealHits = (npc.llmExpanded.knowledgeReveals ?? [])
      .filter((r) => checkDialogueText(r))
      .length;
    const firstHit = npc.llmExpanded.firstEncounter && checkDialogueText(npc.llmExpanded.firstEncounter);
    const revisitHit = npc.llmExpanded.revisitEncounter && checkDialogueText(npc.llmExpanded.revisitEncounter);
    if (revealHits > 0 || firstHit || revisitHit) {
      log.warn("llm", 
        `  ⚠ 模组数据 ${npc.name} 的 llmExpanded 含跨时代内容 ` +
        `(reveals=${revealHits}, first=${!!firstHit}, revisit=${!!revisitHit}) — 建议人工修订`,
      );
    }
    return;
  }
  // 没有 knowledge → 无需生成
  if (!npc.knowledge || npc.knowledge.length === 0) return;

  const expanded = {
    firstEncounter: templateFirstEncounter(npc),
    knowledgeReveals: templateKnowledgeReveals(npc),
    revisitEncounter: templateRevisitEncounter(npc),
  };
  templateGenerated.add(expanded);
  npc.llmExpanded = expanded;
}

/**
 * 批量处理整个模块的所有 NPC
 */
export function applyAllLlmExpanded(npcs: ModuleNPC[]): void {
  for (const npc of npcs) {
    applyLlmExpanded(npc);
  }
}
