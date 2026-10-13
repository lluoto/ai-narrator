// 世界状态 SQLite schema — 律书的真相源

import type { Database } from "bun:sqlite";

export function createSchema(db: Database) {
  db.exec(`

    CREATE TABLE IF NOT EXISTS entities (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL CHECK(type IN ('pc','npc','monster','item')),
      hp          INTEGER NOT NULL DEFAULT 0,
      max_hp      INTEGER NOT NULL DEFAULT 0,
      ac          INTEGER NOT NULL DEFAULT 10,
      status      TEXT NOT NULL DEFAULT '[]',
      position    TEXT NOT NULL DEFAULT 'unknown',
      faction     TEXT DEFAULT NULL,
      attributes  TEXT NOT NULL DEFAULT '{}',
      scene_id    TEXT DEFAULT NULL,
      alive       INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS effects (
      id            TEXT PRIMARY KEY,
      source        TEXT NOT NULL,
      target        TEXT NOT NULL,
      type          TEXT NOT NULL CHECK(type IN ('advantage','disadvantage','condition','buff','debuff')),
      description   TEXT NOT NULL,
      duration      INTEGER NOT NULL DEFAULT 0,
      round_applied INTEGER NOT NULL,
      data          TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (target) REFERENCES entities(id)
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id   TEXT NOT NULL,
      item_name   TEXT NOT NULL,
      quantity    INTEGER NOT NULL DEFAULT 1,
      description TEXT DEFAULT '',
      properties  TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (entity_id) REFERENCES entities(id)
    );

    -- 玩家运行时状态 —— SAN / 背包 / 已装备武器 / 已装备护甲。
    -- 这四类此前停留在 GameSession 的进程内 Map，重启即失，KP 与规则引擎都看不到。
    -- 归入真相源后 getCurrentState() 才是完整快照，applyAction 闸门才有可校验的对象。
    CREATE TABLE IF NOT EXISTS player_state (
      entity_id   TEXT PRIMARY KEY,
      sanity      TEXT DEFAULT NULL,
      inventory   TEXT NOT NULL DEFAULT '[]',
      weapons     TEXT NOT NULL DEFAULT '[]',
      armor       TEXT NOT NULL DEFAULT '[]',
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS relationships (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_a    TEXT NOT NULL,
      entity_b    TEXT NOT NULL,
      relation    TEXT NOT NULL,
      attitude    INTEGER NOT NULL DEFAULT 0,
      note        TEXT DEFAULT '',
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(entity_a, entity_b)
    );

    -- 线索发现 / 场景访问历史 —— 按玩家记，累计、从不清空。
    -- 此前分别停在 InvestigationEngine 的进程内 Map（discovered）和完全没有
    -- 追踪（GameSession 侧 scene 访问史）。归入真相源后 isClueFound/
    -- isSceneVisited（队伍任一人）才有单一权威可查，且重启不丢。
    -- 语义对齐 src/world/state.ts 的 WorldState.sceneHistory：只增不减。
    CREATE TABLE IF NOT EXISTS clue_discoveries (
      player_id      TEXT NOT NULL,
      clue_id        TEXT NOT NULL,
      discovered_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (player_id, clue_id)
    );

    CREATE TABLE IF NOT EXISTS scene_visits (
      player_id        TEXT NOT NULL,
      scene_id         TEXT NOT NULL,
      first_visited_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (player_id, scene_id)
    );

    -- 线索检定失败计数——failback 阶梯用（开发·线索闸门 任务4）。
    -- 剧本杀路径（src/world/state.ts 的 WorldState）一直有这份计数，是
    -- 进程内 Map；自由跑团路径（GameSession/WorldStateManager）此前完全
    -- 没有，是"两个运行时各持一半"的第三次（前两次是线索发现、场景
    -- 访问，见上面 clue_discoveries/scene_visits 的注释）。按同一个方向
    -- 迁进真相源，不在 GameSession 再开一个内存 Map。按 clue_id 计数，
    -- 不分玩家——阶梯是"这条线索被这支队伍试了几次"，与谁掷的骰子无关，
    -- 与 WorldState.clueFailCounts 同一语义（该文件同样不分玩家）。
    CREATE TABLE IF NOT EXISTS clue_fail_counts (
      clue_id     TEXT PRIMARY KEY,
      fail_count  INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS scenes (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lighting    TEXT DEFAULT 'normal',
      dangers     TEXT NOT NULL DEFAULT '[]',
      exits       TEXT NOT NULL DEFAULT '[]',
      is_active   INTEGER NOT NULL DEFAULT 0
                    CONSTRAINT chk_scenes_is_active_bit CHECK(is_active IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      round        INTEGER NOT NULL,
      timestamp    INTEGER NOT NULL DEFAULT (unixepoch()),
      state_json   TEXT NOT NULL,
      context_text TEXT NOT NULL,
      event_count  INTEGER NOT NULL DEFAULT 0
    );

    -- This is the logical world clock. Historical snapshots are append-only
    -- records and may be pruned, so their latest surviving row cannot be used
    -- as the live round authority.
    CREATE TABLE IF NOT EXISTS world_state_metadata (
      singleton     INTEGER PRIMARY KEY CHECK(singleton = 1),
      current_round INTEGER NOT NULL CHECK(current_round BETWEEN 0 AND 9007199254740991)
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      round       INTEGER NOT NULL,
      timestamp   INTEGER NOT NULL DEFAULT (unixepoch()),
      event_type  TEXT NOT NULL,
      actor       TEXT DEFAULT NULL,
      target      TEXT DEFAULT NULL,
      description TEXT NOT NULL,
      result_json TEXT DEFAULT NULL,
      causation_id TEXT DEFAULT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entities_type   ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_entities_scene  ON entities(scene_id);
    CREATE INDEX IF NOT EXISTS idx_effects_target  ON effects(target);
    CREATE INDEX IF NOT EXISTS idx_events_round    ON event_log(round);
    CREATE INDEX IF NOT EXISTS idx_snapshots_round ON snapshots(round);
    CREATE INDEX IF NOT EXISTS idx_inventory_owner ON inventory(entity_id);
    CREATE INDEX IF NOT EXISTS idx_clue_disc_clue  ON clue_discoveries(clue_id);
    CREATE INDEX IF NOT EXISTS idx_scene_visit_scn ON scene_visits(scene_id);
  `);

  // CREATE TABLE IF NOT EXISTS 不会改变已经存在的 event_log。旧存档仍必须能
  // 原地打开，因此只在列确实不存在时追加一个可空字段；不触碰历史行。
  const eventLogColumnsStatement = db.query("PRAGMA table_info(event_log)");
  let eventLogColumns: Array<{ name: string }>;
  try {
    eventLogColumns = eventLogColumnsStatement.all() as Array<{ name: string }>;
  } finally {
    eventLogColumnsStatement.finalize();
  }
  if (!eventLogColumns.some((column) => column.name === "causation_id")) {
    db.exec("ALTER TABLE event_log ADD COLUMN causation_id TEXT DEFAULT NULL");
  }

  enforceCurrentRoundMetadata(db);

  enforceActiveSceneInvariant(db);

  enforceUnorderedRelationshipInvariant(db);
}

