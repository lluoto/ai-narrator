// 世界模型加载器 — v18 版本（合并 v15+v16+v17，383K 条，73 部小说）
// 按小说/类型/关键词多重索引，支持 D&D 游戏规则路由
// 向后兼容 integrator 的 queryCausal/queryBehavior/getFactionRelations 接口

import { readFileSync, existsSync } from "fs";
import { resolve } from "node:path";
import { log } from "../log";

// ============================================================
// v18 统一条目类型（v15+v16+v17 联合）
// ============================================================

export interface V18Entry {
  readonly type: string;
  readonly name?: string;
  readonly description?: string;
  readonly chapter: string;
  readonly novel?: string;
  readonly _version?: string;           // "v15+v16" | "v16" | "v17"

  // v15+v16: 原始世界观
  readonly quote_abridged?: string;
  readonly quote_source?: string;
  readonly properties?: Readonly<Record<string, string>>;
  readonly source?: string;
  readonly hallucination_risk?: boolean;
  readonly causal_precheck?: Readonly<Record<string, unknown>>;

  // v16: D&D 映射
  readonly mechanic?: string;
  readonly game_rule?: boolean | string;
  readonly dnd_mapping?: string;

  // v17: 行为/因果
  readonly trigger?: string;
  readonly response?: string;
  readonly world_fit?: number;

  // 保留原始字段
  readonly [key: string]: unknown;
}

// ============================================================
// v18 查询结果（统一包装）
// ============================================================

interface WorldModelStats {
  total: number;
  byNovel: Record<string, number>;
  byType: Record<string, number>;
  byVersion: Record<string, number>;
  dndGameRules: number;
  dndMappings: number;
  hallucinationRisky: number;
}

// 向后兼容的查询返回（集成层仍用）
interface ScoredEntry {
  readonly entry: V18Entry;
  readonly score: number;
}

type EntryList = readonly V18Entry[];
const EMPTY_ENTRY_LIST: EntryList = Object.freeze([] as V18Entry[]);

// ============================================================
// 加载器
// ============================================================

/**
 * 世界模型路径。默认指向仓库外的兄弟目录，容器里用 WORLD_MODEL_PATH 覆盖。
 *
 * 写成可覆盖是部署需要：这份文件 229MB、在仓库之外，镜像里的位置和开发机
 * 不可能一样，而这个路径此前散在 6 处硬编码里，改一次要改六个地方。
 */
export const DEFAULT_V18_PATH =
  process.env.WORLD_MODEL_PATH ?? "../世界模型/v18_output/v18_all_master.jsonl";

/** 克苏鲁子模型，同样可覆盖 */
export const DEFAULT_CTHULHU_PATH =
  process.env.CTHULHU_MODEL_PATH ?? "../世界模型/datasets/cthulhu/extracted/cthulhu_world_model.jsonl";

/** 按路径共享的 loader 实例。世界模型是只读参考数据，没有按会话变化的内容。 */
const SHARED = new Map<string, WorldModelLoader>();
/**
 * A shared loader represents exactly the resource selected by its factory key.
 * Keep that authority module-private: standalone WorldModelLoader instances
 * intentionally retain their explicit reload/replacement contract.
 */
const SHARED_SOURCE_KEYS = new WeakMap<WorldModelLoader, string>();

/**
 * 取得进程内共享的世界模型 loader。
 *
 * 为什么必须共享：v18_all_master.jsonl 是 383688 条只读参考数据。此前每个
 * GameSession 各 `new WorldModelLoader()`，实测建立 3 个会话就把它加载了 3 遍
 * （每遍约 1.2-1.3s），服务进程驻留 1938 MB；而磁盘上已有 41 个存档会话，
 * 按原样逐个恢复必然打爆内存。
 *
 * 为什么共享是安全的：全部可变状态都在 load() 里一次性建好，之后所有公开方法
 * 只读。调用方一律用 `isLoaded()` 守卫后再 load()，因此第二个使用者不会重复加载。
 */
export function sharedWorldModel(path: string = DEFAULT_V18_PATH): WorldModelLoader {
  const key = sharedPathKey(path);
  const existing = SHARED.get(key);
  if (existing) return existing;
  const created = new WorldModelLoader();
  SHARED.set(key, created);
  SHARED_SOURCE_KEYS.set(created, key);
  return created;
}

