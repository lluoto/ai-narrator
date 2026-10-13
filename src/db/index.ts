/**
 * NPC Store — SQLite 持久化层
 * =============================
 *
 * 功能：
 *   - NPC 人格卡持久化（增删改查）
 *   - NPC 记忆持久化（写入+时序+重要性检索）
 *   - NPC 关系值持久化
 *   - NPC 情绪/状态持久化
 *
 * 依赖：bun:sqlite（Bun 内置，零外部依赖）
 * 数据库文件：data/npc.db（自动创建）
 */

import { Database } from "bun:sqlite";
import type { NPCPersonality, NPCMood, MemoryEntry } from "../agent/types";
import { asNPCMood } from "../agent/types";
import { projectNPCMemoryCache } from "../agent/memory-cache-projection";
import * as fs from "fs";
import * as path from "path";
import {
  createNPCStoreSnapshot,
  NPC_STORE_SNAPSHOT_VERSION,
  validateNPCStoreSnapshot,
  type JsonObject,
  type JsonValue,
  type NPCStoreSnapshot,
} from "./npc-store-snapshot";

export * from "./npc-store-snapshot";

// ============================================================
// 数据库路径
// ============================================================

/**
 * NPC 库的落点。
 *
 * ⚠ 默认是 `data/npc.db` —— 一个 **gitignored 的机器本地文件**。
 *   本机实测它攒了 19 条人格、**33309 条记忆**（都来自真实跑局，
 *   量过：跑一次全量测试行数一行不变，所以不是测试写的）。
 *
 *   问题不在写，在**读**：`NPCAgent.loadMemoriesFromDB()` 会按名字把记忆取回来，
 *   而测试里有 45 处 `new GameSession(...)`，每一处都打开这个库。
 *   于是「我这台机器」和「干净检出」跑的不是同一份数据 ——
 *   与摄取入口躺在 tools/ 里是同一类问题：仓库状态与本机状态分叉。
 *
 *   `NPC_DB_PATH` 就是为了能把这件事**量出来**：指向 `:memory:` 就等于模拟干净检出。
 */
const DEFAULT_DB_PATH = process.env.NPC_DB_PATH || path.join(import.meta.dir, "../../data/npc.db");

// ============================================================
// 表行形状
// ============================================================
//
// 字段名与本文件里的建表语句逐一对应。SQLite 返回的键就是列名原样，
// 此前查询结果一律 as any，列名写错只会在运行时静默取到 undefined ——
// npc_memories 的 scene_id 就是这么空了很久没人发现的。
// 部分查询只取了几列，那些地方用 Pick 而不是整行，避免类型声称有而实际没取。

interface PersonalityRow {
  id: string;
  name: string;
  role: string;
  personality: string;
  background: string;
  speech_style: string;
  goals: string;
  knowledge: string;
  secrets: string;
  attitudes: string;
  ruleset: string;
  traits: string;
  factions: string;
  initial_mood: string;
  created_at: number;
  updated_at: number;
}

interface MemoryRow {
  id: number;
  npc_id: string;
  type: string;
  content: string;
  importance: number;
  timestamp: number;
  scene_id: string;
  related_entities: string;
  is_summary: number;
}

interface RelationshipRow {
  npc_id: string;
  target_name: string;
  relationship: number;
  interaction_count: number;
  last_interaction: number;
}

interface StateRow {
  npc_id: string;
  mood: string;
  relationship: number;
  player_interaction_count: number;
  last_active: number;
}

/** One expected-to-next runtime transition for one NPC. */
export interface NPCStoreRuntimeTransition {
  expected: {
    mood: NPCMood;
    relationship: number;
    interactionCount: number;
  };
  next: {
    mood: NPCMood;
    relationship: number;
    interactionCount: number;
  };
  /** A mood event is optional; ordinary memory appends use their own bounded path. */
  memory?: MemoryEntry;
  /** Detached bounded live-cache candidate sealed before the transaction. */
  memoryCacheCandidate?: readonly MemoryEntry[];
  /** A player relationship contact increments its distinct interaction counter. */
  updatePlayerRelationship: boolean;
}

export interface NPCStoreMemoryAppend {
  npcId: string;
  entry: MemoryEntry;
  /** Opaque host-local identity; never derived from an NPC's public id. */
  receipt: object;
  /** Detached live-cache candidate sealed before this transaction begins. */
  memoryCacheCandidate: readonly MemoryEntry[];
}

