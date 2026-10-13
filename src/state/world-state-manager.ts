// 世界状态管理器 — Bun 原生 SQLite 真相源
// LLM 只看不写。所有状态变更走律书代码路径。

import { Database } from "bun:sqlite";
import { createSchema } from "./schema";
import type { GameEvent } from "./event-types";
import type { WorldEntity, WorldState, Effect, CombatResult, PlayerRuntimeState } from "../types";
import type { SanityState } from "../rules/coc-engine";
import { log } from "../log";
import {
  createWorldStateSnapshot,
  validateWorldStateSnapshot,
  type WorldStateSnapshot,
} from "./world-state-snapshot";
// 读写两层共用的**唯一一份** exits 解析。别再各写一份 —— 见该文件顶部。
import { parseExits, type ExitRecord } from "./scene-exits";
export type { SightedEntity } from "./scene-exits";

/**
 * 场景出口。模组写入的是对象（目标场景 + 展示用描述），不是裸字符串。
 *
 * 形状与解析都在 `state/scene-exits.ts`，读写两层共用 ——
 * 这里只做只读别名，免得同一个概念在两个文件里各声明一次然后慢慢分叉。
 * `SightedEntity`（站在出发场景就望得见的叙事实体，由 module-loader 挂到出口上）
 * 同样从那边转出。
 */
type SceneExit = Readonly<ExitRecord>;

/** 一条场景记录。scenes 表的对外形状，getScene() 与 listScenes() 共用。 */
interface SceneRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly lighting: string | null;
  readonly dangers: string[];
  readonly exits: SceneExit[];
}

// ============================================================
// 世界状态管理器
// ============================================================

