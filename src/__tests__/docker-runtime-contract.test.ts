import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import { DEFAULT_SERVER_SHUTDOWN_GRACE_MS } from "../api/server-shutdown";

const dockerfile = readFileSync(resolve(import.meta.dir, "..", "..", "Dockerfile"), "utf8");
const dockerfileLines = dockerfile.split(/\r?\n/);
const environmentExample = readFileSync(resolve(import.meta.dir, "..", "..", ".env.example"), "utf8");
const dockerignore = readFileSync(resolve(import.meta.dir, "..", "..", ".dockerignore"), "utf8");
const compose = parse(readFileSync(resolve(import.meta.dir, "..", "..", "docker-compose.yml"), "utf8")) as {
  services?: Record<string, Record<string, unknown>>;
};
const runtimeStageStart = dockerfileLines.lastIndexOf("FROM oven/bun:${BUN_VERSION}-slim");

function uniqueRuntimeLine(line: string): number {
  if (runtimeStageStart < 0) throw new Error("Docker runtime stage is missing");
  const matches = dockerfileLines
    .map((value, index) => ({ value, index }))
    .filter(({ value, index }) => index > runtimeStageStart && value === line);
  expect(matches).toHaveLength(1);
  return matches[0]!.index;
}

describe("Docker runtime contract", () => {
  test("pins one Bun version across the frontend build and slim runtime", () => {
    expect(dockerfileLines.filter((line) => line === "ARG BUN_VERSION=1.3.14")).toHaveLength(1);
    expect(dockerfileLines).toContain("FROM oven/bun:${BUN_VERSION} AS frontend-build");
    expect(dockerfileLines).toContain("FROM oven/bun:${BUN_VERSION}-slim");
  });

  test("uses frozen installs without a production fallback that can drift from bun.lock", () => {
    expect(dockerfileLines).toContain("RUN bun install --frozen-lockfile");
    expect(dockerfileLines).toContain("RUN bun install --frozen-lockfile --production");
    expect(dockerfile).not.toMatch(/\|\|\s*bun\s+install\b/);
  });

  test("declares one bounded exec-form Bun liveness healthcheck without shell tools", () => {
    const healthchecks = dockerfileLines.filter((line) => line.startsWith("HEALTHCHECK"));
    expect(healthchecks).toEqual([
      'HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun", "src/api/container-healthcheck.ts"]',
    ]);
    expect(healthchecks[0]).not.toContain("CMD-SHELL");
    expect(healthchecks[0]).not.toMatch(/\b(?:curl|wget|sh|bash)\b/i);
  });

  test("gives the direct Bun server a SIGTERM grace period longer than its application drain", () => {
    const service = compose.services?.trpg;
    expect(service).toBeDefined();
    expect(service?.stop_signal).toBe("SIGTERM");
    expect(service?.stop_grace_period).toBe("20s");
    expect(dockerfileLines.filter((line) => line.startsWith("CMD "))).toEqual(['CMD ["bun", "src/api/server.ts"]']);

    const grace = service?.stop_grace_period;
    if (typeof grace !== "string") throw new Error("trpg stop_grace_period must be a Compose duration string");
    const seconds = /^(\d+(?:\.\d+)?)s$/.exec(grace);
    if (!seconds) throw new Error("trpg stop_grace_period must use seconds");
    expect(Number(seconds[1]) * 1_000).toBeGreaterThan(DEFAULT_SERVER_SHUTDOWN_GRACE_MS);
  });

  test("prepares writable data and root-owned world-model mount points before dropping runtime privileges", () => {
    const prepareData = "RUN mkdir -p /app/data /app/assets /app/world-model-policy /app/cthulhu-dataset && chown bun:bun /app/data && chmod 0555 /app/assets /app/world-model-policy /app/cthulhu-dataset";
    const volume = 'VOLUME [ "/app/data" ]';
    const user = "USER bun";
    const healthcheck = 'HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun", "src/api/container-healthcheck.ts"]';
    const command = 'CMD ["bun", "src/api/server.ts"]';
    const runtimeLines = dockerfileLines.slice(runtimeStageStart + 1);

    const prepareIndex = uniqueRuntimeLine(prepareData);
    const volumeIndex = uniqueRuntimeLine(volume);
    const userIndex = uniqueRuntimeLine(user);
    const healthcheckIndex = uniqueRuntimeLine(healthcheck);
    const commandIndex = uniqueRuntimeLine(command);

    expect(prepareIndex).toBeLessThan(volumeIndex);
    expect(volumeIndex).toBeLessThan(userIndex);
    expect(userIndex).toBeLessThan(healthcheckIndex);
    expect(healthcheckIndex).toBeLessThan(commandIndex);
    expect(runtimeLines.filter((line) => line.startsWith("USER "))).toEqual([user]);
    expect(runtimeLines.filter((line) => /\bchown\b/.test(line))).toEqual([prepareData]);
    expect(runtimeLines.join("\n")).not.toMatch(/\bchown\b[^\n]*\s\/app(?:\s|$)/);
  });

  test("documents the current Cthulhu aggregate location", () => {
    expect(environmentExample).toContain(
      "# CTHULHU_MODEL_PATH=../世界模型/datasets/cthulhu/extracted/cthulhu_world_model.jsonl",
    );
  });

  test("keeps external world models out of the image and mounts them only through the explicit read-only override", () => {
    const runtimeLines = dockerfileLines.slice(runtimeStageStart + 1);
    expect(runtimeLines.join("\n")).not.toMatch(/^COPY\s+assets\/?\s+\.\/assets\/?$/m);
    expect(runtimeLines).toContain("RUN mkdir -p /app/data /app/assets /app/world-model-policy /app/cthulhu-dataset && chown bun:bun /app/data && chmod 0555 /app/assets /app/world-model-policy /app/cthulhu-dataset");
    expect(dockerignore.split(/\r?\n/)).toContain("assets/");

    const baseEnvironment = compose.services?.trpg?.environment;
    if (!Array.isArray(baseEnvironment)) throw new Error("base Compose service environment must be an array");
    expect(baseEnvironment).toContain("COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH=${COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH:-}");
    expect(baseEnvironment).toContain("CTHULHU_DATASET_PATH=${CTHULHU_DATASET_PATH:-}");

    const override = parse(readFileSync(resolve(import.meta.dir, "..", "..", "docker-compose.world-model.yml"), "utf8")) as {
      services?: Record<string, Record<string, unknown>>;
    };
    const service = override.services?.trpg;
    expect(service?.environment).toEqual({
      WORLD_MODEL_PATH: "/app/assets/v18_all_master.jsonl",
      CTHULHU_MODEL_PATH: "/app/assets/cthulhu_world_model.jsonl",
      COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH: "/app/world-model-policy/compiled-cthulhu-world-model-policy.json",
      CTHULHU_DATASET_PATH: "/app/cthulhu-dataset",
    });
    expect(service?.volumes).toEqual([
      {
        type: "bind",
        source: "${WORLD_MODEL_ASSETS_DIR:?set WORLD_MODEL_ASSETS_DIR to the host legacy assets directory}",
        target: "/app/assets",
        read_only: true,
      },
      {
        type: "bind",
        source: "${COMPILED_CTHULHU_WORLD_MODEL_POLICY_HOST_PATH:?set COMPILED_CTHULHU_WORLD_MODEL_POLICY_HOST_PATH to the reviewed policy file}",
        target: "/app/world-model-policy/compiled-cthulhu-world-model-policy.json",
        read_only: true,
      },
      {
        type: "bind",
        source: "${CTHULHU_DATASET_HOST_PATH:?set CTHULHU_DATASET_HOST_PATH to the host Cthulhu dataset root}",
        target: "/app/cthulhu-dataset",
        read_only: true,
      },
    ]);
  });
});