export interface NPCStoreMemoryAppendProjection {
  readonly receipt: object;
  readonly memories: readonly MemoryEntry[];
}

interface NPCStoreHostMemoryBatchCapability {
  append(
    entries: readonly NPCStoreMemoryAppend[],
    consumer: {
      begin(): void;
      consume(projection: NPCStoreMemoryAppendProjection): void;
      complete(): void;
    },
  ): void;
}

const npcStoreHostMemoryBatchCapabilities = new WeakMap<NPCStore, NPCStoreHostMemoryBatchCapability>();

/**
 * Lexical host authority for a multi-recipient memory append. It intentionally
 * does not add a public NPCStore writer: AgentRegistry uses this capability
 * after every receiver's live transition has already been planned.
 */
export function appendNPCStoreMemoryBatchForHost(
  store: NPCStore,
  entries: readonly NPCStoreMemoryAppend[],
  consumer: {
    begin(): void;
    consume(projection: NPCStoreMemoryAppendProjection): void;
    complete(): void;
  },
): void {
  const capability = npcStoreHostMemoryBatchCapabilities.get(store);
  if (!capability) throw new Error("NPCStore host memory batch capability is unavailable");
  capability.append(entries, consumer);
}

// 库里存的是裸字符串，取出来要先确认它还在合法取值里再当联合类型用。
// 老库、手改过的库、以及将来改了枚举而没迁移的库都会在这里被挡住 ——
// 直接 as 会把一个不存在的情绪值放进整个系统。
//
// 情绪的校验用 agent/types 里的共享版本：那八个取值已经在三处入口被检查，
// 各自抄一份迟早会漏掉其中一处。
const RULESETS: readonly NonNullable<NPCPersonality["ruleset"]>[] = [
  "cosmic-horror", "dnd5e", "grail",
];
const MEMORY_TYPES: readonly MemoryEntry["type"][] = [
  "observation", "dialogue", "event", "decision",
];

function asRuleset(v: string | null | undefined): NPCPersonality["ruleset"] {
  const r = v as NonNullable<NPCPersonality["ruleset"]>;
  return v && RULESETS.includes(r) ? r : undefined;
}