const CURRENT_ROUND_METADATA_TABLE = "world_state_metadata";
const SNAPSHOTS_TABLE = "snapshots";
const MAX_SAFE_SQLITE_INTEGER = 9_007_199_254_740_991;

/**
 * An old database has snapshots but no durable logical-clock row. Seed it once
 * from the most recently inserted historical snapshot; after that the row is
 * authoritative even if retention removes that historical record. A
 * same-named table with weaker structure or invalid data is not a migration
 * target: fail closed rather than guessing a world round.
 */
function enforceCurrentRoundMetadata(db: Database): void {
  const install = db.transaction(() => {
    const snapshots = findSchemaObject(db, SNAPSHOTS_TABLE);
    if (!snapshots) throw currentRoundMetadataError("snapshots table is missing after creation");
    assertSnapshotsTable(snapshots);

    const existing = findSchemaObject(db, CURRENT_ROUND_METADATA_TABLE);
    if (existing) assertCurrentRoundMetadataTable(existing);

    // The CREATE TABLE above makes this exact for fresh stores. Re-read the
    // catalog because CREATE ... IF NOT EXISTS must not be treated as proof
    // that a pre-existing object has our required contract.
    const installed = findSchemaObject(db, CURRENT_ROUND_METADATA_TABLE);
    if (!installed) throw currentRoundMetadataError("is missing after creation");
    assertCurrentRoundMetadataTable(installed);

    const statement = db.query(`
      SELECT singleton, current_round, typeof(current_round) AS current_round_type
      FROM ${CURRENT_ROUND_METADATA_TABLE}
      ORDER BY singleton
    `);
    let rows: Array<{ singleton: unknown; current_round: unknown; current_round_type: unknown }>;
    try {
      rows = statement.all() as Array<{ singleton: unknown; current_round: unknown; current_round_type: unknown }>;
    } finally {
      statement.finalize();
    }
    if (rows.length > 1) throw currentRoundMetadataError("contains more than one row");

    // Validate all historical values even when current-round metadata already
    // exists. A raw/legacy writer must not be able to leave a latent malformed
    // round that only fails on a later export after startup has accepted it.
    // When metadata is absent this same validated append order supplies the
    // legacy initial value.
    const historyStatement = db.query(`SELECT rowid AS snapshot_rowid, round, typeof(round) AS round_type FROM ${SNAPSHOTS_TABLE} ORDER BY rowid`);
    let history: Array<{ snapshot_rowid: unknown; round: unknown; round_type: unknown }>;
    try {
      history = historyStatement.all() as Array<{ snapshot_rowid: unknown; round: unknown; round_type: unknown }>;
    } finally {
      historyStatement.finalize();
    }
    let initialRound = 0;
    for (const snapshot of history) {
      initialRound = validatedCurrentRound(
        snapshot.round,
        snapshot.round_type,
        `snapshots rowid ${String(snapshot.snapshot_rowid)} round`,
      );
    }

    const existingRow = rows[0];
    if (existingRow) {
      assertCurrentRoundMetadataValue(existingRow.singleton, existingRow.current_round, existingRow.current_round_type);
      return;
    }
    db.run(`INSERT INTO ${CURRENT_ROUND_METADATA_TABLE} (singleton, current_round) VALUES (1, ?)`, [initialRound]);
  });
  install.immediate();
}

