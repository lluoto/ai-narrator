import { describe, expect, it } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listSessionMetadataLocators, listStoredSessions, saveSessionMeta, type SessionListingFileOps } from "../api/session-store";

const SESSION_METADATA_MAX_BYTES = 1024 * 1024;

function validMetadataAtByteLength(byteLength: number): string {
  const prefix = '{"createdAt":1,"ruleset":"r","playerName":"p","scene":"s","padding":"';
  const suffix = '"}';
  const paddingLength = byteLength - Buffer.byteLength(prefix, "utf8") - Buffer.byteLength(suffix, "utf8");
  if (paddingLength < 0) throw new Error("fixture byte length is too small");
  return `${prefix}${"x".repeat(paddingLength)}${suffix}`;
}

async function withTemporarySessionDirectory<T>(
  arrange: (sessionsDir: string) => void,
  run: (sessionsDir: string) => T | Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "session-store-resilience-"));
  const sessionsDir = join(root, "data", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  arrange(sessionsDir);

  try {
    return await run(sessionsDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function captureWarnings(): { warnings: string[]; restore(): void } {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
  return { warnings, restore: () => { console.warn = original; } };
}

function unsafeMetadataLinkOrLstatSeam(sessionsDir: string): SessionListingFileOps | undefined {
  const outsideMetadata = join(sessionsDir, "..", "valid-metadata-outside-sessions.json");
  const unsafeMetadata = join(sessionsDir, "unsafe.json");
  writeFileSync(outsideMetadata, JSON.stringify({
    createdAt: 99, ruleset: "dnd5e", playerName: "Bea", scene: "harbor",
  }), "utf8");
  try {
    symlinkSync(outsideMetadata, unsafeMetadata, "file");
    return undefined;
  } catch (error) {
    if ((error as { code?: string }).code !== "EPERM") throw error;
    // This Windows runner denies file-link creation. Materialize the same
    // valid outside metadata and use only the production lstat seam, so a
    // guard mutation still makes the real read/parse/listing path include it.
    writeFileSync(unsafeMetadata, readFileSync(outsideMetadata, "utf8"), "utf8");
    return {
      lstat(path) {
        if (path === unsafeMetadata) return { isFile: () => true, isSymbolicLink: () => true };
        return lstatSync(path);
      },
    };
  }
}

describe("listStoredSessions — 单个落盘会话损坏不能拖垮服务", () => {
  it("错误行为红线：跳过单文件损坏，验证字段边界，但仍上抛目录 I/O 错误", async () => {
    await withTemporarySessionDirectory((dir) => {
      writeFileSync(join(dir, "healthy.json"), JSON.stringify({
        createdAt: 42, ruleset: "cosmic-horror", playerName: "Ada", scene: "archive",
      }), "utf8");
      writeFileSync(join(dir, "broken.json"), "{ not json", "utf8");
    }, (sessionsDir) => {
      const captured = captureWarnings();
      try {
        // 损坏 JSON 不能使同目录的真实 session 从启动列表消失。
        expect(listStoredSessions(sessionsDir)).toEqual([
          { id: "healthy", createdAt: 42, ruleset: "cosmic-horror", playerName: "Ada", scene: "archive" },
        ]);
        expect(captured.warnings.some((warning) => warning.includes("broken.json"))).toBe(true);

        // 部分旧元数据仍是合法的；但落盘的列表字段若有错误类型，不能伪装成
        // 一个类型正确的 session 摘要。
        rmSync(sessionsDir, { recursive: true, force: true });
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(join(sessionsDir, "complete.json"), JSON.stringify({
          createdAt: 20, ruleset: "dnd5e", playerName: "Bea", scene: "harbor", bundleId: "bundle-a",
        }), "utf8");
        writeFileSync(join(sessionsDir, "legacy.json"), JSON.stringify({ lastActiveAt: 9, round: 3 }), "utf8");
        writeFileSync(join(sessionsDir, "bad-created-at.json"), JSON.stringify({
          createdAt: "not-a-timestamp", ruleset: "dnd5e", playerName: "Cai", scene: "mill",
        }), "utf8");
        writeFileSync(join(sessionsDir, "not-an-object.json"), JSON.stringify(["not", "metadata"]), "utf8");
        expect(listStoredSessions(sessionsDir)).toEqual([
          { id: "complete", createdAt: 20, ruleset: "dnd5e", playerName: "Bea", scene: "harbor", bundleId: "bundle-a" },
          { id: "legacy", createdAt: 0, ruleset: "unknown", playerName: "unknown", scene: "unknown" },
        ]);
        expect(captured.warnings.some((warning) => warning.includes("bad-created-at.json"))).toBe(true);
        expect(captured.warnings.some((warning) => warning.includes("not-an-object.json"))).toBe(true);

        // 逐文件恢复只包住 read/parse/shape：根目录不是目录时，真正的 I/O
        // 故障必须继续暴露给启动方，而不是被当成一份可跳过的坏 session。
        rmSync(sessionsDir, { recursive: true, force: true });
        writeFileSync(sessionsDir, "not a directory", "utf8");
        expect(() => listStoredSessions(sessionsDir)).toThrow();
      } finally {
        captured.restore();
      }
    });
  });
  it("does not follow a file symlink to otherwise valid metadata outside the sessions directory", async () => {
    let fileOps: SessionListingFileOps | undefined;
    await withTemporarySessionDirectory((dir) => {
      writeFileSync(join(dir, "healthy.json"), JSON.stringify({
        createdAt: 42, ruleset: "cosmic-horror", playerName: "Ada", scene: "archive",
      }), "utf8");
      fileOps = unsafeMetadataLinkOrLstatSeam(dir);
    }, (sessionsDir) => {
      const captured = captureWarnings();
      try {
        const listings = listStoredSessions(sessionsDir, fileOps);
        expect(listings).toEqual([
          { id: "healthy", createdAt: 42, ruleset: "cosmic-horror", playerName: "Ada", scene: "archive" },
        ]);
        expect(captured.warnings.some((warning) => warning.includes("unsafe.json"))).toBe(true);
      } finally {
        captured.restore();
      }
    });
  });
});

describe("session metadata resource and identity boundaries", () => {
  it("accepts exactly one MiB of valid metadata but skips an otherwise-valid byte-overflow record", async () => {
    await withTemporarySessionDirectory((dir) => {
      writeFileSync(join(dir, "at-limit.json"), validMetadataAtByteLength(SESSION_METADATA_MAX_BYTES), "utf8");
      writeFileSync(join(dir, "over-limit.json"), validMetadataAtByteLength(SESSION_METADATA_MAX_BYTES + 1), "utf8");
    }, (sessionsDir) => {
      const captured = captureWarnings();
      try {
        expect(listStoredSessions(sessionsDir)).toEqual([
          { id: "at-limit", createdAt: 1, ruleset: "r", playerName: "p", scene: "s" },
        ]);
        expect(captured.warnings.some((warning) => warning.includes("over-limit.json"))).toBe(true);
      } finally {
        captured.restore();
      }

      expect(listSessionMetadataLocators(sessionsDir)).toEqual([
        { id: "at-limit", kind: "regular", metadata: "valid" },
        { id: "over-limit", kind: "regular", metadata: "invalid" },
      ]);
    });
  });

  it("does not replacement-decode malformed UTF-8 into acceptable JSON", async () => {
    await withTemporarySessionDirectory((dir) => {
      writeFileSync(join(dir, "healthy.json"), JSON.stringify({
        createdAt: 2, ruleset: "r", playerName: "p", scene: "s",
      }), "utf8");
      const prefix = '{"createdAt":1,"ruleset":"r","playerName":"p","scene":"s","padding":"';
      writeFileSync(join(dir, "invalid-utf8.json"), Buffer.concat([
        Buffer.from(prefix, "utf8"), Buffer.from([0xc3, 0x28]), Buffer.from('"}', "utf8"),
      ]));
    }, (sessionsDir) => {
      const captured = captureWarnings();
      try {
        expect(listStoredSessions(sessionsDir)).toEqual([
          { id: "healthy", createdAt: 2, ruleset: "r", playerName: "p", scene: "s" },
        ]);
        expect(captured.warnings.some((warning) => warning.includes("invalid-utf8.json"))).toBe(true);
      } finally {
        captured.restore();
      }
      expect(listSessionMetadataLocators(sessionsDir)).toContainEqual({
        id: "invalid-utf8", kind: "regular", metadata: "invalid",
      });
    });
  });

  it("warns and skips a regular file replaced between the listing lstat and its pinned read", async () => {
    await withTemporarySessionDirectory((dir) => {
      writeFileSync(join(dir, "healthy.json"), JSON.stringify({
        createdAt: 2, ruleset: "r", playerName: "p", scene: "s",
      }), "utf8");
      writeFileSync(join(dir, "switched.json"), JSON.stringify({
        createdAt: 1, ruleset: "r", playerName: "p", scene: "s",
      }), "utf8");
    }, (sessionsDir) => {
      const switched = join(sessionsDir, "switched.json");
      let replacementMade = false;
      const fileOps: SessionListingFileOps = {
        lstat(path) {
          const before = lstatSync(path);
          if (path === switched && !replacementMade) {
            const replacement = join(sessionsDir, "replacement.tmp");
            writeFileSync(replacement, JSON.stringify({
              createdAt: 99, ruleset: "r", playerName: "p", scene: "s",
            }), "utf8");
            renameSync(replacement, switched);
            replacementMade = true;
          }
          return before;
        },
      };
      const captured = captureWarnings();
      try {
        expect(listStoredSessions(sessionsDir, fileOps)).toEqual([
          { id: "healthy", createdAt: 2, ruleset: "r", playerName: "p", scene: "s" },
        ]);
        expect(captured.warnings.some((warning) => warning.includes("switched.json"))).toBe(true);
      } finally {
        captured.restore();
      }
    });
  });

  // This intentionally creates 4,097 real root entries to exercise the cap
  // before JSON filtering. On managed Windows disks the bounded arrange and
  // cleanup can exceed Bun's default five-second test deadline; keep the
  // allowance local so a genuine hang still fails after twenty seconds.
  it("fails closed when every root entry, including non-JSON debris, exceeds the cap", async () => {
    await withTemporarySessionDirectory((dir) => {
      for (let index = 0; index < 4097; index++) writeFileSync(join(dir, `interrupted-write-${index}.tmp`), "x", "utf8");
    }, (sessionsDir) => {
      expect(() => listStoredSessions(sessionsDir)).toThrow();
      expect(() => listSessionMetadataLocators(sessionsDir)).toThrow();
    });
  }, 20_000);

  it("writes a bounded merged replacement through a private temporary file", async () => {
    await withTemporarySessionDirectory((dir) => {
      writeFileSync(join(dir, "merged.json"), '{"legacy":"retained"}', "utf8");
    }, (sessionsDir) => {
      saveSessionMeta("merged", { createdAt: 3, ruleset: "r", playerName: "p", scene: "s" }, sessionsDir);
      expect(JSON.parse(readFileSync(join(sessionsDir, "merged.json"), "utf8"))).toEqual({
        legacy: "retained", createdAt: 3, ruleset: "r", playerName: "p", scene: "s",
      });
      expect(readdirSync(sessionsDir).filter((name) => name.includes(".tmp"))).toEqual([]);
    });
  });

  it("rejects oversized saves before creating a temp or changing the previous target", async () => {
    await withTemporarySessionDirectory((dir) => {
      writeFileSync(join(dir, "preserve.json"), '{"legacy":"previous bytes must survive"}', "utf8");
    }, (sessionsDir) => {
      const target = join(sessionsDir, "preserve.json");
      const before = readFileSync(target);
      expect(() => saveSessionMeta("preserve", { padding: "x".repeat(SESSION_METADATA_MAX_BYTES) }, sessionsDir)).toThrow();
      expect(readFileSync(target)).toEqual(before);
      expect(readdirSync(sessionsDir).filter((name) => name.includes(".tmp"))).toEqual([]);
    });
  });
});
