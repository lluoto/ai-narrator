// 世界模型 loader 必须进程内共享，不能按会话各建一份
//
// 取证（真实服务日志，3 个会话各跑 1 回合）：
//   🌐 世界模型 v18 已加载: 383688 条 | 73 部小说 | 424 种类型 | 1.3s   ← 会话 1
//   🌐 世界模型 v18 已加载: 383688 条 | 73 部小说 | 424 种类型 | 1.2s   ← 会话 2
//   🌐 世界模型 v18 已加载: 383688 条 | 73 部小说 | 424 种类型 | 1.2s   ← 会话 3
// 服务进程驻留 1938 MB。磁盘上已有 41 个存档会话，按原样逐个恢复必然打爆内存。
//
// 根因：GameSession 构造函数为每个会话各 `new WorldModelLoader()`。构造函数里的
// 懒加载注释只解决了「不在构造时加载」，没解决「每会话各加载一份」。
//
// 这两份是只读参考数据，不是会话状态：loader 的全部可变状态都在 load() 里
// 一次性建好，之后所有公开方法只读。
//
// bun test src/__tests__/world-model-sharing.test.ts

import { afterEach, describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { join } from "path";
import { GameSession } from "../api/game-session";
import { sharedWorldModel, DEFAULT_CTHULHU_PATH, DEFAULT_V18_PATH, WorldModelLoader } from "../world/world-model-loader";

const LLM = {
  apiKey: "",
  baseUrl: "http://offline.invalid",
  model: "mock",
  maxTokens: 1024,
  temperature: 0.7,
};

const sessions: GameSession[] = [];

function makeSession(id: string): GameSession {
  const session = new GameSession(id, "cosmic-horror", LLM, "investigator", "调查员");
  sessions.push(session);
  return session;
}

type DefaultSharingProof = {
  defaultV18Loads: number;
  defaultCthulhuLoads: number;
  entryCount: number;
  stats: number;
  cthulhuEntryCount: number;
  cthulhuStats: number;
};

async function runDefaultSessionSharingProof(worldPath: string, cthulhuPath: string): Promise<DefaultSharingProof> {
  const childPath = fileURLToPath(new URL("./world-model-sharing-child.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, childPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WORLD_MODEL_PATH: worldPath,
      CTHULHU_MODEL_PATH: cthulhuPath,
      LLM_DISABLED: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain both pipes concurrently: awaiting one can deadlock a noisy child.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const outputBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  if (outputBytes > 64 * 1024) throw new Error(`world-sharing child output exceeded protocol limit (${outputBytes} bytes)`);
  if (exitCode !== 0) throw new Error(`world-sharing child exited ${exitCode}: ${stderr || stdout}`);
  let proof: unknown;
  try { proof = JSON.parse(stdout); } catch { throw new Error(`world-sharing child emitted invalid proof: ${stdout}`); }
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new Error("world-sharing child proof was not an object");
  const record = proof as Record<string, unknown>;
  if (!Number.isSafeInteger(record.defaultV18Loads)
    || !Number.isSafeInteger(record.defaultCthulhuLoads)
    || !Number.isSafeInteger(record.entryCount)
    || !Number.isSafeInteger(record.stats)
    || !Number.isSafeInteger(record.cthulhuEntryCount)
    || !Number.isSafeInteger(record.cthulhuStats)) {
    throw new Error("world-sharing child proof has invalid numeric fields");
  }
  return record as DefaultSharingProof;
}

afterEach(() => {
  const closing = sessions.splice(0);
  let failure: unknown;
  for (const session of closing) {
    try { session.close(); } catch (error) { failure ??= error; }
  }
  if (failure !== undefined) throw failure;
});

describe("世界模型 loader 共享", () => {
  it("同一路径重复取用返回同一个实例", () => {
    expect(sharedWorldModel()).toBe(sharedWorldModel());
    expect(sharedWorldModel(DEFAULT_V18_PATH)).toBe(sharedWorldModel());
  });

  it("不同路径分桶，互不串用", () => {
    const a = sharedWorldModel("path/a.jsonl");
    const b = sharedWorldModel("path/b.jsonl");
    expect(a).not.toBe(b);
    expect(sharedWorldModel("path/a.jsonl")).toBe(a);
  });

  it("默认会话共享底层 v18 数据，但各自只发布不可写观察 facade", () => {
    const s1 = makeSession("share-1");
    const s2 = makeSession("share-2");
    const s3 = makeSession("share-3");

    // The factory proves the default raw resource is one instance; GameSession
    // deliberately does not publish that identity as a mutable capability.
    expect(sharedWorldModel()).toBe(sharedWorldModel(DEFAULT_V18_PATH));
    expect(s1.worldModel).not.toBe(s2.worldModel);
    expect(s2.worldModel).not.toBe(s3.worldModel);
    for (const session of [s1, s2, s3]) {
      expect(Object.isFrozen(session.worldModel)).toBe(true);
      expect((session.worldModel as any).load).toBeUndefined();
      expect(session.worldModel.isLoaded()).toBe(sharedWorldModel().isLoaded());
    }
  });

  it("默认会话在隔离进程只加载一次本地 v18 fixture，随后 facade 观察相同内容", async () => {
    const root = mkdtempSync(join(tmpdir(), "world-model-session-sharing-"));
    try {
      const worldPath = join(root, "world.jsonl");
      const cthulhuPath = join(root, "cthulhu.jsonl");
      writeFileSync(worldPath, JSON.stringify({
        type: "faction_relation", chapter: "1", novel: "child-work",
        name: "child canonical relation", description: "child fixture",
      }), "utf8");
      writeFileSync(cthulhuPath, JSON.stringify({
        type: "deity", chapter: "1", novel: "child-work",
        name: "child canonical deity", mechanic: "child fixture",
      }), "utf8");
      const proof = await runDefaultSessionSharingProof(worldPath, cthulhuPath);
      expect(proof).toEqual({
        defaultV18Loads: 1,
        defaultCthulhuLoads: 1,
        entryCount: 1,
        stats: 1,
        cthulhuEntryCount: 1,
        cthulhuStats: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("默认会话共享底层克苏鲁数据，但不泄漏其 loader identity", () => {
    const s1 = makeSession("share-4");
    const s2 = makeSession("share-5");

    expect(sharedWorldModel(DEFAULT_CTHULHU_PATH)).toBe(sharedWorldModel(DEFAULT_CTHULHU_PATH));
    expect(sharedWorldModel(DEFAULT_CTHULHU_PATH)).not.toBe(sharedWorldModel(DEFAULT_V18_PATH));
    expect(s1.cthulhuLoader).not.toBe(s2.cthulhuLoader);
    expect(s1.cthulhuLoader).not.toBe(s1.worldModel);
    for (const session of [s1, s2]) {
      expect(Object.isFrozen(session.cthulhuLoader)).toBe(true);
      expect((session.cthulhuLoader as any).load).toBeUndefined();
      expect(session.cthulhuLoader.isLoaded()).toBe(sharedWorldModel(DEFAULT_CTHULHU_PATH).isLoaded());
    }
  });

  it("会话之间共享，因此第二个会话看到的是第一个的加载结果", () => {
    // 不实际读 240MB 的主库：用一个独立路径桶模拟「已加载」状态的可见性。
    const probePath = "probe/shared-visibility.jsonl";
    const first = sharedWorldModel(probePath);
    const second = sharedWorldModel(probePath);
    expect(second.isLoaded()).toBe(first.isLoaded());
    expect(second).toBe(first);
  });

  it("独立共享工厂仍返回 loader；会话 facade 不倒灌该写能力", () => {
    const loader = sharedWorldModel("probe/interface.jsonl");
    expect(loader).toBeInstanceOf(WorldModelLoader);
    expect(typeof loader.isLoaded).toBe("function");
    expect(typeof loader.getByType).toBe("function");
    const session = makeSession("share-facade");
    expect(session.worldModel).not.toBe(loader);
    expect((session.worldModel as any).consumeCausal).toBeUndefined();
  });
});
