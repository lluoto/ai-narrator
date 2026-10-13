/**
 * 剧本杀会话 —— 把 play-module 的剧本引擎接成外部可驱动的一局。
 *
 * 引擎本身是一条从头跑到尾的协程：它播报、遇到岔口时调决策器、拿到决定后继续。
 * 这里做的事只有两件：把播报收进缓冲区，以及在决策点把协程挂起，
 * 等外部提交决定后再放行。剧本逻辑一行不改。
 *
 * 与自由跑团（GameSession）并列，互不共享状态：那边是 KP 即兴生成，
 * 这边是线索门禁 + 多结局，两套规则混在一起只会互相污染。
 */

import { randomUUID } from "crypto";
import { runModule, type LineOrigin } from "../play-module";
import { BARN_OF_PREMIER, BARN_SUPPORT } from "../module/barn-of-premier";
import { voiceKey } from "../voice/speech-plan";
import type { PlayerDecision } from "../agent/player-agent";
import {
  isOrdinarySessionAccessBinding,
  principalMatchesOrdinarySessionAccess,
  type OrdinarySessionAccessBinding,
  type OrdinarySessionPrincipal,
} from "./session-access";

/** 引擎停在岔口时对外暴露的东西 */
interface PendingChoice {
  /** 当前处境：场景、在场的人、已知线索、调查进度 */
  context: string;
  /** 可选行动的文字标签，提交时原样回传 */
  options: string[];
}

interface ScriptedSnapshot {
  id: string;
  /** 自上次拉取之后新增的播报行 */
  lines: string[];
  /**
   * 与 lines 逐项对应的预制音频键。有值表示该行有离线合成好的音频可直接放，
   * 文件名就是这个键；null 表示该行经过 LLM（须实时合成）或属机制文本（不念）。
   *
   * 判据来自引擎在出文那一刻记下的来源，不是在这里按文本长相猜的 ——
   * 见 docs/voice-readiness.md 第七节。
   */
  voiceKeys: (string | null)[];
  /** 停在岔口时有值；为空表示引擎仍在推进或已结束 */
  pending: PendingChoice | null;
  finished: boolean;
  /** 累计播报行数，用于前端判断是否漏读 */
  total: number;
}

export class ScriptedSession {
  readonly id: string;
  private lines: string[] = [];
  /** 与 lines 逐项对应，同进同出 */
  private origins: LineOrigin[] = [];
  /** 已被拉走的行数；只发增量，避免每次把整局重传一遍 */
  private cursor = 0;
  private pending: (PendingChoice & { resolve: (d: PlayerDecision) => void }) | null = null;
  private finished = false;
  private failure: string | null = null;

  constructor(id: string) {
    this.id = id;
  }

  /**
   * 开跑。不 await —— 引擎会一直跑到第一个岔口才停，
   * 这里立刻返回，由调用方轮询拿播报。
   */
  start(): void {
    runModule(BARN_OF_PREMIER, BARN_SUPPORT, {
      onLine: (line, origin) => { this.lines.push(line); this.origins.push(origin); },
      decide: (context, options) => this.park(context, options),
    })
      .then(() => { this.finished = true; })
      .catch((err: unknown) => {
        // 引擎抛错要让外部看见，不能只留一个永远不结束的会话
        this.failure = err instanceof Error ? err.message : String(err);
        this.finished = true;
      });
  }

  /** 在岔口挂起，等 submit() 放行 */
  private park(context: string, options: string[]): Promise<PlayerDecision> {
    return new Promise<PlayerDecision>((resolve) => {
      this.pending = { context, options, resolve };
    });
  }

  /** 拉取增量播报与当前岔口 */
  poll(): ScriptedSnapshot {
    const lines = this.lines.slice(this.cursor);
    const origins = this.origins.slice(this.cursor);
    this.cursor = this.lines.length;
    return {
      id: this.id,
      lines,
      // 键只由文本内容决定，与 gen-speech 烘出来的文件名同一口径
      voiceKeys: origins.map((o, i) => (o === "verbatim" ? voiceKey(lines[i]) : null)),
      pending: this.pending ? { context: this.pending.context, options: this.pending.options } : null,
      finished: this.finished,
      total: this.lines.length,
    };
  }

  /**
   * 提交决定。
   *
   * 选项标签原样回传即可：引擎是拿 action 文本去匹配连接条件的
   * （取条件前 8 字做包含判断），标签本身必然命中。
   */
  submit(option: string): { ok: true } | { ok: false; error: string } {
    const p = this.pending;
    if (!p) return { ok: false, error: "当前没有待决策的岔口" };
    if (!p.options.includes(option)) {
      return { ok: false, error: `不是可选项: ${option}` };
    }
    this.pending = null;
    p.resolve({ action: option, intent: "move" });
    return { ok: true };
  }