function assertSnapshotsTable(object: SchemaObjectRow): void {
  if (object.type !== "table" || object.tbl_name !== SNAPSHOTS_TABLE) {
    throw currentRoundMetadataError("snapshots is not the required table");
  }
  if (!matchesSql(
    object.sql,
    /^createtable(?:ifnotexists)?snapshots\(idintegerprimarykeyautoincrement,roundintegernotnull,timestampintegernotnulldefault\(unixepoch\(\)\),state_jsontextnotnull,context_texttextnotnull,event_countintegernotnulldefault0\)$/,
  )) {
    throw currentRoundMetadataError("snapshots does not have the required legacy definition");
  }
}

function assertCurrentRoundMetadataTable(object: SchemaObjectRow): void {
  if (object.type !== "table" || object.tbl_name !== CURRENT_ROUND_METADATA_TABLE) {
    throw currentRoundMetadataError("is not the required table");
  }
  if (!matchesSql(
    object.sql,
    /^createtable(?:ifnotexists)?world_state_metadata\(singletonintegerprimarykeycheck\(singleton=1\),current_roundintegernotnullcheck\(current_roundbetween0and9007199254740991\)\)$/,
  )) {
    throw currentRoundMetadataError("does not have the required singleton/current_round definition");
  }
}

function assertCurrentRoundMetadataValue(singleton: unknown, round: unknown, roundType: unknown): void {
  if (singleton !== 1) throw currentRoundMetadataError("has a row whose singleton key is not 1");
  validatedCurrentRound(round, roundType, `${CURRENT_ROUND_METADATA_TABLE}.current_round`);
}