export class WorldModelLoader {
  private entries: EntryList = EMPTY_ENTRY_LIST;
  private byNovel: Map<string, EntryList> = new Map();
  private byType: Map<string, EntryList> = new Map();
  private byNovelAndType: Map<string, EntryList> = new Map();
  private byVersion: Map<string, EntryList> = new Map();
  private dndGameRules: EntryList = EMPTY_ENTRY_LIST;
  private dndMappings: EntryList = EMPTY_ENTRY_LIST;
  private hallucinationRisky: EntryList = EMPTY_ENTRY_LIST;
  private loaded = false;
  private loadTime = 0;

  /**
   * 加载 v18_all_master.jsonl
   * @param path JSONL 文件路径
   */
  load(path: string = DEFAULT_V18_PATH) {
    const pinnedSourceKey = SHARED_SOURCE_KEYS.get(this);
    if (pinnedSourceKey !== undefined && sharedPathKey(path) !== pinnedSourceKey) {
      // Do this before any filesystem observation or state clear. A process
      // shared reference bucket may be read by many legacy sessions, so one
      // host cannot retarget it to a different resource behind their facades.
      throw new Error("shared world-model loader is pinned to its source");
    }
    if (!existsSync(path)) {
      this.clear();
      log.warn("world", `世界模型文件未找到: ${path}`);
      return;
    }

    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (error) {
      this.clear();
      log.warn("world", `世界模型文件无法读取: ${path}`, error);
      return;
    }

    const start = performance.now();
    const entries: V18Entry[] = [];
    const byNovel = new Map<string, V18Entry[]>();
    const byType = new Map<string, V18Entry[]>();
    const byNovelAndType = new Map<string, V18Entry[]>();
    const byVersion = new Map<string, V18Entry[]>();
    const dndGameRules: V18Entry[] = [];
    const dndMappings: V18Entry[] = [];
    const hallucinationRisky: V18Entry[] = [];
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    let rejectedLines = 0;

    for (const line of lines) {
      let e: V18Entry;
      try {
        const candidate: unknown = JSON.parse(line);
        if (!isValidV18Entry(candidate)) {
          throw new Error("expected an object with non-empty string type and chapter fields");
        }
        e = candidate;
      } catch {
        // The historical v18 corpus can contain orphan candidates. They are not
        // usable entries, but a valid replacement remains usable if it has at
        // least one complete entry. The all-invalid case below is fail-closed.
        rejectedLines += 1;
        continue;
      }

      entries.push(e);
        const novel = e.novel || "未知";

        // 按小说索引
        if (!byNovel.has(novel)) byNovel.set(novel, []);
        byNovel.get(novel)!.push(e);

        // 按类型索引
        if (!byType.has(e.type)) byType.set(e.type, []);
        byType.get(e.type)!.push(e);

        // 按小说+类型索引
        const novelTypeKey = `${novel}|${e.type}`;
        if (!byNovelAndType.has(novelTypeKey)) byNovelAndType.set(novelTypeKey, []);
        byNovelAndType.get(novelTypeKey)!.push(e);

        // 按版本索引
        const ver = e._version || "unknown";
        if (!byVersion.has(ver)) byVersion.set(ver, []);
        byVersion.get(ver)!.push(e);

        // D&D 游戏规则
        if (e.game_rule === true || e.game_rule === "true" || typeof e.game_rule === "string") {
          dndGameRules.push(e);
        }
        if (e.dnd_mapping) {
          dndMappings.push(e);
        }
        if (e.hallucination_risk === true) {
          hallucinationRisky.push(e);
        }
    }

    if (entries.length === 0) {
      this.clear();
      log.warn("world", `世界模型文件没有可用条目: ${path}${rejectedLines > 0 ? `（已拒绝 ${rejectedLines} 行）` : ""}`);
      return;
    }

    // All parsing and indexing complete before replacing the live model. A
    // failed replacement is unloaded rather than serving an old or mixed model.
    freezeJsonEntries(entries);
    freezeEntryBuckets(entries, dndGameRules, dndMappings, hallucinationRisky);
    freezeIndexBuckets(byNovel, byType, byNovelAndType, byVersion);
    this.entries = entries;
    this.byNovel = byNovel;
    this.byType = byType;
    this.byNovelAndType = byNovelAndType;
    this.byVersion = byVersion;
    this.dndGameRules = dndGameRules;
    this.dndMappings = dndMappings;
    this.hallucinationRisky = hallucinationRisky;
    this.loaded = true;
    this.loadTime = performance.now() - start;
    // 每部小说的条目数原先算了但没进日志（下面两行只印总数），
    // 是一次 O(n) 的白算。要按小说细分时再加，别留个算完就扔的值。
    console.log(`  🌐 世界模型 v18 已加载: ${this.entries.length} 条 | ${this.byNovel.size} 部小说 | ${this.byType.size} 种类型 | ${(this.loadTime / 1000).toFixed(1)}s`);
    console.log(`     D&D 规则: ${this.dndGameRules.length} | D&D 映射: ${this.dndMappings.length} | 幻觉风险: ${this.hallucinationRisky.length}`);
  }

