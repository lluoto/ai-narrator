// KP Agent — 导演/Keeper
// 负责：场景描述、事件注入、节奏控制
//
// 设计原则：
//   KP 不扮演 NPC（那是 NPC Agent 的事）
//   KP 不判定规则（那是律书的事）
//   KP 只做三件事：描述环境、推进剧情、控制节奏

import type { LLMLike, Message as LLMMessage } from "../llm/client";
import type { KPDirective, TurnRecord, AgentMessage } from "./types";
import { fallbackSceneDescription } from "../llm/fallback";
import { checkNarrationText } from "../world/world-constraint";
import type { RulesetId } from "../rules/rules-engine";
import { log } from "../log";

/**
 * narrateOutcome 的可选约束上下文——开发·意图与约束补漏 任务3。
 * 不传时（CLI 侧 index.ts 的调用点，本轮没有改）checkNarrationText 拿不到
 * undiscoveredClueKeys，新约束天然不命中，行为与改动前一致。
 */
export interface NarrateConstraintOpts {
  sceneId?: string;
  ruleset?: RulesetId;
  /** 当前场景（当前 PC 视角）尚未发现的线索名字/唯一简称，见 world-constraint.ts */
  undiscoveredClueKeys?: string[];
}

/** The scene provider outcome is explicit so HTTP creation never infers health from fallback prose. */
export type SceneDescriptionResult = Readonly<
  | { status: "ready"; description: string }
  | { status: "fallback"; description: string }
>;

/** 约束拦截且重生成仍未通过时的安全兜底——不点名任何具体对象，只描述"事情发生了"。 */
const SAFE_NARRATION_FALLBACK = [
  "你采取了行动，但一时还看不出明确的结果——或许需要再仔细一点。",
  "事情发生了，只是眼下还说不清究竟意味着什么。",
  "你的动作引起了一些变化，具体是什么，得再观察观察。",
];
function pickSafeFallback(): string {
  return SAFE_NARRATION_FALLBACK[Math.floor(Math.random() * SAFE_NARRATION_FALLBACK.length)];
}

const KP_SYSTEM_PROMPT = `你是一个 TRPG 主持人（KP/DM）。你的任务是描述场景、推进剧情、控制节奏。

核心规则：
1. 用第二人称"你"描述玩家角色的所见所闻
2. 环境描写要具体，但只能使用权威事实或玩家明确观察到的信息；没有依据时保持中性
3. 每次仅推进一个节拍，不要跳跃式叙事
4. 不替玩家做决定——描述"你可以看到"而非"你走向"
5. 不代 NPC 发言——NPC 的对话由 NPC Agent 自己说
6. 遇到需要检定的情况，标出技能名但不投骰——骰子由律书处理
7. 叙事风格: 克苏鲁式渐近揭示——先普通再异常，从不全部说清
8. 如果后续 system 消息提供了模组原文或事实边界，它优先于常识和风格要求；不得补写原文未提供的光线、气味、声音、天气、温度、物品、人物或事件

格式：每次输出一个场景描述块。如果需要玩家行动，以"你要怎么做？"结尾。`;

/**
 * This is an operational notice, not diegetic prose.  Keep it separate from
 * the older generic degradation marker: a provider outage must never invent a
 * room, sound, attack, clue, or completed player action.
 */
export const KP_NARRATION_UNAVAILABLE_NOTICE = "叙事服务暂时不可用。";

function factualNarrationFallback(outcome: string): string {
  const publicOutcome = outcome.trim();
  return publicOutcome
    ? `${KP_NARRATION_UNAVAILABLE_NOTICE}\n\n${publicOutcome}`
    : KP_NARRATION_UNAVAILABLE_NOTICE;
}

export class KPAgent {
  private llm: LLMLike;
  private directive: KPDirective;
  private turns: TurnRecord[] = [];
  /** 世界模型权威事实注入（可选）：由会话层在叙事前设置，作为 system 上下文注入 */
  private worldModelContext: string = "";

  constructor(directive: KPDirective, llm: LLMLike) {
    this.directive = directive;
    this.llm = llm;
  }

  /** 更新剧情指令 */
  updateDirective(update: Partial<KPDirective>) {
    Object.assign(this.directive, update);
  }

  /** 设置世界模型注入文本（空串 = 不注入） */
  setWorldModelContext(text: string) {
    this.worldModelContext = text;
  }