function validatedCurrentRound(value: unknown, sqliteType: unknown, source: string): number {
  if (sqliteType !== "integer" || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_SQLITE_INTEGER) {
    throw currentRoundMetadataError(`${source} is not a non-negative safe SQLite integer`);
  }
  return value;
}

function currentRoundMetadataError(reason: string): Error {
  return new Error(`Cannot validate durable current round metadata: ${reason}; data was left unchanged.`);
}

/**
 * `CREATE TABLE IF NOT EXISTS` leaves an old scenes table untouched, so a
 * modern table CHECK cannot protect legacy files. Verify legacy rows before
 * adding any guard: corrupt data is evidence, not something startup may pick
 * arbitrarily or silently repair. A partial unique index carries the
 * cross-row invariant for every writer, while named triggers give legacy
 * tables the same per-row bit guard as the new-table CHECK.
 */
function enforceActiveSceneInvariant(db: Database): void {
  // IF NOT EXISTS is only safe when the object already there is exactly the
  // guard we rely on. A same-named non-unique index or inert trigger must not
  // turn into a silently accepted downgrade. Check any existing definitions
  // first, then create and re-check within one transaction so a collision or
  // DDL failure cannot leave a partly-installed protection set behind.
  const installProtections = db.transaction(() => {
    assertActiveSceneRows(db);
    assertExistingActiveSceneProtections(db);

    // Keep this on db.run: creating the partial UNIQUE index is the statement
    // whose real constraint failure must reach the caller.
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scenes_single_active
      ON scenes(is_active)
      WHERE is_active = 1;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_scenes_is_active_bit_insert
      BEFORE INSERT ON scenes
      FOR EACH ROW WHEN NEW.is_active NOT IN (0, 1)
      BEGIN
        SELECT RAISE(ABORT, 'scenes.is_active must be 0 or 1');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_scenes_is_active_bit_update
      BEFORE UPDATE OF is_active ON scenes
      FOR EACH ROW WHEN NEW.is_active NOT IN (0, 1)
      BEGIN
        SELECT RAISE(ABORT, 'scenes.is_active must be 0 or 1');
      END;
    `);

    assertAllActiveSceneProtections(db);
    // A concurrent raw legacy writer can commit after the first scan but
    // before this transaction upgrades for DDL. SQLite must then reject the
    // upgrade/snapshot, or this second scan observes the damaged row. Never
    // let the newly installed future-write guards bless pre-existing damage.
    assertActiveSceneRows(db);
  });
  installProtections();
}

function assertActiveSceneRows(db: Database): void {
  const invalid = findInvalidActiveScene(db);
  if (invalid) throw activeSceneBitError(invalid);

  const conflict = findMultipleActiveScenes(db);
  if (conflict) throw multipleActiveScenesError(conflict);
}

const ACTIVE_SCENE_INDEX = "idx_scenes_single_active";
const ACTIVE_SCENE_INSERT_TRIGGER = "trg_scenes_is_active_bit_insert";
const ACTIVE_SCENE_UPDATE_TRIGGER = "trg_scenes_is_active_bit_update";

interface SchemaObjectRow {
  type: string;
  tbl_name: string;
  sql: string | null;
}

function assertExistingActiveSceneProtections(db: Database): void {
  const index = findSchemaObject(db, ACTIVE_SCENE_INDEX);
  if (index) assertActiveSceneIndex(db, index);

  const insertTrigger = findSchemaObject(db, ACTIVE_SCENE_INSERT_TRIGGER);
  if (insertTrigger) assertActiveSceneTrigger(insertTrigger, "insert");

  const updateTrigger = findSchemaObject(db, ACTIVE_SCENE_UPDATE_TRIGGER);
  if (updateTrigger) assertActiveSceneTrigger(updateTrigger, "update");
}

function assertAllActiveSceneProtections(db: Database): void {
  const index = findSchemaObject(db, ACTIVE_SCENE_INDEX);
  if (!index) throw activeSceneProtectionError(ACTIVE_SCENE_INDEX, "is missing");
  assertActiveSceneIndex(db, index);

  const insertTrigger = findSchemaObject(db, ACTIVE_SCENE_INSERT_TRIGGER);
  if (!insertTrigger) throw activeSceneProtectionError(ACTIVE_SCENE_INSERT_TRIGGER, "is missing");
  assertActiveSceneTrigger(insertTrigger, "insert");

  const updateTrigger = findSchemaObject(db, ACTIVE_SCENE_UPDATE_TRIGGER);
  if (!updateTrigger) throw activeSceneProtectionError(ACTIVE_SCENE_UPDATE_TRIGGER, "is missing");
  assertActiveSceneTrigger(updateTrigger, "update");
}

function findSchemaObject(db: Database, name: string): SchemaObjectRow | null {
  const statement = db.query("SELECT type, tbl_name, sql FROM sqlite_master WHERE name=?1");
  try {
    const rows = statement.all(name) as SchemaObjectRow[];
    if (rows.length > 1) throw activeSceneProtectionError(name, "is ambiguous in sqlite_master");
    return rows[0] ?? null;
  } finally {
    statement.finalize();
  }
}

function assertActiveSceneIndex(db: Database, object: SchemaObjectRow): void {
  if (object.type !== "index" || object.tbl_name !== "scenes") {
    throw activeSceneProtectionError(ACTIVE_SCENE_INDEX, "is not an index on scenes");
  }
  if (!matchesSql(
    object.sql,
    /^createuniqueindex(?:ifnotexists)?idx_scenes_single_activeonscenes\(is_active\)whereis_active=1$/,
  )) {
    throw activeSceneProtectionError(ACTIVE_SCENE_INDEX, "does not have the required partial UNIQUE definition");
  }

  const indexList = db.query("PRAGMA index_list(scenes)");
  let listed: Array<{ name: string; unique: number; partial: number }>;
  try {
    listed = indexList.all() as Array<{ name: string; unique: number; partial: number }>;
  } finally {
    indexList.finalize();
  }
  const metadata = listed.find((row) => row.name === ACTIVE_SCENE_INDEX);
  if (!metadata || metadata.unique !== 1 || metadata.partial !== 1) {
    throw activeSceneProtectionError(ACTIVE_SCENE_INDEX, "is not a partial UNIQUE index");
  }

  const indexColumns = db.query("PRAGMA index_xinfo(idx_scenes_single_active)");
  let columns: Array<{ seqno: number; name: string | null; key: number }>;
  try {
    columns = indexColumns.all() as Array<{ seqno: number; name: string | null; key: number }>;
  } finally {
    indexColumns.finalize();
  }
  const keyColumns = columns.filter((column) => column.key === 1);
  if (keyColumns.length !== 1 || keyColumns[0]?.seqno !== 0 || keyColumns[0].name !== "is_active") {
    throw activeSceneProtectionError(ACTIVE_SCENE_INDEX, "does not uniquely key only scenes.is_active");
  }
}

function assertActiveSceneTrigger(object: SchemaObjectRow, event: "insert" | "update"): void {
  const name = event === "insert" ? ACTIVE_SCENE_INSERT_TRIGGER : ACTIVE_SCENE_UPDATE_TRIGGER;
  if (object.type !== "trigger" || object.tbl_name !== "scenes") {
    throw activeSceneProtectionError(name, "is not a trigger on scenes");
  }
  const updateOf = event === "update" ? "ofis_active" : "";
  const pattern = new RegExp(
    `^createtrigger(?:ifnotexists)?${name}before${event}${updateOf}onscenesforeachrowwhennew\\.is_activenotin\\(0,1\\)beginselectraise\\(abort,'scenes\\.is_activemustbe0or1'\\);end$`,
  );
  if (!matchesSql(object.sql, pattern)) {
    throw activeSceneProtectionError(name, "does not have the required bit-rejection definition");
  }
}

function matchesSql(sql: string | null, expected: RegExp): boolean {
  return typeof sql === "string" && expected.test(sql.replace(/\s+/g, "").toLowerCase());
}

function activeSceneProtectionError(name: string, reason: string): Error {
  return new Error(
    `Cannot validate scenes.is_active durable protections: ${name} ${reason}; data was left unchanged.`,
  );
}

const UNORDERED_RELATIONSHIP_INDEX = "idx_relationships_unordered_pair";

/**
 * `(a, b)` and `(b, a)` are one logical relationship. As with active scenes,
 * a same-named object is not enough: legacy files can contain a non-unique or
 * directional index under the expected name. Keep conflict discovery,
 * attestation, index DDL, and readback in one transaction so startup cannot
 * bless a weakened or partially-installed constraint.
 */
function enforceUnorderedRelationshipInvariant(db: Database): void {
  const installIndex = db.transaction(() => {
    assertNoUnorderedRelationshipConflict(db);

    const existing = findSchemaObject(db, UNORDERED_RELATIONSHIP_INDEX);
    if (existing) assertUnorderedRelationshipIndex(db, existing);

    try {
      // Preserve db.run here: an actual unique-index build conflict must be
      // observable and translated to the legacy ambiguity diagnostic below.
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_relationships_unordered_pair
        ON relationships (
          CASE WHEN entity_a <= entity_b THEN entity_a ELSE entity_b END,
          CASE WHEN entity_a <= entity_b THEN entity_b ELSE entity_a END
        );
      `);
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      const message = error instanceof Error ? error.message : "";
      const isUniqueConstraint = code === "SQLITE_CONSTRAINT_UNIQUE" || message.includes("UNIQUE constraint failed");
      if (isUniqueConstraint) {
        const conflict = findUnorderedRelationshipConflict(db);
        if (conflict) throw unorderedRelationshipConflictError(conflict, error);
      }
      throw error;
    }

    const installed = findSchemaObject(db, UNORDERED_RELATIONSHIP_INDEX);
    if (!installed) throw unorderedRelationshipProtectionError("is missing after creation");
    assertUnorderedRelationshipIndex(db, installed);
    assertNoUnorderedRelationshipConflict(db);
  });
  installIndex();
}

