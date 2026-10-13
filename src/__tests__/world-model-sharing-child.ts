import { resolve } from "path";

// This program has one JSON record on stdout. Runtime imports may initialise
// optional tables noisily, so silence only normal output before importing them;
// error output stays intact for the parent process to diagnose a failure.
console.log = () => undefined;
console.warn = () => undefined;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const worldPath = process.env.WORLD_MODEL_PATH;
const cthulhuPath = process.env.CTHULHU_MODEL_PATH;
requireCondition(typeof worldPath === "string" && worldPath.length > 0, "child requires WORLD_MODEL_PATH");
requireCondition(typeof cthulhuPath === "string" && cthulhuPath.length > 0, "child requires CTHULHU_MODEL_PATH");

const [{ GameSession }, { DEFAULT_CTHULHU_PATH, DEFAULT_V18_PATH, WorldModelLoader, sharedWorldModel }] = await Promise.all([
  import("../api/game-session"),
  import("../world/world-model-loader"),
]);

const config = { apiKey: "", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };
const originalLoad = WorldModelLoader.prototype.load;
const expectedWorldPath = resolve(worldPath);
const expectedCthulhuPath = resolve(cthulhuPath);
let defaultV18Loads = 0;
let defaultCthulhuLoads = 0;

WorldModelLoader.prototype.load = function countedDefaultLoad(path = DEFAULT_V18_PATH) {
  const resolvedPath = resolve(path);
  if (resolvedPath === expectedWorldPath) defaultV18Loads++;
  if (resolvedPath === expectedCthulhuPath) defaultCthulhuLoads++;
  return originalLoad.call(this, path);
};

let first: InstanceType<typeof GameSession> | undefined;
let second: InstanceType<typeof GameSession> | undefined;
let proof: Record<string, unknown> | undefined;
try {
  // These are ordinary default GameSession instances: no loader dependency is
  // injected. The child environment selects a tiny local default corpus before
  // either module is imported, so this is a real lazy-load path without the
  // 383k production corpus or a network request.
  first = new GameSession(
    "world-sharing-child-first", "cosmic-horror", config,
    undefined, undefined, undefined, undefined, undefined, undefined,
    { worldModelNovel: "child-work" },
  );
  (first as unknown as { injectWorldModelForScene(): void }).injectWorldModelForScene();
  requireCondition(first.worldModel.isLoaded(), "first default session did not observe a loaded v18 model");
  requireCondition(sharedWorldModel().isLoaded(), "default factory did not observe the session's v18 load");
  requireCondition(defaultV18Loads === 1, `first default session loaded v18 ${defaultV18Loads} times`);
  requireCondition(first.cthulhuLoader.isLoaded(), "first default session did not observe a loaded Cthulhu model");
  requireCondition(sharedWorldModel(DEFAULT_CTHULHU_PATH).isLoaded(), "default Cthulhu factory did not observe the session's load");
  requireCondition(defaultCthulhuLoads === 1, `first default session loaded Cthulhu ${defaultCthulhuLoads} times`);

  second = new GameSession(
    "world-sharing-child-second", "cosmic-horror", config,
    undefined, undefined, undefined, undefined, undefined, undefined,
    { worldModelNovel: "child-work" },
  );
  (second as unknown as { injectWorldModelForScene(): void }).injectWorldModelForScene();
  const secondEntries = second.worldModel.getByNovel("child-work");
  const secondStats = second.worldModel.getNovelStats("child-work");
  const secondCthulhuEntries = second.cthulhuLoader.getByNovel("child-work");
  const secondCthulhuStats = second.cthulhuLoader.getNovelStats("child-work");
  requireCondition(defaultV18Loads === 1, `second default session reloaded v18 (${defaultV18Loads})`);
  requireCondition(defaultCthulhuLoads === 1, `second default session reloaded Cthulhu (${defaultCthulhuLoads})`);
  requireCondition(second.worldModel.isLoaded(), "second facade did not observe the existing load");
  requireCondition(secondEntries.length === 1 && secondEntries[0]?.name === "child canonical relation", "second facade did not observe shared model content");
  requireCondition(secondStats.total === 1 && secondStats.byType.faction_relation === 1, "second facade did not observe shared model statistics");
  requireCondition(secondCthulhuEntries.length === 1 && secondCthulhuEntries[0]?.name === "child canonical deity", "second facade did not observe shared Cthulhu content");
  requireCondition(secondCthulhuStats.total === 1 && secondCthulhuStats.byType.deity === 1, "second facade did not observe shared Cthulhu statistics");
  requireCondition(first.worldModel !== second.worldModel, "sessions exposed a shared raw world-model capability");
  requireCondition(first.cthulhuLoader !== second.cthulhuLoader, "sessions exposed a shared raw Cthulhu capability");
  requireCondition(Object.isFrozen(first.worldModel) && Object.isFrozen(second.worldModel), "session world-model facades are not frozen");
  requireCondition(Object.isFrozen(first.cthulhuLoader) && Object.isFrozen(second.cthulhuLoader), "session Cthulhu facades are not frozen");
  requireCondition((first.worldModel as Record<string, unknown>).load === undefined, "session world-model facade leaked load authority");
  requireCondition((first.cthulhuLoader as Record<string, unknown>).load === undefined, "session Cthulhu facade leaked load authority");
  requireCondition(sharedWorldModel() === sharedWorldModel(DEFAULT_V18_PATH), "default v18 factory split its path bucket");
  requireCondition(sharedWorldModel(DEFAULT_CTHULHU_PATH) === sharedWorldModel(cthulhuPath), "default Cthulhu factory split its path bucket");
  proof = {
    defaultV18Loads,
    defaultCthulhuLoads,
    entryCount: secondEntries.length,
    stats: secondStats.total,
    cthulhuEntryCount: secondCthulhuEntries.length,
    cthulhuStats: secondCthulhuStats.total,
  };
} finally {
  WorldModelLoader.prototype.load = originalLoad;
  try { second?.close(); } finally { first?.close(); }
}

await Bun.write(Bun.stdout, `${JSON.stringify(proof)}\n`);
