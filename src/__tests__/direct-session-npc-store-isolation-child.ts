const [configuredSharedPath] = process.argv.slice(2);
if (!configuredSharedPath) throw new Error("direct NPC-store isolation child requires a database path");

// This must precede the dynamic import: db/index captures NPC_DB_PATH at
// module evaluation. A regression to `new NPCStore()` therefore makes two
// default GameSessions share this file in the child process.
process.env.NPC_DB_PATH = configuredSharedPath;

const { GameSession } = await import("../api/game-session");

const config = {
  apiKey: "sk-placeholder", baseUrl: "http://localhost:9999",
  model: "mock", maxTokens: 512, temperature: 0.7,
};
const loadBarn = "\u52a0\u8f7d\u6a21\u7ec4 \u666e\u745e\u7c73\u5c14\u7684\u8c37\u4ed3";

const first = new GameSession("direct-default-first", "cosmic-horror", config, "investigator", "Ada");
const second = new GameSession("direct-default-second", "cosmic-horror", config, "investigator", "Bea");
try {
  const loadedFirst = await first.act(loadBarn);
  if (loadedFirst.error) throw new Error(`first module load failed: ${loadedFirst.error}`);
  const leaked = second.npcStore.getAllPersonalities().length !== 0;
  first.close();
  const loadedSecond = await second.act(loadBarn);
  if (loadedSecond.error) throw new Error(`second module load failed: ${loadedSecond.error}`);
  console.log(JSON.stringify({
    leaked,
    secondUsableAfterFirstClose: second.npcStore.getAllPersonalities().length > 0,
  }));
} finally {
  first.close();
  second.close();
}

export {};