function assertNoUnorderedRelationshipConflict(db: Database): void {
  const conflict = findUnorderedRelationshipConflict(db);
  if (conflict) throw unorderedRelationshipConflictError(conflict);
}

function assertUnorderedRelationshipIndex(db: Database, object: SchemaObjectRow): void {
  if (object.type !== "index" || object.tbl_name !== "relationships") {
    throw unorderedRelationshipProtectionError("is not an index on relationships");
  }
  if (!matchesSql(
    object.sql,
    /^createuniqueindex(?:ifnotexists)?idx_relationships_unordered_paironrelationships\(casewhenentity_a<=entity_bthenentity_aelseentity_bend,casewhenentity_a<=entity_bthenentity_belseentity_aend\)$/,
  )) {
    throw unorderedRelationshipProtectionError("does not have the required unordered CASE-expression definition");
  }

  const indexList = db.query("PRAGMA index_list(relationships)");
  let listed: Array<{ name: string; unique: number; partial: number }>;
  try {
    listed = indexList.all() as Array<{ name: string; unique: number; partial: number }>;
  } finally {
    indexList.finalize();
  }
  const metadata = listed.find((row) => row.name === UNORDERED_RELATIONSHIP_INDEX);
  if (!metadata || metadata.unique !== 1 || metadata.partial !== 0) {
    throw unorderedRelationshipProtectionError("is not a non-partial UNIQUE index");
  }

  const indexColumns = db.query("PRAGMA index_xinfo(idx_relationships_unordered_pair)");
  let columns: Array<{ seqno: number; cid: number; name: string | null; key: number }>;
  try {
    columns = indexColumns.all() as Array<{ seqno: number; cid: number; name: string | null; key: number }>;
  } finally {
    indexColumns.finalize();
  }
  const keyColumns = columns.filter((column) => column.key === 1);
  if (
    keyColumns.length !== 2
    || keyColumns[0]?.seqno !== 0 || keyColumns[0].cid !== -2 || keyColumns[0].name !== null
    || keyColumns[1]?.seqno !== 1 || keyColumns[1].cid !== -2 || keyColumns[1].name !== null
  ) {
    throw unorderedRelationshipProtectionError("does not contain exactly two expression key slots");
  }
}