export class WorldStateManager {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    const db = new Database(dbPath, { create: true });
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      createSchema(db);
      this.db = db;
    } catch (error) {
      try {
        db.close(true);
      } catch {
        // Keep the schema failure as the diagnostic; close is only cleanup.
        db.close();
      }
      throw error;
    }
  }

  /**
   * The live round is a durable singleton, not a process-local cache. Snapshot
   * retention is allowed to remove historical rows, so callers must never
   * derive this value from `snapshots` after schema initialization.
   */
  private readDurableCurrentRound(): number {
    const statement = this.db.query(`
      SELECT current_round, typeof(current_round) AS current_round_type
      FROM world_state_metadata
      WHERE singleton = 1
    `);
    let row: { current_round: unknown; current_round_type: unknown } | null;
    try {
      row = statement.get() as { current_round: unknown; current_round_type: unknown } | null;
    } finally {
      statement.finalize();
    }
    if (
      row?.current_round_type !== "integer"
      || typeof row.current_round !== "number"
      || !Number.isSafeInteger(row.current_round)
      || row.current_round < 0
    ) {
      throw new Error("Durable current round metadata is missing or invalid");
    }
    return row.current_round;
  }

  private writeDurableCurrentRound(round: number): void {
    if (!Number.isSafeInteger(round) || round < 0) {
      throw new RangeError("World snapshot round must be a non-negative safe integer");
    }
    const result = this.db.run(
      "UPDATE world_state_metadata SET current_round = ? WHERE singleton = 1",
      [round],
    );
    if (result.changes !== 1 || this.readDurableCurrentRound() !== round) {
      throw new Error("Durable current round metadata failed to persist");
    }
  }

  // ==========================================================
  // 实体操作
  // ==========================================================

  getEntity(id: string): WorldEntity | null {
    const row: any = this.db
      .query("SELECT * FROM entities WHERE id = ?")
      .get(id);
    if (!row) return null;
    return this.rowToEntity(row);
  }

  getEntityByName(name: string): WorldEntity | null {
    // 先精确匹配
    let row: any = this.db
      .query("SELECT * FROM entities WHERE name = ? AND alive = 1 LIMIT 1")
      .get(name);
    if (row) return this.rowToEntity(row);

    // 模糊匹配：name 包含输入词，或输入词包含 name
    const rows: any[] = this.db
      .query("SELECT * FROM entities WHERE alive = 1 AND (name LIKE ? OR ? LIKE ('%' || name || '%'))")
      .all(`%${name}%`, name);
    if (rows.length > 0) return this.rowToEntity(rows[0]);

    return null;
  }

  upsertEntity(entity: Partial<WorldEntity> & { id: string; name: string; type: WorldEntity["type"] }) {
    // The optional fields are a partial-update contract. Do not first read
    // their fallback values into JavaScript: another connection can commit a
    // damage/status/scene update between that read and a later UPDATE. SQLite
    // chooses the current value for each omitted field in this one statement.
    // `null` and `undefined` intentionally retain the previous `??` behavior;
    // falsy values such as 0, "", [], and {} are explicit updates.
    const provided = (value: unknown): number => value === null || value === undefined ? 0 : 1;
    this.db.run(
      `INSERT INTO entities (id,name,type,hp,max_hp,ac,status,position,faction,attributes,scene_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,
         type=excluded.type,
         hp=CASE WHEN ?12 THEN excluded.hp ELSE hp END,
         max_hp=CASE WHEN ?13 THEN excluded.max_hp ELSE max_hp END,
         ac=CASE WHEN ?14 THEN excluded.ac ELSE ac END,
         status=CASE WHEN ?15 THEN excluded.status ELSE status END,
         position=CASE WHEN ?16 THEN excluded.position ELSE position END,
         faction=CASE WHEN ?17 THEN excluded.faction ELSE faction END,
         attributes=CASE WHEN ?18 THEN excluded.attributes ELSE attributes END,
         scene_id=CASE WHEN ?19 THEN excluded.scene_id ELSE scene_id END,
         alive=1,
         updated_at=unixepoch()`,
      [
        entity.id,
        entity.name,
        entity.type,
        entity.hp ?? 0,
        entity.maxHp ?? entity.hp ?? 1,
        entity.ac ?? 10,
        JSON.stringify(entity.status ?? []),
        entity.position ?? "unknown",
        entity.faction ?? null,
        JSON.stringify(entity.attributes ?? {}),
        entity.scene_id ?? null,
        provided(entity.hp),
        provided(entity.maxHp),
        provided(entity.ac),
        provided(entity.status),
        provided(entity.position),
        provided(entity.faction),
        provided(entity.attributes),
        provided(entity.scene_id),
      ],
    );
  }

  applyDamage(entityId: string, damage: number): { killed: boolean; remainingHp: number } {
    return this.db.transaction(() => {
      const entity = this.getEntity(entityId);
      if (!entity) throw new Error(`Entity not found: ${entityId}`);

      const newHp = Math.max(0, entity.hp - damage);
      this.db.run("UPDATE entities SET hp=?1, updated_at=unixepoch() WHERE id=?2", [newHp, entityId]);

      if (newHp <= 0) {
        this.db.run("UPDATE entities SET alive=0, status='[\"dead\"]' WHERE id=?", [entityId]);
      }

      const persisted = this.db
        .query("SELECT hp, alive, status FROM entities WHERE id = ?")
        .get(entityId) as { hp: number; alive: number; status: string } | null;
      if (
        persisted?.hp !== newHp ||
        (newHp <= 0 && (persisted.alive !== 0 || persisted.status !== '[\"dead\"]'))
      ) {
        throw new Error(`Damage state failed to persist for ${entityId}`);
      }

      return { killed: newHp <= 0, remainingHp: newHp };
    })();
  }

  killEntity(entityId: string) {
    this.db.run(
      "UPDATE entities SET hp=0, alive=0, status='[\"dead\"]', updated_at=unixepoch() WHERE id=?",
      [entityId]
    );
  }

  getEntitiesInScene(sceneId: string): WorldEntity[] {
    const rows: any[] = this.db
      .query("SELECT * FROM entities WHERE scene_id = ? AND alive = 1")
      .all(sceneId);
    return rows.map((r) => this.rowToEntity(r));
  }

  getAllAliveEntities(): WorldEntity[] {
    const statement = this.db.query("SELECT * FROM entities WHERE alive = 1");
    try {
      const rows = statement.all() as any[];
      return rows.map((r) => this.rowToEntity(r));
    } finally {
      statement.finalize();
    }
  }

  seedEntities(entities: Array<Partial<WorldEntity> & { id: string; name: string; type: WorldEntity["type"] }>) {
    const insertStmt = this.db.query(
      `INSERT OR REPLACE INTO entities (id,name,type,hp,max_hp,ac,status,position,faction,scene_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`
    );
    this.db.transaction((entities) => {
      for (const e of entities) {
        insertStmt.run(
          e.id, e.name, e.type,
          e.hp ?? 1, e.maxHp ?? e.hp ?? 1, e.ac ?? 10,
          JSON.stringify(e.status ?? []),
          e.position ?? "unknown",
          e.faction ?? null,
          e.scene_id ?? null
        );
      }
    })(entities);
  }

  // ==========================================================
  // 玩家运行时状态 — SAN / 背包 / 已装备武器 / 已装备护甲
  //
  // 这四类此前是 GameSession 的进程内 Map。放在这里之后，写入即落库，
  // getCurrentState() 才拿得到完整快照。读取每次都从库里重新解析，
  // 因此调用方拿到的数组是副本，改它不会穿透到真相源。
  // ==========================================================

  /** 确保玩家在真相源中有一行。已存在则保持原值。 */
  registerPlayer(playerId: string) {
    this.db.run("INSERT OR IGNORE INTO player_state (entity_id) VALUES (?)", [playerId]);
  }

  getPlayerIds(): string[] {
    const statement = this.db.query("SELECT entity_id FROM player_state ORDER BY entity_id");
    try {
      const rows = statement.all() as any[];
      return rows.map((r) => r.entity_id as string);
    } finally {
      statement.finalize();
    }
  }

  getPlayerState(playerId: string): PlayerRuntimeState | null {
    const statement = this.db.query("SELECT sanity, inventory, weapons, armor FROM player_state WHERE entity_id = ?");
    try {
      const row = statement.get(playerId) as any;
      if (!row) return null;
      return {
        sanity: this.parseJsonColumn<SanityState | null>(row.sanity, null),
        inventory: this.parseJsonColumn<string[]>(row.inventory, []),
        weapons: this.parseJsonColumn<string[]>(row.weapons, []),
        armor: this.parseJsonColumn<string[]>(row.armor, []),
      };
    } finally {
      statement.finalize();
    }
  }

  getPlayerSanity(playerId: string): SanityState | null {
    return this.getPlayerState(playerId)?.sanity ?? null;
  }

  setPlayerSanity(playerId: string, sanity: Readonly<SanityState>) {
    this.writePlayerColumn(playerId, "sanity", JSON.stringify(sanity));
  }

  getPlayerInventory(playerId: string): string[] {
    return this.getPlayerState(playerId)?.inventory ?? [];
  }

  setPlayerInventory(playerId: string, items: string[]) {
    this.writePlayerColumn(playerId, "inventory", JSON.stringify(items));
  }

  getPlayerWeapons(playerId: string): string[] {
    return this.getPlayerState(playerId)?.weapons ?? [];
  }

  setPlayerWeapons(playerId: string, weapons: string[]) {
    this.writePlayerColumn(playerId, "weapons", JSON.stringify(weapons));
  }

  getPlayerArmor(playerId: string): string[] {
    return this.getPlayerState(playerId)?.armor ?? [];
  }

  setPlayerArmor(playerId: string, armor: string[]) {
    this.writePlayerColumn(playerId, "armor", JSON.stringify(armor));
  }

  // ==========================================================
  // 线索发现 / 场景访问历史 —— 按玩家，累计，从不清空
  //
  // 这两类此前分别停在 InvestigationEngine 的进程内 Map（discovered）和
  // 完全没有追踪（GameSession 侧场景访问史，见 docs/todo.json todo-03/todo-26）。
  // 归入真相源后才有单一权威：队伍视图（任一人发现/到过）从这里推导，
  // 不能反过来——按玩家的记录才是权威，队伍视图只是聚合查询。
  // ==========================================================

  /** 记一次线索发现。同一 (player, clue) 重复记录是幂等的（INSERT OR IGNORE）。 */
  recordClueDiscovery(playerId: string, clueId: string) {
    this.db.run(
      "INSERT OR IGNORE INTO clue_discoveries (player_id, clue_id) VALUES (?1,?2)",
      [playerId, clueId],
    );
  }

  isClueDiscoveredBy(playerId: string, clueId: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM clue_discoveries WHERE player_id=?1 AND clue_id=?2 LIMIT 1")
      .get(playerId, clueId);
  }

  getCluesDiscoveredBy(playerId: string): string[] {
    const rows: any[] = this.db
      .query("SELECT clue_id FROM clue_discoveries WHERE player_id=?1 ORDER BY discovered_at")
      .all(playerId);
    return rows.map((r) => r.clue_id as string);
  }

  /** 队伍里任一人是否发现过这条线索——结局条件（isClueFound）用这个。 */
  isClueDiscoveredByAnyone(clueId: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM clue_discoveries WHERE clue_id=?1 LIMIT 1")
      .get(clueId);
  }

  /**
   * 记一次线索检定失败，返回累计失败次数（开发·线索闸门 任务4）。
   * 与 src/world/state.ts 的 WorldState.incrementClueFail 同一语义
   * （按 clue_id 计数，不分玩家），真相源从进程内 Map 换成这张表。
   */
  incrementClueFail(clueId: string): number {
    const row = this.db.query(
      `INSERT INTO clue_fail_counts (clue_id, fail_count) VALUES (?1, 1)
       ON CONFLICT(clue_id) DO UPDATE SET fail_count = fail_count + 1, updated_at = unixepoch()
       RETURNING fail_count`,
    ).get(clueId) as { fail_count: number } | null;
    if (!row || !Number.isSafeInteger(row.fail_count) || row.fail_count < 1) {
      throw new Error(`Clue fail increment did not return a valid durable count for ${clueId}`);
    }
    return row.fail_count;
  }

  /** 查询某线索累计失败次数。 */
  getClueFailCount(clueId: string): number {
    const row = this.db.query("SELECT fail_count FROM clue_fail_counts WHERE clue_id=?1").get(clueId) as { fail_count: number } | null;
    return row?.fail_count ?? 0;
  }

  /** 线索被发现后清零失败计数——与 WorldState.resetClueFails 同一时机。 */
  resetClueFails(clueId: string): void {
    this.db.run("DELETE FROM clue_fail_counts WHERE clue_id=?1", [clueId]);
  }

  /** 记一次场景访问。同一 (player, scene) 重复记录是幂等的。 */
  recordSceneVisit(playerId: string, sceneId: string) {
    this.db.run(
      "INSERT OR IGNORE INTO scene_visits (player_id, scene_id) VALUES (?1,?2)",
      [playerId, sceneId],
    );
  }

  isSceneVisitedBy(playerId: string, sceneId: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM scene_visits WHERE player_id=?1 AND scene_id=?2 LIMIT 1")
      .get(playerId, sceneId);
  }

  getScenesVisitedBy(playerId: string): string[] {
    const rows: any[] = this.db
      .query("SELECT scene_id FROM scene_visits WHERE player_id=?1 ORDER BY first_visited_at")
      .all(playerId);
    return rows.map((r) => r.scene_id as string);
  }

  /** 队伍里任一人是否到过这个场景——结局条件（isSceneVisited）用这个。 */
  isSceneVisitedByAnyone(sceneId: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM scene_visits WHERE scene_id=?1 LIMIT 1")
      .get(sceneId);
  }

  // ==========================================================
  // 效果 / buff
  // ==========================================================

  addEffect(effect: Effect & { round_applied?: number }) {
    const transaction = this.db.transaction(() => {
      const roundApplied = effect.round_applied ?? this.readDurableCurrentRound();
      if (!Number.isSafeInteger(roundApplied) || roundApplied < 0) {
        throw new RangeError("Effect round_applied must be a non-negative safe integer");
      }
      this.db.run(
        `INSERT OR REPLACE INTO effects (id,source,target,type,description,duration,round_applied,data)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
        [
          effect.id, effect.source, effect.target, effect.type,
          effect.description, effect.duration, roundApplied, "{}",
        ],
      );
    });
    transaction.immediate();
  }

  tickEffects(): Effect[] {
    return this.db.transaction(() => {
      this.db.run("UPDATE effects SET duration = duration - 1 WHERE duration > 0");
      const expired: any[] = this.db.query("SELECT * FROM effects WHERE duration = 0").all();
      this.db.run("DELETE FROM effects WHERE duration = 0");
      return expired.map((r: any) => this.rowToEffect(r));
    })();
  }

  getActiveEffects(targetId?: string): Effect[] {
    const statement = targetId
      ? this.db.query("SELECT * FROM effects WHERE target = ?1 AND duration > 0")
      : this.db.query("SELECT * FROM effects WHERE duration > 0");
    try {
      const rows = (targetId ? statement.all(targetId) : statement.all()) as any[];
      return rows.map((r: any) => this.rowToEffect(r));
    } finally {
      statement.finalize();
    }
  }

  // ==========================================================
  // 快照系统
  // ==========================================================

  createSnapshot(): WorldStateSnapshot;
  createSnapshot(round: number): string;
  createSnapshot(round?: number): WorldStateSnapshot | string {
    if (round === undefined) return this.exportSnapshot();
    if (!Number.isSafeInteger(round) || round < 0) {
      throw new RangeError("World snapshot round must be a non-negative safe integer");
    }

    // One immediate transaction serializes the state/event read, derived
    // context, historical INSERT, and logical-clock update. A separate read
    // transaction followed by INSERT can be upgraded from a stale WAL snapshot
    // or publish context assembled from a different durable state.
    const transaction = this.db.transaction(() => {
      // Validate that no raw/legacy writer removed or corrupted the singleton
      // before publishing a successor round.
      this.readDurableCurrentRound();
      const state = this.getCurrentStateAtRound(round);
      const recentEvents = this.getRecentEvents(5);
      const contextText = this.buildContextPromptAtRound(state, recentEvents, round);
      this.db.run(
        `INSERT INTO snapshots (round, state_json, context_text, event_count)
         VALUES (?1, ?2, ?3, ?4)`,
        [round, JSON.stringify(state), contextText, recentEvents.length],
      );
      this.writeDurableCurrentRound(round);
      return contextText;
    });
    return transaction.immediate();
  }

  /**
   * Export the whole durable world truth source, not only the live projection
   * used by narration. SQL identifiers are fixed here; no snapshot field is
   * ever used as SQL text.
   */
  exportSnapshot(): WorldStateSnapshot {
    return this.db.transaction(() => {
    const json = (raw: unknown, column: string): unknown => {
      if (typeof raw !== "string") throw new Error(`Cannot export world snapshot: ${column} is not JSON text`);
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw new Error(`Cannot export world snapshot: ${column} contains invalid JSON`, { cause: error });
      }
    };
    const rows = (sql: string): any[] => {
      const statement = this.db.query(sql);
      try {
        return statement.all() as any[];
      } finally {
        statement.finalize();
      }
    };
    const sequence = (name: "inventory" | "relationships" | "snapshots" | "event_log"): number => {
      const statement = this.db.query("SELECT seq FROM sqlite_sequence WHERE name=?");
      let row: { seq?: unknown } | null;
      try {
        row = statement.get(name) as { seq?: unknown } | null;
      } finally {
        statement.finalize();
      }
      return typeof row?.seq === "number" ? row.seq : 0;
    };

    return createWorldStateSnapshot({
      version: 1,
      currentRound: this.readDurableCurrentRound(),
      sequences: {
        inventory: sequence("inventory"),
        relationships: sequence("relationships"),
        snapshots: sequence("snapshots"),
        event_log: sequence("event_log"),
      },
      tables: {
        entities: rows(`SELECT rowid AS rowid, id, name, type, hp, max_hp, ac, status, position, faction, attributes, scene_id, alive, created_at, updated_at FROM entities ORDER BY rowid`).map((row) => ({
          ...row, status: json(row.status, `entities(${row.id}).status`), attributes: json(row.attributes, `entities(${row.id}).attributes`),
        })),
        effects: rows(`SELECT rowid AS rowid, id, source, target, type, description, duration, round_applied, data FROM effects ORDER BY rowid`).map((row) => ({
          ...row, data: json(row.data, `effects(${row.id}).data`),
        })),
        inventory: rows(`SELECT rowid AS rowid, id, entity_id, item_name, quantity, description, properties FROM inventory ORDER BY rowid`).map((row) => ({
          ...row, properties: json(row.properties, `inventory(${row.id}).properties`),
        })),
        player_state: rows(`SELECT rowid AS rowid, entity_id, sanity, inventory, weapons, armor, updated_at FROM player_state ORDER BY rowid`).map((row) => ({
          ...row,
          sanity: row.sanity === null ? null : json(row.sanity, `player_state(${row.entity_id}).sanity`),
          inventory: json(row.inventory, `player_state(${row.entity_id}).inventory`),
          weapons: json(row.weapons, `player_state(${row.entity_id}).weapons`),
          armor: json(row.armor, `player_state(${row.entity_id}).armor`),
        })),
        relationships: rows(`SELECT rowid AS rowid, id, entity_a, entity_b, relation, attitude, note, updated_at FROM relationships ORDER BY rowid`),
        clue_discoveries: rows(`SELECT rowid AS rowid, player_id, clue_id, discovered_at FROM clue_discoveries ORDER BY rowid`),
        scene_visits: rows(`SELECT rowid AS rowid, player_id, scene_id, first_visited_at FROM scene_visits ORDER BY rowid`),
        clue_fail_counts: rows(`SELECT rowid AS rowid, clue_id, fail_count, updated_at FROM clue_fail_counts ORDER BY rowid`),
        scenes: rows(`SELECT rowid AS rowid, id, name, description, lighting, dangers, exits, is_active FROM scenes ORDER BY rowid`).map((row) => ({
          ...row, dangers: json(row.dangers, `scenes(${row.id}).dangers`), exits: json(row.exits, `scenes(${row.id}).exits`),
        })),
        snapshots: rows(`SELECT rowid AS rowid, id, round, timestamp, state_json, context_text, event_count FROM snapshots ORDER BY rowid`).map((row) => ({
          ...row, state_json: json(row.state_json, `snapshots(${row.id}).state_json`),
        })),
        event_log: rows(`SELECT rowid AS rowid, id, round, timestamp, event_type, actor, target, description, result_json, causation_id FROM event_log ORDER BY rowid`).map((row) => ({
          ...row, result_json: row.result_json === null ? null : json(row.result_json, `event_log(${row.id}).result_json`),
        })),
      },
    });
    })();
  }

  /**
   * Validate and prepare the complete document before touching SQLite, then
   * replace only the fixed world tables and durable current-round singleton in
   * one transaction, so a failed restore leaves both historical data and the
   * logical clock untouched.
   */
  restoreSnapshot(input: unknown): void {
    const snapshot = validateWorldStateSnapshot(input);
    const transaction = this.db.transaction((prepared: WorldStateSnapshot) => {
      // Child rows first keeps SQLite foreign key enforcement active throughout.
      this.db.exec(`
        DELETE FROM effects;
        DELETE FROM inventory;
        DELETE FROM relationships;
        DELETE FROM player_state;
        DELETE FROM clue_discoveries;
        DELETE FROM scene_visits;
        DELETE FROM clue_fail_counts;
        DELETE FROM snapshots;
        DELETE FROM event_log;
        DELETE FROM entities;
        DELETE FROM scenes;
      `);

      const t = prepared.tables;
      const insertEntity = this.db.query(`INSERT INTO entities (rowid, id, name, type, hp, max_hp, ac, status, position, faction, attributes, scene_id, alive, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertEffect = this.db.query(`INSERT INTO effects (rowid, id, source, target, type, description, duration, round_applied, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertInventory = this.db.query(`INSERT INTO inventory (rowid, id, entity_id, item_name, quantity, description, properties) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const insertPlayerState = this.db.query(`INSERT INTO player_state (rowid, entity_id, sanity, inventory, weapons, armor, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const insertRelationship = this.db.query(`INSERT INTO relationships (rowid, id, entity_a, entity_b, relation, attitude, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertClueDiscovery = this.db.query(`INSERT INTO clue_discoveries (rowid, player_id, clue_id, discovered_at) VALUES (?, ?, ?, ?)`);
      const insertSceneVisit = this.db.query(`INSERT INTO scene_visits (rowid, player_id, scene_id, first_visited_at) VALUES (?, ?, ?, ?)`);
      const insertClueFail = this.db.query(`INSERT INTO clue_fail_counts (rowid, clue_id, fail_count, updated_at) VALUES (?, ?, ?, ?)`);
      const insertScene = this.db.query(`INSERT INTO scenes (rowid, id, name, description, lighting, dangers, exits, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertHistoricalSnapshot = this.db.query(`INSERT INTO snapshots (rowid, id, round, timestamp, state_json, context_text, event_count) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const insertEvent = this.db.query(`INSERT INTO event_log (rowid, id, round, timestamp, event_type, actor, target, description, result_json, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertStatements = [
        insertEntity,
        insertEffect,
        insertInventory,
        insertPlayerState,
        insertRelationship,
        insertClueDiscovery,
        insertSceneVisit,
        insertClueFail,
        insertScene,
        insertHistoricalSnapshot,
        insertEvent,
      ];
      try {
        for (const row of t.entities) insertEntity.run(row.rowid, row.id, row.name, row.type, row.hp, row.max_hp, row.ac, JSON.stringify(row.status), row.position, row.faction, JSON.stringify(row.attributes), row.scene_id, row.alive, row.created_at, row.updated_at);
        for (const row of t.effects) insertEffect.run(row.rowid, row.id, row.source, row.target, row.type, row.description, row.duration, row.round_applied, JSON.stringify(row.data));
        for (const row of t.inventory) insertInventory.run(row.rowid, row.id, row.entity_id, row.item_name, row.quantity, row.description, JSON.stringify(row.properties));
        for (const row of t.player_state) insertPlayerState.run(row.rowid, row.entity_id, row.sanity === null ? null : JSON.stringify(row.sanity), JSON.stringify(row.inventory), JSON.stringify(row.weapons), JSON.stringify(row.armor), row.updated_at);
        for (const row of t.relationships) insertRelationship.run(row.rowid, row.id, row.entity_a, row.entity_b, row.relation, row.attitude, row.note, row.updated_at);
        for (const row of t.clue_discoveries) insertClueDiscovery.run(row.rowid, row.player_id, row.clue_id, row.discovered_at);
        for (const row of t.scene_visits) insertSceneVisit.run(row.rowid, row.player_id, row.scene_id, row.first_visited_at);
        for (const row of t.clue_fail_counts) insertClueFail.run(row.rowid, row.clue_id, row.fail_count, row.updated_at);
        for (const row of t.scenes) insertScene.run(row.rowid, row.id, row.name, row.description, row.lighting, JSON.stringify(row.dangers), JSON.stringify(row.exits), row.is_active);
        for (const row of t.snapshots) insertHistoricalSnapshot.run(row.rowid, row.id, row.round, row.timestamp, JSON.stringify(row.state_json), row.context_text, row.event_count);
        for (const row of t.event_log) insertEvent.run(row.rowid, row.id, row.round, row.timestamp, row.event_type, row.actor, row.target, row.description, row.result_json === null ? null : JSON.stringify(row.result_json), row.causation_id);

        const resetSequence = (name: "inventory" | "relationships" | "snapshots" | "event_log", value: number): void => {
          this.db.run("DELETE FROM sqlite_sequence WHERE name=?", [name]);
          if (value > 0) this.db.run("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", [name, value]);
        };
        resetSequence("inventory", prepared.sequences.inventory);
        resetSequence("relationships", prepared.sequences.relationships);
        resetSequence("snapshots", prepared.sequences.snapshots);
        resetSequence("event_log", prepared.sequences.event_log);
        this.writeDurableCurrentRound(prepared.currentRound);
      } finally {
        for (const statement of insertStatements) statement.finalize();
      }
    });

    transaction(snapshot);
  }

  getLatestContext(): string {
    const statement = this.db.query("SELECT context_text FROM snapshots ORDER BY rowid DESC LIMIT 1");
    try {
      const row = statement.get() as any;
      return row?.context_text ?? "[无快照]";
    } finally {
      statement.finalize();
    }
  }

  getCurrentState(): WorldState {
    return this.getCurrentStateAtRound(this.readDurableCurrentRound());
  }

  private getCurrentStateAtRound(round: number): WorldState {
    const activeSceneId = this.readActiveSceneId();
    const entities = this.getAllAliveEntities();
    const effects = this.getActiveEffects();

    const entityMap: Record<string, WorldEntity> = {};
    for (const e of entities) entityMap[e.id] = e;

    const players: Record<string, PlayerRuntimeState> = {};
    for (const pid of this.getPlayerIds()) {
      const ps = this.getPlayerState(pid);
      if (ps) players[pid] = ps;
    }

    return {
      entities: entityMap,
      active_effects: effects,
      scene: activeSceneId ?? "unknown",
      time: `round_${round}`,
      players,
    };
  }

  buildContextPrompt(state: WorldState, recentEvents: GameEvent[]): string {
    return this.buildContextPromptAtRound(state, recentEvents, this.readDurableCurrentRound());
  }

  private buildContextPromptAtRound(state: WorldState, recentEvents: GameEvent[], round: number): string {
    const lines: string[] = [];
    lines.push(`[世界状态 · 第 ${round} 轮 · 场景: ${state.scene}]`);
    lines.push("");

    // 只列当前场景的实体（position === 当前场景 ID）
    const alive = Object.values(state.entities)
      .filter((e) => !e.status.includes("dead") && e.position === state.scene);
    if (alive.length > 0) {
      lines.push("## 在场角色");
      for (const e of alive) {
        const statusStr = e.status.filter((s) => s !== "alive").length > 0
          ? ` [${e.status.filter((s) => s !== "alive").join(", ")}]` : "";
        lines.push(`- ${e.name}(${e.type}) HP:${e.hp}/${e.maxHp} AC:${e.ac} 位置:${e.position}${statusStr}`);
      }
      lines.push("");
    }

    if (state.active_effects.length > 0) {
      lines.push("## 活跃效果");
      for (const eff of state.active_effects) {
        const targetName = state.entities[eff.target]?.name ?? eff.target;
        lines.push(`- ${targetName}: ${eff.description}（剩余 ${eff.duration} 回合）`);
      }
      lines.push("");
    }

    if (recentEvents.length > 0) {
      lines.push("## 最近事件");
      for (const evt of recentEvents.slice(-5)) {
        const actorName = evt.actor ? (state.entities[evt.actor]?.name ?? evt.actor) : "";
        const targetName = evt.target ? (state.entities[evt.target]?.name ?? evt.target) : "";
        const desc = actorName
          ? (targetName ? `${actorName} → ${targetName}: ${evt.description}` : `${actorName}: ${evt.description}`)
          : evt.description;
        lines.push(`- [${evt.event_type}] ${desc}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // ==========================================================
  // 事件日志
  // ==========================================================

  logEvent(event: GameEvent) {
    this.db.run(
      `INSERT INTO event_log (round, event_type, actor, target, description, result_json, causation_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
      [event.round, event.event_type, event.actor ?? null, event.target ?? null,
       event.description, event.result ? JSON.stringify(event.result) : null,
       event.causationId ?? null]
    );
  }

  logCombatEvent(round: number, attackerId: string, targetId: string, description: string, result: CombatResult) {
    this.logEvent({
      round, timestamp: Date.now(), event_type: "combat",
      actor: attackerId, target: targetId, description,
      result: result as unknown as Record<string, unknown>,
    });
  }

  getRecentEvents(n: number = 5): GameEvent[] {
    const statement = this.db.query("SELECT * FROM event_log ORDER BY id DESC LIMIT ?");
    try {
      const rows = statement.all(n) as any[];
      return rows.map((r: any) => ({
        round: r.round, timestamp: r.timestamp, event_type: r.event_type,
        actor: r.actor, target: r.target, description: r.description,
        result: r.result_json ? JSON.parse(r.result_json) : undefined,
        ...(r.causation_id === null || r.causation_id === undefined
          ? {}
          : { causationId: r.causation_id }),
      })).reverse();
    } finally {
      statement.finalize();
    }
  }

  // ==========================================================
  // 场景 / 关系
  // ==========================================================

  /**
   * 把某个场景设为活动场景。返回是否真的切过去了。
   *
   * ⚠ 原实现是无条件的两句：先 `UPDATE scenes SET is_active = 0` 清掉全部，
   * 再 `UPDATE ... WHERE id = ?` 打开目标。目标不存在时第二句匹配不到行，
   * 于是**世界里一个活动场景都不剩** —— 比「什么都没做」更糟，
   * 而调用方拿不到任何信号（原来连返回值都没有）。
   *
   * docs/kp-tool-surface-assessment.md §八 记过两次同类事故：
   * 「类型检查与 710 个测试全绿，只有真实跑团暴露了它」。
   * 所以这里先校验存在、再动，并且**回读确认**，不只信「我执行了 UPDATE」。
   */
  setActiveScene(sceneId: string): boolean {
    return this.db.transaction(() => {
      this.readActiveSceneId();
      const exists = this.db.query("SELECT id FROM scenes WHERE id = ?").get(sceneId);
      if (!exists) return false;
      this.db.run("UPDATE scenes SET is_active = 0");
      this.db.run("UPDATE scenes SET is_active = 1 WHERE id = ?", [sceneId]);
      return this.readActiveSceneId() === sceneId;
    })();
  }

  /**
   * Do not let a deliberately weakened or damaged database turn a plural or
   * non-bit active set into whichever row SQLite happens to return first.
   * The durable schema normally makes both branches unreachable; this guard
   * keeps every public manager path fail-closed when that protection is gone.
   */
  private readActiveSceneId(): string | null {
    const invalidStatement = this.db.query(`
      SELECT id, is_active
      FROM scenes
      WHERE is_active IS NULL OR is_active NOT IN (0, 1)
      ORDER BY id
      LIMIT 1
    `);
    let invalid: { id: string; is_active: unknown } | null;
    try {
      invalid = invalidStatement.get() as { id: string; is_active: unknown } | null;
    } finally {
      invalidStatement.finalize();
    }
    if (invalid) {
      throw new Error(
        `Invalid scenes.is_active invariant: scene ${JSON.stringify(invalid.id)} has illegal is_active value ${JSON.stringify(invalid.is_active)}; is_active must be 0 or 1.`,
      );
    }

    const activeStatement = this.db.query(`
      SELECT id
      FROM scenes
      WHERE is_active = 1
      ORDER BY id
      LIMIT 2
    `);
    let activeRows: Array<{ id: string }>;
    try {
      activeRows = activeStatement.all() as Array<{ id: string }>;
    } finally {
      activeStatement.finalize();
    }
    if (activeRows.length > 1) {
      throw new Error(
        `Invalid scenes.is_active invariant: multiple active scenes exist (${activeRows.map((row) => JSON.stringify(row.id)).join(", ")}).`,
      );
    }
    return activeRows[0]?.id ?? null;
  }

  /** 读取场景（含模组原文描写与出口）。不存在返回 null。 */
  getScene(sceneId: string): SceneRecord | null {
    const row: any = this.db
      .query("SELECT id, name, description, lighting, dangers, exits FROM scenes WHERE id = ?")
      .get(sceneId);
    if (!row) return null;
    return this.toSceneRecord(row);
  }

  /**
   * 列出全部已注册场景。
   *
   * 存在的意义是让调用方不必为了「列举场景」去 getDatabase() 手写 SQL：
   * 那样查出来的行是 any，列名拼错、少读一列、description 为 null
   * 都要等到运行时才发现。收到这里之后，表结构只有本文件知道。
   */
  listScenes(): SceneRecord[] {
    const rows = this.db
      .query("SELECT id, name, description, lighting, dangers, exits FROM scenes")
      .all() as any[];
    return rows.map((r) => this.toSceneRecord(r));
  }

  // name 在 schema 里是 NOT NULL，所以不做 `?? id` 回落——那是在防一个
  // 数据库已经禁止的状态。空串是允许的，由调用方自己判 falsy。
  /**
   * 覆写场景出口。
   *
   * 与 registerScene() 分开而不是给它加第四个参数：出口往往在场景注册之后才
   * 确定（模组导入分三个阶段补出口，故事生成器先选模板再连边），硬塞进注册
   * 签名会逼调用方在还不知道出口时先传一个占位值。
   */
  setSceneExits(sceneId: string, exits: readonly SceneExit[]) {
    this.db.run("UPDATE scenes SET exits = ? WHERE id = ?", [
      // 显式列字段而不是整个 e 直接塞，避免把调用方多带的东西写进库；
      // sighted 要留住 —— 丢了它读回来就再也拼不出识别桥段。
      JSON.stringify(
        exits.map((e) => ({
          target: e.target,
          desc: e.desc,
          ...(e.sighted ? { sighted: e.sighted } : {}),
        })),
      ),
      sceneId,
    ]);
  }

  private toSceneRecord(row: any): SceneRecord {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      lighting: typeof row.lighting === "string" ? row.lighting : null,
      dangers: this.parseJsonColumn<string[]>(row.dangers, []),
      // 把 id 传进去 —— 告警是用来排障的，不说是哪个场景就得靠猜。
      exits: this.parseExits(row.exits, row.id),
    };
  }

  /**
   * 注册场景（模组原文导入用）。
   *
   * 不能用 INSERT OR REPLACE：它是先删后插，未在 VALUES 里列出的列
   * （exits / dangers / lighting）会静默回落到 schema 默认值。模组导入时
   * exits 已经写好，再注册一次就会被整段清空；顺带 is_active 也会被抹成 0，
   * 重新注册当前活动场景等于把它取消激活。改为「存在则 UPDATE 指定列」。
   */
  registerScene(sceneId: string, displayName: string, description?: string) {
    if (description == null) {
      // Leave the omitted column out of the conflict branch altogether. Reading
      // it first and writing the cached value back would overwrite a concurrent
      // writer's description between those two statements.
      this.db.run(
        `INSERT INTO scenes (id, name, description, is_active) VALUES (?1, ?2, '', 0)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
        [sceneId, displayName ?? sceneId],
      );
      return;
    }

    this.db.run(
      `INSERT INTO scenes (id, name, description, is_active) VALUES (?1, ?2, ?3, 0)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description`,
      [sceneId, displayName ?? sceneId, description],
    );
  }

  /**
   * Retains source-declared scene environment separately from registration and
   * exits. Keeping this explicit prevents a runtime loader from silently
   * treating a scene identifier or description as lighting or hazards.
   */
  setSceneEnvironment(sceneId: string, lighting?: string, dangers?: readonly string[]) {
    // Keep omitted fields in SQLite. Reading them first would cache a stale
    // environment and overwrite another connection's intervening update.
    // Empty strings and arrays are explicit values; null/undefined retain the
    // historical `??` behavior when this public JS method is called untyped.
    const supplied = (value: unknown): number => value === null || value === undefined ? 0 : 1;
    const result = this.db.run(
      `UPDATE scenes SET
         lighting = CASE WHEN ?1 THEN ?2 ELSE lighting END,
         dangers = CASE WHEN ?3 THEN ?4 ELSE dangers END
       WHERE id = ?5`,
      [
        supplied(lighting),
        lighting ?? null,
        supplied(dangers),
        JSON.stringify(dangers ?? []),
        sceneId,
      ],
    );
    if (result.changes !== 1) {
      throw new Error(`cannot set environment for an unknown scene: ${sceneId}`);
    }
  }

  /**
   * 读 exits 列。**解析本体在 `state/scene-exits.ts`，读写两层共用同一份。**
   *
   * 原先这里自己写了一份宽容的解析，`mythos-module` 写回时又另写了一份严格的，
   * 两份对「数据坏了」的处理还相反：这边 `catch { return [] }`（当没出口），
   * 那边空着继续往下走然后**把空的写回去**（抹掉原出口）。
   * 一份数据两套解析，漂的那一刻不会有任何测试变红。
   *
   * 这一层的立场是「尽力显示」，所以照旧返回解析得出来的部分；
   * 但**不再把「坏了」和「本来就没有」混为一谈** —— 坏了要出声。
   */
  private parseExits(raw: unknown, sceneId?: string): SceneExit[] {
    const r = parseExits(raw);
    if (!r.ok) {
      // 出声而不是静默返回 []。§八 那两次事故的共同点就是「降级得太安静」。
      log.warn("world", `场景${sceneId ? `「${sceneId}」` : ""}的 exits 读不干净：${r.reason}`);
    }
    return r.exits;
  }

  setRelation(a: string, b: string, relation: string, attitude: number = 0) {
    const matches = this.db
      .query("SELECT entity_a, entity_b FROM relationships WHERE (entity_a=?1 AND entity_b=?2) OR (entity_a=?2 AND entity_b=?1)")
      .all(a, b) as Array<{ entity_a: string; entity_b: string }>;
    if (matches.length > 1) {
      throw new Error(`Cannot set relation for ${a} and ${b}: multiple directional relationships exist`);
    }

    // A legacy single row keeps its persisted direction. New pairs use the
    // same stable JavaScript ordinal ordering as modifyAttitude.
    const target = matches[0];
    const [entityA, entityB] = target
      ? [target.entity_a, target.entity_b]
      : a < b ? [a, b] : [b, a];
    this.db.run(
      `INSERT INTO relationships (entity_a, entity_b, relation, attitude, updated_at)
       VALUES (?1,?2,?3,?4,unixepoch())
       ON CONFLICT(entity_a, entity_b) DO UPDATE SET
         relation=excluded.relation,
         attitude=excluded.attitude,
         updated_at=unixepoch()`,
      [entityA, entityB, relation, attitude]
    );
  }

  getAttitude(a: string, b: string): number {
    const matches = this.db
      .query("SELECT attitude FROM relationships WHERE (entity_a=?1 AND entity_b=?2) OR (entity_a=?2 AND entity_b=?1)")
      .all(a, b) as Array<{ attitude: number }>;
    if (matches.length > 1) {
      throw new Error(`Cannot read attitude for ${a} and ${b}: multiple directional relationships exist`);
    }
    return matches[0]?.attitude ?? 0;
  }

  modifyAttitude(a: string, b: string, delta: number): { relation: string; attitude: number } {
    // The public reader and this mutator accept either one stored direction,
    // but both fail closed when an ambiguous pair has two directional rows.
    const matches = this.db
      .query("SELECT entity_a, entity_b FROM relationships WHERE (entity_a=?1 AND entity_b=?2) OR (entity_a=?2 AND entity_b=?1)")
      .all(a, b) as Array<{ entity_a: string; entity_b: string }>;
    if (matches.length > 1) {
      throw new Error(`Cannot modify attitude for ${a} and ${b}: multiple directional relationships exist`);
    }

    const target = matches[0];
    // New pairs have no persisted direction to preserve. Use JavaScript's
    // ordinal string comparison rather than locale-aware collation so reverse
    // first writes from separate connections choose the same SQLite key.
    const [entityA, entityB] = target
      ? [target.entity_a, target.entity_b]
      : a < b ? [a, b] : [b, a];
    const persisted = this.db.query(
      `INSERT INTO relationships (entity_a, entity_b, relation, attitude, updated_at)
       VALUES (?1, ?2,
         CASE WHEN ?3 > 0 THEN 'ally' WHEN ?3 < 0 THEN 'hostile' ELSE 'neutral' END,
         ?3, unixepoch())
       ON CONFLICT(entity_a, entity_b) DO UPDATE SET
         relation = CASE
           WHEN attitude + excluded.attitude > 0 THEN 'ally'
           WHEN attitude + excluded.attitude < 0 THEN 'hostile'
           ELSE 'neutral'
         END,
         attitude = attitude + excluded.attitude,
         updated_at = unixepoch()
       RETURNING relation, attitude`,
    ).get(entityA, entityB, delta) as { relation?: unknown; attitude?: unknown } | null;
    if (typeof persisted?.relation !== "string" || typeof persisted.attitude !== "number") {
      throw new Error(`Attitude change failed to persist for ${a} and ${b}`);
    }
    return { relation: persisted.relation, attitude: persisted.attitude };
  }

  // ==========================================================
  // 辅助
  // ==========================================================

  /**
   * 列名来自本类内部的封闭字面量联合，不接受外部输入，故可安全插值。
   * 值一律以 JSON 文本参数化绑定。
   */
  private writePlayerColumn(
    playerId: string,
    column: "sanity" | "inventory" | "weapons" | "armor",
    value: string,
  ) {
    this.db.transaction(() => {
      this.registerPlayer(playerId);
      this.db.run(
        `UPDATE player_state SET ${column}=?1, updated_at=unixepoch() WHERE entity_id=?2`,
        [value, playerId]
      );
    })();
  }

  private parseJsonColumn<T>(raw: unknown, fallback: T): T {
    if (typeof raw !== "string" || raw.length === 0) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private rowToEntity(row: any): WorldEntity {
    return {
      id: row.id, name: row.name, type: row.type,
      hp: row.hp, maxHp: row.max_hp, ac: row.ac,
      status: JSON.parse(row.status || "[]"),
      position: row.position,
      faction: row.faction ?? undefined,
      // 必须回读：upsertEntity 的更新分支拿 existing 做回落，这里不返回
      // 就等于每次更新都把这两列抹掉（scene_id → NULL，attributes → '{}'）。
      scene_id: row.scene_id ?? undefined,
      attributes: this.parseJsonColumn<Record<string, number>>(row.attributes, {}),
    };
  }

  private rowToEffect(row: any): Effect {
    return {
      id: row.id, source: row.source, target: row.target,
      type: row.type, description: row.description, duration: row.duration,
    };
  }

  close() { this.db.close(); }

  getDatabase(): Database { return this.db; }
}
