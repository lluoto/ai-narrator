// bun test 的预载：把测试与「我这台机器上攒下来的数据」隔开。
//
// 起因：`src/db/index.ts` 的 NPC 库默认落在 `data/npc.db` —— 一个 gitignored
// 的本地文件。本机实测它攒了 19 条人格、**33309 条记忆**（来自真实跑局；
// 量过：跑一次全量测试行数一行不变，所以不是测试写进去的）。
//
// 问题不在写，在**读**：`NPCAgent.loadMemoriesFromDB()` 按名字把记忆取回来，
// 而测试里有 45 处 `new GameSession(...)`，每一处都会打开那个库。
// 于是「我这台机器」和「干净检出」跑的不是同一份数据。
//
// 实测目前测试对库里内容并不敏感（指向空库连跑三次，同样 1821 全过）——
// 也就是说这次**没有**掩盖任何问题。但那是当下的巧合，不是保证：
// 下一条依赖 NPC 记忆的测试写出来时，它会在我这儿绿、在别人那儿红。
// 与其等它发生，不如现在就让测试默认跑在干净检出的条件下。
//
// 留 `||=` 而不是硬写：想拿真实库复现问题时，`NPC_DB_PATH=data/npc.db` 仍然覆盖得了。
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll } from "bun:test";

// A preload runs in its own test-file context. It must not claim to configure
// a cross-file timeout: whole-suite timing belongs on Bun's CLI and exceptional
// filesystem fixtures declare their own bounded limit beside the test.

process.env.NPC_DB_PATH ||= ":memory:";

// Keep test-created careers out of the repository. An explicitly supplied root
// belongs to the caller and is never registered for cleanup here.
if (process.env.__CAREER_DIR === undefined) {
  const testCareerRoot = mkdtempSync(join(tmpdir(), "aitrpg-test-careers-"));
  process.env.__CAREER_DIR = testCareerRoot;
  let cleaned = false;
  const cleanupTestCareerRoot = () => {
    if (cleaned) return;
    cleaned = true;
    try { rmSync(testCareerRoot, { recursive: true, force: true }); } catch { /* best effort during process exit */ }
  };
  // `afterAll` covers Bun test workers; `exit` remains the synchronous last-resort cleanup.
  afterAll(cleanupTestCareerRoot);
  process.once("exit", cleanupTestCareerRoot);
}

// ── 测试默认不读取工作站世界模型 ──
//
// 世界模型和 Cthulhu 模型均可在开发机上指向仓库外的大文件。测试一旦继承
// 这些环境变量，就会加载机器私有语料、拖慢到超时且不再等价于 clean clone。
// 默认覆盖两条路径为每进程唯一、保证不存在的临时名；不创建任何文件。
// 真正的本地集成跑由显式 opt-in 控制，不能由 .env 隐式打开。
if (process.env.ALLOW_TEST_WORLD_MODEL !== "1") {
  const root = process.env.TEMP ?? process.env.TMP ?? ".opencode";
  const nonce = crypto.randomUUID();
  process.env.WORLD_MODEL_PATH = `${root}/aitrpg-test-world-model-${process.pid}-${nonce}.jsonl`;
  process.env.CTHULHU_MODEL_PATH = `${root}/aitrpg-test-cthulhu-model-${process.pid}-${nonce}.jsonl`;
}

// ── 测试默认离线 ──
//
// 同一个理由的第二例：**测试不该依赖网络**。
//
// 暴露它的是「给 GameSession 也接上 LLM 意图解析」那次改动。接上之后，
// 没有显式传 llmConfig 的测试会走 `loadConfig()` 读 `.env` 里的**真 key**，
// 于是 `bun test` 开始真的往 ECNU 打请求：单条测试从毫秒级涨到 1.2~5 秒，
// 并且开始超时变红。在此之前它只是没被触发，不是不存在 ——
// KP 叙事那条路一直有同样的口子。
//
// `LLM_DISABLED` 是仓库里既有的开关，`llmEnabled()` 是它唯一的判据
//（见 play-module.ts:101：曾经有两份判据，于是有 key 时这个开关拦不住打网络）。
// 在这里统一关掉，比让每个测试文件各自 beforeAll 一次可靠 ——
// 那种做法已经有过一份（module-loop.test.ts），而它只保护自己那个文件。
//
// 同样留 `||=`：要拿真 LLM 复现问题时，`LLM_DISABLED=false bun test` 覆盖得了。
process.env.LLM_DISABLED ||= "true";

// ── 测试里访问外网直接报错 ──
//
// `LLM_DISABLED` 只管住走 `llmEnabled()` 的那些路径。真正兜底的是这一条：
// 任何指向非本机地址的 fetch 一律拒绝。
//
// 逼出它的事故：全量输出里混进了真实的 LLM 回复 ——
//   play-logs\_api_cap_test.mjs  →  baseUrl: https://chat.ecnu.edu.cn/...
// 那是手工跑局留下的脚本，目录在 .gitignore 里，但 `bun test` 不看 gitignore，
// 文件名带 `_test` 就被当成测试执行了。**每一次全量测试都在拿真 key 打线上。**
// 已经用 bunfig 的 `root = "src"` 把发现范围收敛掉，
// 但那只解决「这一个文件」；这一条解决「任何一个」。
//
// 只放行本机：测试里连 127.0.0.1 是有意的（用「连不上」来验熔断、验降级）。
// 要拿真网络+LLM 集成复现时，显式设置
// `ALLOW_TEST_NETWORK=1 LLM_DISABLED=false bun test`；仅打开网络不会启用 LLM。
if (process.env.ALLOW_TEST_NETWORK !== "1") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input
      : input instanceof URL ? input.href
      : (input as { url: string }).url;
    let host = "";
    try { host = new URL(url).hostname; } catch { /* 相对地址交给原实现 */ }
    const local = host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "0.0.0.0";
    if (!local) {
      throw new Error(
        `测试里不许访问外网：${url}\n` +
        `（要拿真网络复现时用 ALLOW_TEST_NETWORK=1 bun test）`,
      );
    }
    return realFetch(input as never, init);
  }) as typeof fetch;
}