  isLoaded(): boolean { return this.loaded; }

  // ============================================================
  // 基础查询
  // ============================================================

  /** 获取所有条目（谨慎使用 — 内存大） */
  getAll(): EntryList {
    return this.entries;
  }

  /** 按小说获取 */
  getByNovel(novel: string): EntryList {
    return this.byNovel.get(novel) ?? EMPTY_ENTRY_LIST;
  }

  /** 按类型获取（保留旧名兼容） */
  getByType(type: string): EntryList {
    return this.byType.get(type) ?? EMPTY_ENTRY_LIST;
  }

  /** 按小说+类型获取 */
  getByNovelAndType(novel: string, type: string): EntryList {
    return this.byNovelAndType.get(`${novel}|${type}`) ?? EMPTY_ENTRY_LIST;
  }

  /** 所有小说名 */
  getNovelNames(): string[] {
    return [...this.byNovel.keys()].sort();
  }

  /** 所有类型 */
  getTypeNames(): string[] {
    return [...this.byType.keys()].sort();
  }

  // ============================================================
  // D&D 专用查询（v16 字段）
  // ============================================================

  /** 获取含 game_rule 的条目（可路由到 D&D 规则系统） */
  getDndRules(novel?: string): EntryList {
    if (novel) {
      return this.dndGameRules.filter(e => e.novel === novel);
    }
    return this.dndGameRules;
  }

  /** 获取含 dnd_mapping 的条目 */
  getDndMappings(novel?: string): EntryList {
    if (novel) {
      return this.dndMappings.filter(e => e.novel === novel);
    }
    return this.dndMappings;
  }

  /** 获取含 mechanic 描述的条目 */
  getMechanics(novel?: string): EntryList {
    const all = this.entries.filter(e => e.mechanic);
    if (novel) return all.filter(e => e.novel === novel);
    return all;
  }

  // ============================================================
  // 关键词搜索（线性扫描 + 评分）
  // ============================================================