  get error(): string | null {
    return this.failure;
  }
}

/** Scripted runs are explicitly process-local; they have no durable recovery contract. */
export const SCRIPTED_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** A fixed process-owned ceiling prevents anonymous-like registry growth. */
export const SCRIPTED_SESSION_MAX_ACTIVE = 64;
const SCRIPTED_SESSION_ID_ATTEMPTS = 4;

interface ScriptedSessionRecord {
  session: ScriptedSession;
  /** Digest-only ordinary owner binding. This never leaves the registry. */
  access: OrdinarySessionAccessBinding;
  lastActiveAt: number;
}

export interface ScriptedSessionRegistryOptions {
  /** Host/test seam. Request data can never influence this generator. */
  generateId?: () => string;
  /** Host/test seam. The production default is Date.now. */
  now?: () => number;
  /** Host/test seam. Production uses SCRIPTED_SESSION_MAX_ACTIVE. */
  maxActive?: number;
  /** Host/test seam. Production uses the ordinary 30-minute idle interval. */
  idleTimeoutMs?: number;
  /** Test seam; production always constructs ScriptedSession. */
  createSession?: (id: string) => ScriptedSession;
}

function isScriptedSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/** Test/host seams may tighten, never expand, the fixed production limits. */
function constrainedPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) {
    throw new Error(`${name} must be a positive safe integer no greater than the production limit`);
  }
  return value;
}

/**
 * Server-owned in-memory scripted registry. It intentionally offers no
 * persistence, inter-process coordination, recovery, or eviction of a live
 * entry. Its binding is private: callers receive snapshots only from the
 * authenticated session object, never the owner digest.
 */
export class ScriptedSessionRegistry {
  #sessions = new Map<string, ScriptedSessionRecord>();
  readonly #generateId: () => string;
  readonly #now: () => number;
  readonly #maxActive: number;
  readonly #idleTimeoutMs: number;
  readonly #createSession: (id: string) => ScriptedSession;

  constructor(options: ScriptedSessionRegistryOptions = {}) {
    this.#generateId = options.generateId ?? randomUUID;
    this.#now = options.now ?? Date.now;
    this.#maxActive = constrainedPositiveInteger(options.maxActive, SCRIPTED_SESSION_MAX_ACTIVE, "maxActive");
    this.#idleTimeoutMs = constrainedPositiveInteger(options.idleTimeoutMs, SCRIPTED_SESSION_IDLE_TIMEOUT_MS, "idleTimeoutMs");
    this.#createSession = options.createSession ?? ((id) => new ScriptedSession(id));
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** Create only after removing expired entries; live entries are never evicted for capacity. */
  create(access: OrdinarySessionAccessBinding): ScriptedSession | undefined {
    if (!isOrdinarySessionAccessBinding(access)) return undefined;
    this.#cleanupExpired();
    if (this.#sessions.size >= this.#maxActive) return undefined;
    for (let attempt = 0; attempt < SCRIPTED_SESSION_ID_ATTEMPTS; attempt++) {
      const id = this.#generateId();
      if (!isScriptedSessionId(id) || this.#sessions.has(id)) continue;
      const session = this.#createSession(id);
      // Store only a copy of the digest binding, never a principal or raw credential.
      this.#sessions.set(id, { session, access: structuredClone(access), lastActiveAt: this.#now() });
      try {
        session.start();
      } catch {
        // A test/host implementation can fail synchronously before its normal
        // async error path exists. Do not retain an unreachable orphan record.
        this.#sessions.delete(id);
        return undefined;
      }
      return session;
    }
    return undefined;
  }

  /**
   * Read, expiry-check, owner-check, and activity refresh as one post-auth
   * operation. A foreign caller receives the same undefined result as an
   * unknown locator and cannot consume a poll cursor or a pending decision.
   */
  getAuthorized(id: string, principal: OrdinarySessionPrincipal): ScriptedSession | undefined {
    const record = this.#sessions.get(id);
    if (!record) return undefined;
    const now = this.#now();
    if (now - record.lastActiveAt > this.#idleTimeoutMs) {
      this.#sessions.delete(id);
      return undefined;
    }
    if (!principalMatchesOrdinarySessionAccess(principal, record.access)) return undefined;
    record.lastActiveAt = now;
    return record.session;
  }

  /** Removal is intentionally only idle expiry; no LRU or pressure eviction exists. */
  #cleanupExpired(now = this.#now()): void {
    for (const [id, record] of this.#sessions) {
      if (now - record.lastActiveAt > this.#idleTimeoutMs) this.#sessions.delete(id);
    }
  }
}

/** The production registry is a single fixed-cap, process-owned authority. */
export const defaultScriptedSessionRegistry = new ScriptedSessionRegistry();
