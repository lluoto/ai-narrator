// 一局的可变状态，按「谁在写它」分组。
//
// 起因是拆 play-module：`runModuleInner` 一个闭包里平铺着六类互不相干的状态
// （模组配置 / 角色 / 世界 / 世界模型缓存 / 叙事去重 / 循环游标），
// 于是任何一块想抽出去，参数列表都会横跨好几类 —— 陷阱那块抽出来传了 11 个散参数。
//
// 分组不是为了把参数变少，是为了让**每个参数都是一个完整概念**。
// 收成一个大 bag 会把依赖重新藏起来，那正是抽出闭包要消除的东西：
// 一个函数拿到 `cast` 就说明它会碰角色，拿到 `cursor` 就说明它参与循环推进。
//
// 这里先只收 cast 与 cursor 两类 —— 边界最清楚，且可立刻验证（陷阱参数 11 → 4）。
// 世界模型缓存与叙事去重留在闭包里，等各自的使用方抽出去时再一并处理。

import type { CoCGeneratedCharacter } from "../character/coc-character";
import type { SanityEngine } from "../rules/coc-engine";
import type { WorldModelIntegrator } from "../world/world-model-integrator";
import type { WorldModelLoader } from "../world/world-model-loader";
import { createGameTime, type GameTime } from "../rules/game-time";

/**
 * 本局的两名调查员。
 *
 * 三样东西一一对应且必须同进同出：显示名（p0/p1）、角色卡（c1/c2）、SAN 引擎（san1/san2）。
 * 散着传最容易出的错就是错位 —— 拿 p0 的名字配 c2 的角色卡，
 * 日志上看不出来（名字是对的），但掉的是另一个人的血。
 */
export interface Cast {
  p0: { shortName: string };
  p1: { shortName: string };
  c1: CoCGeneratedCharacter;
  c2: CoCGeneratedCharacter;
  san1: SanityEngine;
  san2: SanityEngine;
}

/**
 * 跨场景的循环游标。
 *
 * ⚠ 这些看着像局部变量，实际是**主循环的不变量**，散在闭包里出过事：
 * `arrivedByPlayerChoice` 就是「静默传送」那个 bug 的所在
 * —— 玩家选定的目的地在到达后被访问次数规则弹走，而没有任何播报。
 * 收成显式契约之后，谁读谁写一目了然。
 */
export interface Cursor {
  /** 主循环轮次，上限见 runModuleInner */
  rounds: number;
  /**
   * 本局唯一的确定性时钟。
   *
   * 陷阱等机制只读它判断时段；主循环推进它，不能再从 stepCounter 推导第二份昼夜算法。
   */
  gameTime: GameTime;
  /**
   * 轮流让哪名调查员出手。
   *
   * **线索检定与陷阱共享它** —— 线索那边 `stepCounter++`，陷阱这边只读它决定谁踩中。
   * 这层共享原先埋在闭包里看不出来。另外它还兼任「开局第 0 步不触发陷阱」的哨兵。
   */
  stepCounter: number;
  /** 本局已经响过的陷阱 id，跨进场累积 */
  triggeredTraps: Set<string>;
  /**
   * 每个场景进过几次。
   *
   * 主循环写、场景流水线读（判断是不是首次进场、给移动选项排序）。
   * 这层读写分离原先埋在闭包里 —— 收进来之后才看得出
   * 「谁在推进它」和「谁只是参考它」是两拨代码。
   */
  visitCount: Map<string, number>;
  /** 主循环是否该收尾 */
  done: boolean;
  /** 这次进场是不是玩家自己选的目的地 —— 是就别再替他改道 */
  arrivedByPlayerChoice: boolean;
}

/**
 * 叙事去重 —— 「上次用的是哪句」，避免连着两次一模一样。
 *
 * 这类状态原先靠闭包捕获，直接后果是 npc-dialogue 抽不干净：
 * 它要用引导桥，而引导桥要读写 `lastRevealBridge`，够不到就只能
 * 把整个函数当回调注入。收成对象之后那个回调参数就不需要了。
 */
export interface Dedup {
  /** 上一次用过的提问引导 */
  lastAskBridge: string;
  /** NPC 侧的引导桥 */
  lastRevealBridge: string;
  /** 上一次同伴说过的话 */
  lastPartnerRemark: string;
  /**
   * 每人已经开口过几次 —— `askerScore` 的「别包场」惩罚项。
   *
   * ⚠ 原先是 `scene-pipeline.ts` 的**模块级 Map**，跨局不重置。两个后果：
   *   1. 同一进程里跑第二局时，第一局的开口计数还压着，
   *      「这一轮谁开口」于是取决于**之前跑过几局**。诊断脚本实测：
   *      同 seed 连跑两局，事件流完全一致而播报文本不一致，差异全在提问者名字上。
   *   2. 接进服务端后多局并发，两局共享同一份计数 —— 与当初把输出从
   *      模块级数组挪进 `RunContext` 要解决的是同一个问题。
   * 名字可能撞车（两局各有一个「亨利」），那就更该按局隔离。
   */
  askCounts: Map<string, number>;
}

export function newDedup(): Dedup {
  return { lastAskBridge: "", lastRevealBridge: "", lastPartnerRemark: "", askCounts: new Map() };
}

/**
 * 世界模型接入：两个只读大模型 + 一份按场景的缓存。
 *
 * `integrator` 可以是 null —— 模型文件缺失/损坏时静默降级，其余流程照跑。
 * 缓存只有一格（当前场景），因为注入点都在同一个场景内连着用，
 * 换场景就该重算；做成 Map 反而会把 229MB 模型的派生文本越攒越多。
 *
 * ⚠ 两个 loader 都必须走 `sharedWorldModel()` 拿共享实例：
 * v18 是 383688 条只读参考数据，独占一份约 229MB。命令行下一进程一局无所谓，
 * 接进服务端后每开一局就再吃一份 —— 实测日志里出现过同一份模型被载入两次。
 */
export interface WorldModelCtx {
  integrator: WorldModelIntegrator | null;
  /** 神话侧模型，按路径另取一份 */
  cthulhuLoader: WorldModelLoader;
  /** 缓存所属场景；换场景即失效 */
  cacheSceneId: string;
  cacheText: string;
}

/**
 * 失去意识 —— CoC 7e：HP 归零即昏迷，不能行动。
 *
 * 抽成一个判定而不是各处写 `pc.hp <= 0`，是因为「谁能行动」这件事
 * 原先散在三个选人点上（线索检定轮转、陷阱踩中者、提问者），
 * 而且**一处都没检查** —— 日志里出现过「两名调查员都失去了意识」之后
 * 两人继续查线索、掷理智、陷入疯狂。
 */
export function isDowned(pc: { hp: number }): boolean {
  return pc.hp <= 0;
}

/** 还能行动的人。全倒下时返回空数组，调用方据此收尾。 */
export function standing<T extends { hp: number }>(pcs: T[]): T[] {
  return pcs.filter((p) => !isDowned(p));
}

/** 建一份初始游标 */
export function newCursor(): Cursor {
  return {
    rounds: 0,
    gameTime: createGameTime(),
    stepCounter: 0,
    triggeredTraps: new Set<string>(),
    visitCount: new Map<string, number>(),
    done: false,
    arrivedByPlayerChoice: false,
  };
}