  /** Produce a scene while preserving whether provider narration was available. */
  async describeSceneResult(signal?: AbortSignal): Promise<SceneDescriptionResult> {
    const messages: LLMMessage[] = [
      { role: "system", content: KP_SYSTEM_PROMPT },
      {
        role: "system",
        content: [
          `当前场景: ${this.directive.scene_description}`,
          `场景元素: ${this.directive.scene_elements.join("、")}`,
          "事实边界: 当前场景与场景元素列出了本次可用于叙事的全部玩家可见事实；不得补写未提供的物件、气味、声音、天气、照明、日期/时间、NPC 知识或已发生事件，未提供时保持中性。",
          `剧情阶段: ${this.directive.current_phase}`,
          `叙事风格: ${this.directive.style}`,
        ].join("\n"),
      },
    ];

    // 世界模型权威事实注入（可选）
    if (this.worldModelContext) {
      messages.push({ role: "system", content: this.worldModelContext });
    }

    // 注入最近的回合历史
    if (this.turns.length > 0) {
      const recent = this.turns.slice(-3);
      const history = recent
        .map((t) => {
          const msgs = t.messages
            .map((m) => `[${m.speaker}] ${m.content}`)
            .join("\n  ");
          return `第${t.round}轮:\n  玩家输入: ${t.player_input}\n  ${msgs}`;
        })
        .join("\n\n");
      messages.push({
        role: "system",
        content: `最近的历史:\n${history}`,
      });
    }

    messages.push({
      role: "user",
      content:
        "请描述当前场景中玩家能看到、听到、感受到的一切。要先描述环境，再提示可能的行动方向；若上下文包含原文闭世界约束，只输出原文可证实的事实。",
    });

    try {
      const response = await this.llm.chat(messages, {
        temperature: this.worldModelContext.includes("[叙事输出最终约束]") ? 0.2 : 0.7,
        maxTokens: 600,
        timeout: 120000,
        maxAttempts: 1,
        signal,
      });
      return { status: "ready", description: response.trim() };
    } catch (error) {
      // A caller cancellation is not a degraded narration result.  In
      // particular, server-side creation must be able to tear down its
      // non-authoritative staging target instead of publishing a fallback.
      if (signal?.aborted) throw error;
      // Provider diagnostics can include response bodies, endpoint URLs, or
      // request IDs. The fallback is observable without retaining any of it.
      log.warn("kp", "KP scene description provider unavailable; using fallback");
      return { status: "fallback", description: fallbackSceneDescription(this.directive.scene_description) };
    }
  }

  /** Backward-compatible string API for CLI and direct callers. */
  async describeScene(signal?: AbortSignal): Promise<string> {
    return (await this.describeSceneResult(signal)).description;
  }