function asMemoryType(v: string): MemoryEntry["type"] {
  // 建表处有 CHECK 约束兜底，这里只是把它翻译成类型；真出现越界值时
  // 归到 observation 而不是让它继续往下流。
  const t = v as MemoryEntry["type"];
  return MEMORY_TYPES.includes(t) ? t : "observation";
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ============================================================
// NPC Store 类
// ============================================================

export class NPCStore {
  private db: Database;

  constructor(dbPath?: string) {
    const resolved = dbPath ?? DEFAULT_DB_PATH;
    ensureDir(resolved);
    this.db = new Database(resolved);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.initSchema();
    npcStoreHostMemoryBatchCapabilities.set(this, {
      append: (entries, consumer) => this.#appendMemoryBatchWithRetention(entries, consumer),
    });
  }

  /** 关闭数据库连接 */
  close() {
    this.db.close();
  }

  /** 获取底层 Database 实例（供高级查询） */
  get raw() {
    return this.db;
  }

  /** Export a consistent, portable snapshot of every NPC persistence table. */
  exportSnapshot(): NPCStoreSnapshot {
    const snapshot = this.db.transaction(() => {
      const personalities = this.db.query(
        "SELECT * FROM npc_personalities ORDER BY id"
      ).all() as PersonalityRow[];
      const memories = this.db.query(
        "SELECT * FROM npc_memories ORDER BY id"
      ).all() as MemoryRow[];
      const relationships = this.db.query(
        "SELECT * FROM npc_relationships ORDER BY npc_id, target_name"
      ).all() as RelationshipRow[];
      const states = this.db.query(
        "SELECT * FROM npc_states ORDER BY npc_id"
      ).all() as StateRow[];
      const sequence = this.db.query(
        "SELECT seq FROM sqlite_sequence WHERE name = 'npc_memories'"
      ).get() as { seq: number } | null;

      return createNPCStoreSnapshot({
        version: NPC_STORE_SNAPSHOT_VERSION,
        sequences: { npc_memories: sequence?.seq ?? 0 },
        tables: {
          npc_personalities: personalities.map((row) => ({
            id: row.id,
            name: row.name,
            role: row.role,
            personality: row.personality,
            background: row.background,
            speech_style: row.speech_style,
            goals: parseSnapshotJSON<string[]>(row.goals, "npc_personalities.goals"),
            knowledge: parseSnapshotJSON<string[]>(row.knowledge, "npc_personalities.knowledge"),
            secrets: parseSnapshotJSON<string[]>(row.secrets, "npc_personalities.secrets"),
            attitudes: parseSnapshotJSON<Record<string, string>>(row.attitudes, "npc_personalities.attitudes"),
            ruleset: row.ruleset as "" | NonNullable<NPCPersonality["ruleset"]>,
            traits: parseSnapshotJSON<JsonObject>(row.traits, "npc_personalities.traits"),
            factions: parseSnapshotJSON<JsonValue[]>(row.factions, "npc_personalities.factions"),
            initial_mood: row.initial_mood as NPCMood,
            created_at: row.created_at,
            updated_at: row.updated_at,
          })),
          npc_memories: memories.map((row) => ({
            id: row.id,
            npc_id: row.npc_id,
            type: row.type as MemoryEntry["type"],
            content: row.content,
            importance: row.importance,
            timestamp: row.timestamp,
            scene_id: row.scene_id,
            related_entities: parseSnapshotJSON<string[]>(row.related_entities, "npc_memories.related_entities"),
            is_summary: row.is_summary as 0 | 1,
          })),
          npc_relationships: relationships.map((row) => ({
            npc_id: row.npc_id,
            target_name: row.target_name,
            relationship: row.relationship,
            interaction_count: row.interaction_count,
            last_interaction: row.last_interaction,
          })),
          npc_states: states.map((row) => ({
            npc_id: row.npc_id,
            mood: row.mood as NPCMood,
            relationship: row.relationship,
            player_interaction_count: row.player_interaction_count,
            last_active: row.last_active,
          })),
        },
      });
    })();
    return structuredClone(snapshot);
  }

  /** Validate first, then atomically replace all NPC persistence tables. */
  restoreSnapshot(snapshot: unknown): void {
    const checked = validateNPCStoreSnapshot(snapshot);
    const restore = this.db.transaction(() => {
      // Delete child rows before personalities so replacement also works with FK enforcement enabled.
      this.db.run("DELETE FROM npc_memories");
      this.db.run("DELETE FROM npc_relationships");
      this.db.run("DELETE FROM npc_states");
      this.db.run("DELETE FROM npc_personalities");

      const insertPersonality = this.db.prepare(`
        INSERT INTO npc_personalities (
          id, name, role, personality, background, speech_style, goals, knowledge,
          secrets, attitudes, ruleset, traits, factions, initial_mood, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      try {
        for (const row of checked.tables.npc_personalities) {
          insertPersonality.run(
            row.id, row.name, row.role, row.personality, row.background, row.speech_style,
            JSON.stringify(row.goals), JSON.stringify(row.knowledge), JSON.stringify(row.secrets),
            JSON.stringify(row.attitudes), row.ruleset, JSON.stringify(row.traits), JSON.stringify(row.factions),
            row.initial_mood, row.created_at, row.updated_at,
          );
        }
      } finally {
        insertPersonality.finalize();
      }

      const insertMemory = this.db.prepare(`
        INSERT INTO npc_memories (
          id, npc_id, type, content, importance, timestamp, scene_id, related_entities, is_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      try {
        for (const row of checked.tables.npc_memories) {
          insertMemory.run(
            row.id, row.npc_id, row.type, row.content, row.importance, row.timestamp,
            row.scene_id, JSON.stringify(row.related_entities), row.is_summary,
          );
        }
      } finally {
        insertMemory.finalize();
      }

      const insertRelationship = this.db.prepare(`
        INSERT INTO npc_relationships (
          npc_id, target_name, relationship, interaction_count, last_interaction
        ) VALUES (?, ?, ?, ?, ?)
      `);
      try {
        for (const row of checked.tables.npc_relationships) {
          insertRelationship.run(
            row.npc_id, row.target_name, row.relationship, row.interaction_count, row.last_interaction,
          );
        }
      } finally {
        insertRelationship.finalize();
      }

      const insertState = this.db.prepare(`
        INSERT INTO npc_states (
          npc_id, mood, relationship, player_interaction_count, last_active
        ) VALUES (?, ?, ?, ?, ?)
      `);
      try {
        for (const row of checked.tables.npc_states) {
          insertState.run(
            row.npc_id, row.mood, row.relationship, row.player_interaction_count, row.last_active,
          );
        }
      } finally {
        insertState.finalize();
      }

      // The AUTOINCREMENT high-water mark is not inferred from surviving rows.
      this.db.run("DELETE FROM sqlite_sequence WHERE name = 'npc_memories'");
      this.db.run(
        "INSERT INTO sqlite_sequence (name, seq) VALUES ('npc_memories', ?)",
        [checked.sequences.npc_memories],
      );
    });
    restore();
  }

  // ============================================================
  // Schema
  // ============================================================

  private initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS npc_personalities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        personality TEXT DEFAULT '',
        background TEXT DEFAULT '',
        speech_style TEXT DEFAULT '',
        goals TEXT DEFAULT '[]',
        knowledge TEXT DEFAULT '[]',
        secrets TEXT DEFAULT '[]',
        attitudes TEXT DEFAULT '{}',
        ruleset TEXT DEFAULT '',
        traits TEXT DEFAULT '{}',
        factions TEXT DEFAULT '[]',
        initial_mood TEXT DEFAULT 'neutral',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS npc_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        npc_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('observation','dialogue','event','decision')),
        content TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 5,
        timestamp INTEGER NOT NULL,
        scene_id TEXT DEFAULT '',
        related_entities TEXT DEFAULT '[]',
        is_summary INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (npc_id) REFERENCES npc_personalities(id) ON DELETE CASCADE
      )
    `);
    // 按 NPC+时间排序的索引
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_memories_npc_time
        ON npc_memories(npc_id, timestamp DESC)
    `);
    // 按重要性检索的索引（用于记忆裁剪）
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_memories_importance
        ON npc_memories(npc_id, importance DESC)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS npc_relationships (
        npc_id TEXT NOT NULL,
        target_name TEXT NOT NULL,
        relationship REAL NOT NULL DEFAULT 0,
        interaction_count INTEGER NOT NULL DEFAULT 0,
        last_interaction INTEGER DEFAULT 0,
        PRIMARY KEY (npc_id, target_name),
        FOREIGN KEY (npc_id) REFERENCES npc_personalities(id) ON DELETE CASCADE
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS npc_states (
        npc_id TEXT PRIMARY KEY,
        mood TEXT NOT NULL DEFAULT 'neutral',
        relationship REAL NOT NULL DEFAULT 0,
        player_interaction_count INTEGER NOT NULL DEFAULT 0,
        last_active INTEGER DEFAULT 0,
        FOREIGN KEY (npc_id) REFERENCES npc_personalities(id) ON DELETE CASCADE
      )
    `);
  }

  // ============================================================
  // NPC 人格卡
  // ============================================================

  /** 保存/更新 NPC 人格卡 */
  savePersonality(npc: NPCPersonality): void {
    const now = Date.now();
    const id = npc.name; // name 作为主键
    this.db.run(
      `INSERT INTO npc_personalities
       (id, name, role, personality, background, speech_style,
        goals, knowledge, secrets, attitudes, ruleset, traits, factions,
        initial_mood, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM npc_personalities WHERE id=?), ?), ?)
       ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, role=excluded.role, personality=excluded.personality,
        background=excluded.background, speech_style=excluded.speech_style,
        goals=excluded.goals, knowledge=excluded.knowledge, secrets=excluded.secrets,
        attitudes=excluded.attitudes, ruleset=excluded.ruleset, traits=excluded.traits,
        factions=excluded.factions, initial_mood=excluded.initial_mood,
        updated_at=excluded.updated_at`,
      [
        id, npc.name, npc.role, npc.personality ?? "", npc.background ?? "",
        npc.speech_style ?? "",
        JSON.stringify(npc.goals ?? []),
        JSON.stringify(npc.knowledge ?? []),
        JSON.stringify(npc.secrets ?? []),
        JSON.stringify(npc.attitudes ?? {}),
        npc.ruleset ?? "",
        JSON.stringify(npc.traits ?? {}),
        JSON.stringify(npc.factions ?? []),
        npc.initialMood ?? "neutral",
        // COALESCE first binds the existing-row lookup id, then the new
        // created_at value.  Reversing these wrote an NPC name into the
        // INTEGER timestamp column, which made an otherwise valid store
        // impossible to snapshot.
        id, now, now,
      ]
    );
  }

  /** 获取所有 NPC 人格卡 */
  getAllPersonalities(): NPCPersonality[] {
    const rows = this.db.query("SELECT * FROM npc_personalities").all() as PersonalityRow[];
    return rows.map(rowToPersonality);
  }

  /** 按 ID 获取 NPC 人格卡 */
  getPersonality(id: string): NPCPersonality | null {
    const row = this.db.query("SELECT * FROM npc_personalities WHERE id = ?").get(id) as PersonalityRow | null;
    return row ? rowToPersonality(row) : null;
  }

  /** 删除 NPC 人格卡（级联删除记忆、关系） */
  deletePersonality(id: string): void {
    this.db.run("DELETE FROM npc_personalities WHERE id = ?", [id]);
  }

  // ============================================================
  // NPC 记忆
  // ============================================================

  /** 写入一条记忆 */
  addMemory(npcId: string, entry: MemoryEntry): void {
    this.#insertMemory(npcId, entry);
  }

  /**
   * Append one memory and apply the established durable retention policy as
   * one SQLite transaction. This write authority is intentionally excluded
   * from the GameSession NPCStore read facade.
   */
  appendMemoryWithRetention(
    npcId: string,
    entry: MemoryEntry,
    memoryCacheCandidate: readonly MemoryEntry[] = [entry],
  ): readonly MemoryEntry[] {
    const append = this.db.transaction(() => {
      return this.#appendMemoryWithRetention(npcId, entry, memoryCacheCandidate);
    });
    return append();
  }

  /**
   * Commit one complete single-NPC runtime transition. The durable pre-state
   * is checked inside this same transaction before any memory, relationship,
   * or state row can change. This writer is intentionally excluded from the
   * GameSession NPCStore read facade.
  */
  commitRuntimeTransition(npcId: string, transition: NPCStoreRuntimeTransition): readonly MemoryEntry[] | undefined {
    const commit = this.db.transaction(() => {
      this.#assertRuntimeTransitionPreState(npcId, transition);
      const memoryProjection = transition.memory === undefined
        ? undefined
        : this.#appendMemoryWithRetention(
          npcId,
          transition.memory,
          transition.memoryCacheCandidate ?? [transition.memory],
        );
      if (transition.updatePlayerRelationship) this.#upsertPlayerRelationship(npcId, transition.next.relationship);
      this.#upsertState(npcId, transition.next.mood, transition.next.relationship, transition.next.interactionCount);
      return memoryProjection;
    });
    return commit();
  }

  #assertRuntimeTransitionPreState(npcId: string, transition: NPCStoreRuntimeTransition): void {
    const state = this.db.query(
      "SELECT mood, relationship, player_interaction_count FROM npc_states WHERE npc_id = ?",
    ).get(npcId) as Pick<StateRow, "mood" | "relationship" | "player_interaction_count"> | null;
    const expected = transition.expected;
    if (state !== null) {
      if (state.mood !== expected.mood
        || state.relationship !== expected.relationship
        || state.player_interaction_count !== expected.interactionCount) {
        throw new Error(`NPC runtime transition pre-state disagrees for ${npcId}`);
      }
    } else {
      const personality = this.db.query(
        "SELECT initial_mood FROM npc_personalities WHERE id = ?",
      ).get(npcId) as Pick<PersonalityRow, "initial_mood"> | null;
      const initialMood = personality === null ? undefined : (asNPCMood(personality.initial_mood) ?? "neutral");
      if (expected.relationship !== 0 || expected.interactionCount !== 0
        || (initialMood !== undefined && expected.mood !== initialMood)) {
        throw new Error(`NPC runtime transition pre-state disagrees for ${npcId}`);
      }
    }

    const relationship = this.db.query(
      "SELECT relationship FROM npc_relationships WHERE npc_id = ? AND target_name = 'player'",
    ).get(npcId) as Pick<RelationshipRow, "relationship"> | null;
    if (relationship === null) {
      if (expected.relationship !== 0) {
        throw new Error(`NPC runtime transition pre-state disagrees for ${npcId}`);
      }
    } else if (relationship.relationship !== expected.relationship) {
      throw new Error(`NPC runtime transition pre-state disagrees for ${npcId}`);
    }
  }

  #appendMemoryWithRetention(
    npcId: string,
    entry: MemoryEntry,
    memoryCacheCandidate: readonly MemoryEntry[],
  ): readonly MemoryEntry[] {
    this.#insertMemory(npcId, entry);
    if (this.#countMemories(npcId) > 200) this.#pruneMemories(npcId, 100);
    // This read/validation happens within the same transaction as INSERT and
    // retention DELETE.  A malformed durable row or projection error aborts
    // the whole change; callers receive a detached publication value only
    // after the transaction commits.
    return projectNPCMemoryCache(memoryCacheCandidate, this.#readRetainedMemories(npcId));
  }

  #appendMemoryBatchWithRetention(
    entries: readonly NPCStoreMemoryAppend[],
    consumer: {
      begin(): void;
      consume(projection: NPCStoreMemoryAppendProjection): void;
      complete(): void;
    },
  ): void {
    const append = this.db.transaction(() => {
      if (!consumer || typeof consumer.begin !== "function" || typeof consumer.consume !== "function"
        || typeof consumer.complete !== "function") {
        throw new Error("NPCStore host memory batch projection consumer is invalid");
      }
      const receipts = new Set<object>();
      for (const entry of entries) {
        if (!entry.receipt || typeof entry.receipt !== "object" || receipts.has(entry.receipt)) {
          throw new Error("NPCStore host memory batch receipts must be unique opaque objects");
        }
        if (!Array.isArray(entry.memoryCacheCandidate)) {
          throw new Error("NPCStore host memory batch cache candidate is invalid");
        }
        receipts.add(entry.receipt);
      }
      // The host uses begin() to allocate and validate its receipt-to-plan
      // binding. It must happen inside this callback before any write, so a
      // failure has exactly the same rollback boundary as a failed bind.
      consumer.begin();
      const projections: NPCStoreMemoryAppendProjection[] = [];
      for (const entry of entries) {
        projections.push(Object.freeze({
          receipt: entry.receipt,
          memories: this.#appendMemoryWithRetention(
            entry.npcId,
            entry.entry,
            entry.memoryCacheCandidate,
          ),
        }));
      }
      for (const projection of projections) consumer.consume(projection);
      // Both the per-receipt binding and its all-receipts completeness proof
      // execute before COMMIT. A throw here rolls back INSERT, retention
      // DELETE, sqlite_sequence, and every pending plan binding together.
      consumer.complete();
    });
    append();
  }

  #readRetainedMemories(npcId: string): MemoryEntry[] {
    const rows = this.db.query(
      "SELECT * FROM npc_memories WHERE npc_id = ? ORDER BY id ASC",
    ).all(npcId) as MemoryRow[];
    return rows.map((row) => this.#validatedRetainedMemory(row));
  }

  #validatedRetainedMemory(row: MemoryRow): MemoryEntry {
    if (!MEMORY_TYPES.includes(row.type as MemoryEntry["type"])
      || !Number.isFinite(row.timestamp)
      || !Number.isFinite(row.importance)
      || typeof row.content !== "string"
      || typeof row.scene_id !== "string"
      || (row.is_summary !== 0 && row.is_summary !== 1)) {
      throw new Error("NPC durable memory retention projection is invalid");
    }
    let relatedEntities: unknown;
    try {
      relatedEntities = JSON.parse(row.related_entities);
    } catch {
      throw new Error("NPC durable memory retention projection is invalid");
    }
    if (!Array.isArray(relatedEntities) || relatedEntities.some((entity) => typeof entity !== "string")) {
      throw new Error("NPC durable memory retention projection is invalid");
    }
    return {
      timestamp: row.timestamp,
      type: row.type as MemoryEntry["type"],
      content: row.content,
      importance: row.importance,
      ...(row.scene_id === "" ? {} : { scene_id: row.scene_id }),
      ...(relatedEntities.length === 0 ? {} : { related_entities: relatedEntities }),
      ...(row.is_summary === 1 ? { is_summary: true } : {}),
    };
  }

  #upsertPlayerRelationship(npcId: string, relationship: number): void {
    this.db.run(
      `INSERT INTO npc_relationships (npc_id, target_name, relationship, interaction_count, last_interaction)
       VALUES (?, 'player', ?, 1, ?)
       ON CONFLICT(npc_id, target_name) DO UPDATE SET
        relationship = excluded.relationship,
        interaction_count = interaction_count + 1,
        last_interaction = excluded.last_interaction`,
      [npcId, relationship, Date.now()],
    );
  }

  #insertMemory(npcId: string, entry: MemoryEntry): void {
    this.db.run(
      `INSERT INTO npc_memories (npc_id, type, content, importance, timestamp, scene_id, related_entities, is_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        npcId, entry.type, entry.content, entry.importance, entry.timestamp,
        entry.scene_id ?? "",
        JSON.stringify(entry.related_entities ?? []),
        entry.is_summary ? 1 : 0,
      ]
    );
  }

  /** 批量写入记忆 */
  addMemories(npcId: string, entries: MemoryEntry[]): void {
    const insert = this.db.prepare(
      `INSERT INTO npc_memories (npc_id, type, content, importance, timestamp, scene_id, related_entities, is_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction(() => {
      for (const e of entries) {
        insert.run(
          npcId, e.type, e.content, e.importance, e.timestamp,
          e.scene_id ?? "",
          JSON.stringify(e.related_entities ?? []),
          e.is_summary ? 1 : 0,
        );
      }
    });
    try {
      tx();
    } finally {
      insert.finalize();
    }
  }

  /** 获取 NPC 最近记忆（按时间倒序，limit 控制条数） */
  getRecentMemories(npcId: string, limit = 50): MemoryEntry[] {
    const rows = this.db.query(
      `SELECT * FROM npc_memories WHERE npc_id = ? ORDER BY timestamp DESC LIMIT ?`
    ).all(npcId, limit) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  /** 获取 NPC 高重要性记忆（用于裁剪时保留） */
  getImportantMemories(npcId: string, minImportance = 7, limit = 30): MemoryEntry[] {
    const rows = this.db.query(
      `SELECT * FROM npc_memories WHERE npc_id = ? AND importance >= ? ORDER BY importance DESC LIMIT ?`
    ).all(npcId, minImportance, limit) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  /** 获取 NPC 在特定场景中的记忆 */
  getSceneMemories(npcId: string, sceneId: string, limit = 20): MemoryEntry[] {
    const rows = this.db.query(
      `SELECT * FROM npc_memories WHERE npc_id = ? AND scene_id = ? ORDER BY timestamp DESC LIMIT ?`
    ).all(npcId, sceneId, limit) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  /** 检索 NPC 记忆（关键词匹配 content） */
  searchMemories(npcId: string, keyword: string, limit = 20): MemoryEntry[] {
    const rows = this.db.query(
      `SELECT * FROM npc_memories WHERE npc_id = ? AND content LIKE ? ORDER BY timestamp DESC LIMIT ?`
    ).all(npcId, `%${keyword}%`, limit) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  #pruneMemories(npcId: string, keepTop: number): number {
    // 获取第 keepTop 条的重要性阈值
    const threshold = this.db.query(
      `SELECT importance FROM npc_memories WHERE npc_id = ? ORDER BY importance DESC LIMIT 1 OFFSET ?`
    ).get(npcId, keepTop - 1) as Pick<MemoryRow, "importance"> | null;
    if (!threshold) return 0;
    // 删除低于该重要性且非 summary 的记忆
    const result = this.db.run(
      `DELETE FROM npc_memories WHERE npc_id = ? AND importance < ? AND is_summary = 0`,
      [npcId, threshold.importance]
    );
    return result.changes;
  }

  /** 获取 NPC 记忆总数 */
  countMemories(npcId: string): number {
    return this.#countMemories(npcId);
  }

  #countMemories(npcId: string): number {
    const row = this.db.query("SELECT COUNT(*) as cnt FROM npc_memories WHERE npc_id = ?").get(npcId) as { cnt: number } | null;
    return row?.cnt ?? 0;
  }

  // ============================================================
  // NPC 关系
  // ============================================================

  /** 获取关系值 */
  getRelationship(npcId: string, targetName: string): number {
    const row = this.db.query(
      "SELECT relationship FROM npc_relationships WHERE npc_id = ? AND target_name = ?"
    ).get(npcId, targetName) as Pick<RelationshipRow, "relationship"> | null;
    return row?.relationship ?? 0;
  }

  /** 更新关系值 */
  updateRelationship(npcId: string, targetName: string, delta: number): number {
    const current = this.getRelationship(npcId, targetName);
    const newVal = Math.max(-5, Math.min(5, current + delta));
    this.db.run(
      `INSERT INTO npc_relationships (npc_id, target_name, relationship, interaction_count, last_interaction)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(npc_id, target_name) DO UPDATE SET
        relationship = excluded.relationship,
        interaction_count = interaction_count + 1,
        last_interaction = excluded.last_interaction`,
      [npcId, targetName, newVal, Date.now()]
    );
    return newVal;
  }

  /** 获取所有关系 */
  getAllRelationships(npcId: string): Array<{ targetName: string; relationship: number; interactionCount: number }> {
    const rows = this.db.query(
      "SELECT target_name, relationship, interaction_count FROM npc_relationships WHERE npc_id = ? ORDER BY relationship DESC"
    ).all(npcId) as Array<Pick<RelationshipRow, "target_name" | "relationship" | "interaction_count">>;
    return rows.map(r => ({
      targetName: r.target_name,
      relationship: r.relationship,
      interactionCount: r.interaction_count,
    }));
  }

  // ============================================================
  // NPC 状态
  // ============================================================

  /** 获取 NPC 当前状态 */
  getState(npcId: string): { mood: NPCMood; relationship: number; interactionCount: number } | null {
    const row = this.db.query("SELECT * FROM npc_states WHERE npc_id = ?").get(npcId) as StateRow | null;
    if (!row) return null;
    return {
      // 库里存的是裸字符串；越界值退回 neutral，不让它冒充成合法情绪往下走
      mood: asNPCMood(row.mood) ?? "neutral",
      relationship: row.relationship,
      interactionCount: row.player_interaction_count,
    };
  }

  /** 更新 NPC 状态 */
  updateState(npcId: string, mood: NPCMood, relationship: number, interactionCount: number): void {
    this.#upsertState(npcId, mood, relationship, interactionCount);
  }

  #upsertState(npcId: string, mood: NPCMood, relationship: number, interactionCount: number): void {
    this.db.run(
      `INSERT INTO npc_states (npc_id, mood, relationship, player_interaction_count, last_active)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(npc_id) DO UPDATE SET
        mood=excluded.mood, relationship=excluded.relationship,
        player_interaction_count=excluded.player_interaction_count,
        last_active=excluded.last_active`,
      [npcId, mood, relationship, interactionCount, Date.now()]
    );
  }
}

// ============================================================
// 行 → 对象 转换函数
// ============================================================

function rowToPersonality(row: PersonalityRow): NPCPersonality {
  return {
    name: row.name,
    role: row.role,
    personality: row.personality,
    background: row.background,
    speech_style: row.speech_style,
    goals: safeJSONParse(row.goals, []),
    knowledge: safeJSONParse(row.knowledge, []),
    secrets: safeJSONParse(row.secrets, []),
    attitudes: safeJSONParse(row.attitudes, {}),
    ruleset: asRuleset(row.ruleset),
    traits: safeJSONParse(row.traits, undefined),
    factions: safeJSONParse(row.factions, undefined),
    initialMood: asNPCMood(row.initial_mood),
  };
}

function rowToMemory(row: MemoryRow): MemoryEntry {
  return {
    timestamp: row.timestamp,
    type: asMemoryType(row.type),
    content: row.content,
    importance: row.importance,
    scene_id: row.scene_id || undefined,
    related_entities: safeJSONParse(row.related_entities, undefined),
    is_summary: row.is_summary === 1,
  };
}

function parseSnapshotJSON<T>(serialized: string, field: string): T {
  try {
    return JSON.parse(serialized) as T;
  } catch {
    throw new Error(`Cannot export NPC store snapshot: ${field} contains invalid JSON`);
  }
}

function safeJSONParse(str: string | undefined, fallback: any): any {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}
