// 一局的播报输出层：本局上下文 + say/sayMech/divider。
//
// 从 play-module.ts 抽出来，是为了让被拆分出去的子模块（npc-dialogue 等）
// 能够到 say() 而不反过来 import play-module —— 那会成环。
// 这里不含任何剧本逻辑，只管「一行字往哪去」。

import { AsyncLocalStorage } from "node:async_hooks";
import type { PlayerDecision } from "../agent/player-agent";
import type { WoundSeverity } from "../combat/wound-effects";
import type { LLMClient } from "../llm/client";
import type { PlayEvent } from "./events";

/**
 * 播报行的来源。语音层据此分预制/实时/不念 —— 判据是「经没经过 LLM」，
 * 不是「内容像不像固定文本」，见 docs/voice-readiness.md 第七节。
 *
 * 默认取 "llm" 而不是 "verbatim"：漏标只会让一条本可预制的行退化成实时合成，
 * 功能不受影响；反过来把 LLM 文本误标成 verbatim，会把当次生成的内容烘进音频
 * 缓存，之后每局都放那一句。两个方向的代价不对称，默认值指向便宜的那侧。
 */
export type LineOrigin = "verbatim" | "llm" | "mech";

/**
 * 决策器：给出当前处境与可选项，返回玩家的决定。
 *
 * 抽出来是为了让同一套剧本既能由内置 AI 玩家自动跑（原有行为），
 * 也能由真人通过 API 驱动 —— 剧本逻辑不需要知道对面是谁。
 */
export type Decider = (context: string, options: string[]) => Promise<PlayerDecision>;

/**
 * 一局的运行上下文。
 *
 * 用 AsyncLocalStorage 而不是模块级变量：原先输出写在模块级的 log 数组里，
 * 一个进程只能跑一局。接进 API 之后会有多局并发，而它们在每个 await 处交错，
 * 共享一个数组会让两局的播报串台。异步上下文能让所有嵌套调用
 * （包括定义在别的文件里的辅助函数）自动拿到本局的那一份。
 */
export interface RunContext {
  /** The sole LLM client for this play-module run; null explicitly means offline. */
  llmClient?: LLMClient | null;
  lines: string[];
  /** 与 lines 逐项对应，同进同出 */
  origins: LineOrigin[];
  onLine?: (line: string, origin: LineOrigin) => void;
  /**
   * 结构化事件订阅（见 `play/events.ts`）。只有诊断/测试会订阅，
   * 剧本逻辑一行都不读它 —— 它是**观察口**，不是控制口。
   */
  onEvent?: (event: PlayEvent) => void;
  decide?: Decider;
  /**
   * 角色名 → 尚未处理的最重伤势。`check()` 据此自动加惩罚骰。
   *
   * 放这里而不是 WorldState：WorldState 装的是**模组**状态（线索/场景/NPC），
   * 而 HP 一直挂在角色对象上。伤势跟 HP 是同一类东西（本局的角色身体状态），
   * 拆到两个地方存只会让「这个人现在什么状况」要查两处。
   * 放 RunContext 是因为 `check()` 只拿得到角色名，
   * 而 AsyncLocalStorage 正是 `say`/`sayMech` 用来够到本局状态的同一条路。
   */
  wounds: Map<string, WoundSeverity>;
}

export const runCtx = new AsyncLocalStorage<RunContext>();

export function say(m: string, origin: LineOrigin = "llm") {
  const ctx = runCtx.getStore();
  if (!ctx) { console.log(m); return; }
  ctx.lines.push(m);
  ctx.origins.push(origin);
  ctx.onLine?.(m, origin);
}

/** Output game-mechanics text (rolls, damage, rules) — visually distinct from story narration */
export function sayMech(m: string) { say(`  [检定] ${m}`, "mech"); }

/**
 * 发一条结构化事件。没有订阅者时什么也不做。
 *
 * 与 `say()` 并列而不是从 `say()` 里派生：播报文本是给人读的，
 * 事件是给判据读的。让后者依赖前者的措辞，正是诊断脚本反复出错的根源。
 */
export function emit(event: PlayEvent): void {
  runCtx.getStore()?.onEvent?.(event);
}

export function divider(t?: string) {
  say("", "mech");
  say("\u2501".repeat(60), "mech");
  if (t) say("  " + t, "mech");
  say("\u2501".repeat(60), "mech");
}