  /**
   * 玩家行动后，KP 推进叙事。
   *
   * 开发·意图与约束补漏 任务3，缺口 A：这是自由跑团的主叙事路径，此前
   * 完全没有过约束层——"冰箱里面空荡荡的，只有几层隔板和后壁"（否认了
   * 模组已写明"储物柜里有十几瓶氧气罐"的事实）就是从这里出来的，连检查
   * 都没经过。`constraintOpts` 缺省不传时（CLI 侧 index.ts 未改）新约束
   * 天然不命中，行为与改动前一致。
   *
   * 命中约束时重生成一次（带上"不要这样说"的具体指正），而不是直接拿一句
   * 固定安全文案顶替——LLM 换一次措辞更可能真的推进叙事而不是打断节奏。
   * 重生成后仍然命中（LLM 没听懂/继续瞎编），才退回不点名任何具体对象的
   * 安全兜底——绝不能放一句踩线的话出去，"重试过一次"不构成放行理由。
   */
  async narrateOutcome(
    playerAction: string,
    outcome: string,
    recentMessages: AgentMessage[] = [],
    constraintOpts?: NarrateConstraintOpts,
  ): Promise<string> {
    const messages: LLMMessage[] = [
      { role: "system", content: KP_SYSTEM_PROMPT },
      {
        role: "system",
        content: [
          `场景: ${this.directive.scene_description}`,
          `场景元素: ${this.directive.scene_elements.join("、")}`,
          "事实边界: 当前场景与场景元素列出了本次可用于叙事的全部玩家可见事实；不得补写未提供的物件、气味、声音、天气、照明、日期/时间、NPC 知识或已发生事件，未提供时保持中性。",
          `剧情阶段: ${this.directive.current_phase}`,
        ].join("\n"),
      },
    ];

    // 世界模型权威事实注入（可选）
    if (this.worldModelContext) {
      messages.push({ role: "system", content: this.worldModelContext });
    }

    if (recentMessages.length > 0) {
      const history = recentMessages
        .slice(-8)
        .map((m) => `[${m.speaker}] ${m.content}`)
        .join("\n");
      messages.push({
        role: "system",
        content: `最近事件:\n${history}`,
      });
    }

    messages.push({
      role: "user",
      content: [
        `玩家行动: ${playerAction}`,
        `判定结果: ${outcome}`,
        "",
        "请以 KP 的口吻描述结果，推进一个叙事节拍。不要替 NPC 说话。若上下文包含原文闭世界约束，只输出原文可证实的物品、空间、状态和玩家动作结果，不要添加氛围细节。",
      ].join("\n"),
    });

    const temperature = this.worldModelContext.includes("[叙事输出最终约束]") ? 0.2 : 0.8;
    const callOnce = async (extra?: LLMMessage): Promise<string> => {
      const raw = await this.llm.chat(extra ? [...messages, extra] : messages, {
        temperature, maxTokens: 500, timeout: 120000, maxAttempts: 1,
      });
      return raw.trim();
    };

    try {
      let response = await callOnce();
      const hit = checkNarrationText(response, {
        sceneId: constraintOpts?.sceneId,
        ruleset: constraintOpts?.ruleset,
        undiscoveredClueKeys: constraintOpts?.undiscoveredClueKeys,
      });
      if (hit) {
        log.warn("kp", `KP 叙事约束拦截，重生成一次: ${hit.type === "block" ? hit.blockMessage : hit.type}`);
        response = await callOnce({
          role: "system",
          content: "上一次回答对场景里一件尚未被发现的东西下了「空的/没有/已经搜过」这类断言，这与模组事实矛盾——不要否认任何具体物件的存在或内容，只描述玩家这个动作本身，把细节留到玩家真正检定成功时再揭示。",
        });
        const hit2 = checkNarrationText(response, {
          sceneId: constraintOpts?.sceneId,
          ruleset: constraintOpts?.ruleset,
          undiscoveredClueKeys: constraintOpts?.undiscoveredClueKeys,
        });
        if (hit2) {
          log.warn("kp", "KP 叙事重生成后仍命中约束，退回安全兜底文案");
          response = pickSafeFallback();
        }
      }
      return response;
    } catch (err: any) {
      log.warn("kp", `KP 叙事 LLM 失败: ${err.message}`);
      // `outcome` is the caller's already-public rule/result text.  Do not
      // pass playerAction through fallbackNarrative: its generic scene/action
      // templates fabricate facts and can falsely narrate an uncommitted act.
      return factualNarrationFallback(outcome);
    }
  }

  /** 局势停滞时注入新事件 */
  async injectEvent(): Promise<string | null> {
    const pendingNodes = this.directive.plot_nodes.filter((n) => !n.done);
    if (pendingNodes.length === 0) return null;

    const messages: LLMMessage[] = [
      { role: "system", content: KP_SYSTEM_PROMPT },
      {
        role: "system",
        content: [
          `场景: ${this.directive.scene_description}`,
          `可触发的剧情节点:`,
          ...pendingNodes.map(
            (n) => `  - ${n.id}: ${n.description}（触发条件: ${n.trigger}）`
          ),
        ].join("\n"),
      },
      {
        role: "user",
        content:
          "根据剧情节点，决定一个合理的叙事推进。描述环境中的新变化——新线索、新 NPC 进入、或某个等待中的事件发生了。输出 2-3 句话的环境/事件描述。如果时机不成熟，输出 'WAIT'。",
      },
    ];

    try {
      const response = await this.llm.chat(messages, {
        temperature: 0.6,
        maxTokens: 300,
      });
      const trimmed = response.trim();
      if (trimmed === "WAIT" || trimmed === '"WAIT"') return null;
      return trimmed;
    } catch (err: any) {
      log.warn("kp", `KP 事件注入 LLM 失败: ${err.message}`);
      return null;
    }
  }

  /** 场景切换 */
  async transitionScene(
    newScene: string,
    reason: string
  ): Promise<string> {
    this.directive.scene_description = newScene;
    this.directive.current_phase = newScene;

    const messages: LLMMessage[] = [
      { role: "system", content: KP_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `场景切换原因: ${reason}`,
          `新场景: ${newScene}`,
          "",
          "请写一段场景过渡叙事（2-4句话），柔和地将玩家从上一个场景引入新场景。",
        ].join("\n"),
      },
    ];

    const response = await this.llm.chat(messages, {
      temperature: 0.7,
      maxTokens: 400,
    });

    return response.trim();
  }

  /** 记录一个回合 */
  recordTurn(turn: TurnRecord) {
    this.turns.push(turn);
  }

  /** 获取当前剧情指令 */
  getDirective(): KPDirective {
    return this.directive;
  }

  /** 获取回合历史 */
  getTurns(): TurnRecord[] {
    return this.turns;
  }
}