function unorderedRelationshipProtectionError(reason: string): Error {
  return new Error(
    `Cannot validate unordered relationship durable protection: ${UNORDERED_RELATIONSHIP_INDEX} ${reason}; data was left unchanged.`,
  );
}

function findInvalidActiveScene(db: Database): { id: string; is_active: unknown } | null {
  const statement = db.query(`
    SELECT id, is_active
    FROM scenes
    WHERE is_active IS NULL OR is_active NOT IN (0, 1)
    ORDER BY id
    LIMIT 1
  `);
  try {
    return statement.get() as { id: string; is_active: unknown } | null;
  } finally {
    statement.finalize();
  }
}

function findMultipleActiveScenes(db: Database): string[] | null {
  const statement = db.query(`
    SELECT id
    FROM scenes
    WHERE is_active = 1
    ORDER BY id
    LIMIT 2
  `);
  try {
    const rows = statement.all() as Array<{ id: string }>;
    return rows.length > 1 ? rows.map((row) => row.id) : null;
  } finally {
    statement.finalize();
  }
}

function activeSceneBitError(scene: { id: string; is_active: unknown }): Error {
  return new Error(
    `Cannot enforce scenes.is_active invariant: scene ${JSON.stringify(scene.id)} has illegal is_active value ${JSON.stringify(scene.is_active)}; data was left unchanged.`,
  );
}

function multipleActiveScenesError(sceneIds: readonly string[]): Error {
  return new Error(
    `Cannot enforce scenes.is_active invariant: multiple active scenes exist (${sceneIds.map((id) => JSON.stringify(id)).join(", ")}); data was left unchanged.`,
  );
}

function findUnorderedRelationshipConflict(db: Database): { entity_a: string; entity_b: string } | null {
  const statement = db.query(`
    SELECT entity_a, entity_b
    FROM relationships
    GROUP BY
      CASE WHEN entity_a <= entity_b THEN entity_a ELSE entity_b END,
      CASE WHEN entity_a <= entity_b THEN entity_b ELSE entity_a END
    HAVING COUNT(*) > 1
    LIMIT 1
  `);
  try {
    return statement.get() as { entity_a: string; entity_b: string } | null;
  } finally {
    statement.finalize();
  }
}

function unorderedRelationshipConflictError(
  conflict: { entity_a: string; entity_b: string },
  cause?: unknown,
): Error {
  return new Error(
    `Cannot enforce unordered relationship uniqueness: existing reverse-direction relationship conflict for ${JSON.stringify([conflict.entity_a, conflict.entity_b])}; data was left unchanged.`,
    cause === undefined ? undefined : { cause },
  );
}