  /**
   * 全量关键词搜索（跨所有小说）
   * @param keywords 关键词数组
   * @param novel 可选：限制小说
   * @param type 可选：限制类型
   * @param maxResults 最多返回
   * @returns 评分排序的条目
   */
  search(
    keywords: string[],
    novel?: string,
    type?: string,
    maxResults: number = 10
  ): readonly ScoredEntry[] {
    const pool = novel
      ? (type ? this.getByNovelAndType(novel, type) : this.getByNovel(novel))
      : (type ? this.getByType(type) : this.entries);

    const lowerKeywords = keywords.map(k => k.toLowerCase());
    const scored: ScoredEntry[] = [];

    for (const e of pool) {
      const text = [
        e.name,
        e.description,
        e.mechanic,
        e.dnd_mapping,
        e.trigger,
        e.response,
        e.quote_abridged,
      ].filter(Boolean).join(" ").toLowerCase();

      let score = 0;
      for (const kw of lowerKeywords) {
        if (text.includes(kw)) {
          score += 10;
          // 名字命中权重更高
          if (e.name?.toLowerCase().includes(kw)) score += 5;
        }
      }

      // quality boost
      if (e.world_fit && e.world_fit >= 4) score += 3;
      if (e.dnd_mapping) score += 2; // D&D 映射条目更实用

      if (score > 0) scored.push({ entry: e, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
  }

  // ============================================================
  // 向后兼容接口（integrator 仍用）
  // ============================================================

  /**
   * 获取 faction_relation 类型条目
   * 旧接口: 返回任意类型（可强转）
   */
  getFactionRelations(): EntryList {
    return this.getByType("faction_relation");
  }

  /**
   * 获取 behavior 类型条目
   * 旧接口兼容
   */
  getBehaviors(): EntryList {
    return this.getByType("behavior");
  }

  /**
   * 关键词匹配 causal 类型条目
   * 旧接口: queryCausal(contextKeywords, maxResults)
   */
  queryCausal(contextKeywords: string[], maxResults: number = 3): EntryList {
    return this.search(contextKeywords, undefined, "causal", maxResults)
      .map(s => s.entry);
  }

  /**
   * 关键词匹配 behavior 类型条目
   * 旧接口: queryBehavior(contextKeywords, maxResults)
   */
  queryBehavior(contextKeywords: string[], maxResults: number = 1): EntryList {
    return this.search(contextKeywords, undefined, "behavior", maxResults)
      .map(s => s.entry);
  }

  /**
   * 随机获取 N 条 causal（旧接口兼容）
   */
  randomCausal(n: number = 1): EntryList {
    const causal = this.getByType("causal");
    if (causal.length === 0) return [];
    const result: any[] = [];
    const pool = [...causal];
    for (let i = 0; i < n && pool.length > 0; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      result.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return result;
  }

  /**
   * 标记 causal 已被消费（旧接口 — v18 保持空操作确保兼容）
   */
  private consumedIndices: Set<number> = new Set();
  consumeCausal(_pattern: any) {
    // v18 不做消费跟踪（causal 太多），保留方法签名兼容
    this.consumedIndices.add(this.consumedIndices.size);
  }

  // ============================================================
  // 统计
  // ============================================================

  getStats(): WorldModelStats {
    const byNovel: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byVersion: Record<string, number> = {};

    for (const [n, entries] of this.byNovel) byNovel[n] = entries.length;
    for (const [t, entries] of this.byType) byType[t] = entries.length;
    for (const [v, entries] of this.byVersion) byVersion[v] = entries.length;

    return {
      total: this.entries.length,
      byNovel,
      byType,
      byVersion,
      dndGameRules: this.dndGameRules.length,
      dndMappings: this.dndMappings.length,
      hallucinationRisky: this.hallucinationRisky.length,
    };
  }

  /**
   * 获取指定小说的统计摘要
   */
  getNovelStats(novel: string) {
    const entries = this.getByNovel(novel);
    const byType: Record<string, number> = {};
    for (const e of entries) {
      byType[e.type] = (byType[e.type] || 0) + 1;
    }
    return {
      novel,
      total: entries.length,
      byType,
      dndRules: entries.filter(e => e.game_rule === true || e.game_rule === "true" || typeof e.game_rule === "string").length,
      dndMappings: entries.filter(e => e.dnd_mapping).length,
    };
  }

  private clear() {
    this.entries = EMPTY_ENTRY_LIST;
    this.byNovel = new Map();
    this.byType = new Map();
    this.byNovelAndType = new Map();
    this.byVersion = new Map();
    this.dndGameRules = EMPTY_ENTRY_LIST;
    this.dndMappings = EMPTY_ENTRY_LIST;
    this.hallucinationRisky = EMPTY_ENTRY_LIST;
    this.consumedIndices.clear();
    this.loaded = false;
    this.loadTime = 0;
  }
}

function isValidV18Entry(value: unknown): value is V18Entry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.type === "string" && entry.type.trim().length > 0
    && typeof entry.chapter === "string" && entry.chapter.trim().length > 0;
}

/**
 * A shared model is a reference dataset, not session state. JSON cannot contain
 * cycles, so this stack traversal freezes every parsed object and array exactly
 * once without recursive call-stack growth or per-query cloning.
 */
function freezeJsonEntries(entries: V18Entry[]): void {
  for (const entry of entries) {
    const pending: object[] = [entry];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const value of Object.values(current)) {
        if (value !== null && typeof value === "object") pending.push(value);
      }
      Object.freeze(current);
    }
  }
}

function freezeEntryBuckets(...buckets: V18Entry[][]): void {
  for (const bucket of buckets) Object.freeze(bucket);
}

function freezeIndexBuckets(...indexes: Map<string, V18Entry[]>[]): void {
  for (const index of indexes) {
    for (const bucket of index.values()) Object.freeze(bucket);
  }
}

function sharedPathKey(path: string): string {
  const canonical = resolve(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
