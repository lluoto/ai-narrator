import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../ingest/document-ir";
import { CompiledWorldModelBindingRegistry } from "../world/compiled-world-model-binding-registry";

const roots = new Set<string>();
const DATASET_ROOT = process.env.CTHULHU_DATASET_PATH ?? "D:\\aitrpg\\世界模型\\datasets\\cthulhu";

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "compiled-world-model-binding-registry-"));
  roots.add(value);
  return value;
}

function entry(moduleId: string, artifactHash: string, allowedWorkIds = ["the_call_of_cthulhu"]): Record<string, unknown> {
  return { moduleId, artifactHash, allowedWorkIds, corpusScopeId: null, transferPolicy: "analogy_only" };
}

function policy(bindings: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ schemaVersion: "1.0.0", kind: "compiled_cthulhu_world_model_policy", bindings });
}

function sourceProfile(moduleId: string, documentHash: string, allowedWorkIds = ["the_call_of_cthulhu"]): Record<string, unknown> {
  return { moduleId, documentHash, allowedWorkIds, corpusScopeId: null, transferPolicy: "analogy_only" };
}

function profilePolicy(bindings: readonly Record<string, unknown>[], sourceProfiles: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ schemaVersion: "1.1.0", kind: "compiled_cthulhu_world_model_policy", bindings, sourceProfiles });
}

function environment(policyPath: string | undefined, datasetPath: string | undefined = DATASET_ROOT) {
  return {
    ...(policyPath === undefined ? {} : { COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH: policyPath }),
    ...(datasetPath === undefined ? {} : { CTHULHU_DATASET_PATH: datasetPath }),
  };
}

describe("compiled world-model binding registry", () => {
  test("is disabled only when the policy and dataset environment pair are both absent or blank", () => {
    for (const env of [{}, environment("", " ")]) {
      const registry = new CompiledWorldModelBindingRegistry(env);
      expect(registry.status).toEqual({ enabled: false, policyHash: null, bindingCount: 0, datasetId: null, datasetVersion: null });
      expect(registry.resolve({ moduleId: "module", artifactHash: "a".repeat(64), documentHash: null })).toBeUndefined();
    }
    for (const env of [environment("policy.json", undefined), environment(undefined, DATASET_ROOT), environment(" ", DATASET_ROOT)]) {
      expect(() => new CompiledWorldModelBindingRegistry(env)).toThrow();
    }
  });

  test("mints immutable, fully validated bindings only for an exact module and artifact tuple", () => {
    const workspace = root();
    const path = join(workspace, "policy.json");
    const aHash = "a".repeat(64), bHash = "b".repeat(64);
    const bytes = policy([
      entry("module-a", aHash, ["the_call_of_cthulhu"]),
      entry("module-b", bHash, ["the_dunwich_horror"]),
    ]);
    writeFileSync(path, bytes, "utf8");
    const registry = new CompiledWorldModelBindingRegistry(environment(path));

    expect(registry.status).toEqual({
      enabled: true, policyHash: sha256(bytes), bindingCount: 2,
      datasetId: "cthulhu-gutenberg-source-bound", datasetVersion: "1",
    });
    expect(registry.resolve({ moduleId: "module-a", artifactHash: aHash, documentHash: null })).toMatchObject({ allowedWorkIds: ["the_call_of_cthulhu"] });
    expect(registry.resolve({ moduleId: "module-b", artifactHash: bHash, documentHash: null })).toMatchObject({ allowedWorkIds: ["the_dunwich_horror"] });
    expect(registry.resolve({ moduleId: "module-a", artifactHash: bHash, documentHash: null })).toBeUndefined();
    expect(registry.resolve({ moduleId: "module-b", artifactHash: aHash, documentHash: null })).toBeUndefined();
    expect(registry.resolve({ moduleId: "module-missing", artifactHash: aHash, documentHash: null })).toBeUndefined();
    // Exact legacy bindings still require a real resolved artifact; the fresh
    // live preflight query must not upgrade them into source profiles.
    expect(registry.hasSourceProfile("module-a", "d".repeat(64))).toBeFalse();
    expect(Object.isFrozen(registry.status)).toBe(true);
  });

  test("mints a fresh artifact binding only for an operator-profiled exact module and PDF hash", () => {
    const workspace = root();
    const path = join(workspace, "policy.json");
    const documentHash = "d".repeat(64);
    writeFileSync(path, profilePolicy([], [
      sourceProfile("fresh-module", documentHash, ["the_call_of_cthulhu"]),
      sourceProfile("other-module", documentHash, ["the_dunwich_horror"]),
    ]), "utf8");

    const registry = new CompiledWorldModelBindingRegistry(environment(path));
    expect(registry.status.bindingCount).toBe(2);
    expect(registry.hasSourceProfile("fresh-module", documentHash)).toBeTrue();
    expect(registry.hasSourceProfile("other-module", documentHash)).toBeTrue();
    expect(registry.hasSourceProfile("fresh-module", "e".repeat(64))).toBeFalse();
    expect(registry.hasSourceProfile("wrong-module", documentHash)).toBeFalse();
    const first = registry.resolve({ moduleId: "fresh-module", artifactHash: "a".repeat(64), documentHash } as never);
    const second = registry.resolve({ moduleId: "fresh-module", artifactHash: "b".repeat(64), documentHash } as never);
    const other = registry.resolve({ moduleId: "other-module", artifactHash: "c".repeat(64), documentHash } as never);
    expect(first).toMatchObject({ moduleId: "fresh-module", artifactHash: "a".repeat(64), allowedWorkIds: ["the_call_of_cthulhu"] });
    expect(second).toMatchObject({ moduleId: "fresh-module", artifactHash: "b".repeat(64), allowedWorkIds: ["the_call_of_cthulhu"] });
    expect(other).toMatchObject({ moduleId: "other-module", artifactHash: "c".repeat(64), allowedWorkIds: ["the_dunwich_horror"] });
    expect(registry.resolve({ moduleId: "fresh-module", artifactHash: "c".repeat(64), documentHash: "e".repeat(64) } as never)).toBeUndefined();
    expect(registry.resolve({ moduleId: "wrong-module", artifactHash: "a".repeat(64), documentHash } as never)).toBeUndefined();
  });

  test("fails closed for an unavailable profile document hash while retaining a non-conflicting legacy exact binding", () => {
    const workspace = root();
    const path = join(workspace, "policy.json");
    const documentHash = "d".repeat(64);
    const exactHash = "a".repeat(64);
    writeFileSync(path, profilePolicy([
      entry("mixed-module", exactHash, ["the_dunwich_horror"]),
    ], [
      sourceProfile("mixed-module", documentHash, ["the_call_of_cthulhu"]),
      sourceProfile("profile-only", documentHash, ["the_call_of_cthulhu"]),
    ]), "utf8");
    const registry = new CompiledWorldModelBindingRegistry(environment(path));

    expect(registry.resolve({ moduleId: "mixed-module", artifactHash: exactHash, documentHash: null } as never))
      .toMatchObject({ allowedWorkIds: ["the_dunwich_horror"] });
    expect(() => registry.resolve({ moduleId: "profile-only", artifactHash: "b".repeat(64), documentHash: null } as never)).toThrow();
    expect(() => registry.resolve({ moduleId: "profile-only", artifactHash: "b".repeat(64), documentHash: "not-a-hash" } as never)).toThrow();
    expect(() => registry.resolve({ moduleId: "mixed-module", artifactHash: exactHash, documentHash } as never)).toThrow();
  });

  test("fails closed on an untrusted policy shape, duplicate tuple, invalid scope, unsafe policy leaf, or oversized policy", () => {
    const workspace = root();
    const path = join(workspace, "policy.json");
    const valid = entry("module-a", "a".repeat(64));
    const invalidPolicies: unknown[] = [
      {},
      { schemaVersion: "1.0.0", kind: "compiled_cthulhu_world_model_policy", bindings: [] },
      { schemaVersion: "1.0.0", kind: "compiled_cthulhu_world_model_policy", bindings: [valid], datasetRoot: DATASET_ROOT },
      { schemaVersion: "1.0.0", kind: "compiled_cthulhu_world_model_policy", bindings: [{ ...valid, extra: true }] },
      { schemaVersion: "1.0.0", kind: "compiled_cthulhu_world_model_policy", bindings: [valid, { ...valid }] },
      { schemaVersion: "1.0.0", kind: "compiled_cthulhu_world_model_policy", bindings: [{ ...valid, moduleId: " module-a" }] },
      { schemaVersion: "1.0.0", kind: "compiled_cthulhu_world_model_policy", bindings: [{ ...valid, moduleId: "module-a " }] },
      { schemaVersion: "1.0.0", kind: "compiled_cthulhu_world_model_policy", bindings: [{ ...valid, allowedWorkIds: ["unsupported-work"] }] },
      { schemaVersion: "1.0.0", kind: "compiled_cthulhu_world_model_policy", bindings: [{ ...valid, allowedWorkIds: ["the_dunwich_horror", "the_call_of_cthulhu"] }] },
      { schemaVersion: "1.0.0", kind: "compiled_cthulhu_world_model_policy", bindings: [{ ...valid, transferPolicy: "plot_copy" }] },
    ];
    for (const invalid of invalidPolicies) {
      writeFileSync(path, JSON.stringify(invalid), "utf8");
      expect(() => new CompiledWorldModelBindingRegistry(environment(path))).toThrow();
    }
    writeFileSync(path, Buffer.from([0xc3, 0x28]));
    expect(() => new CompiledWorldModelBindingRegistry(environment(path))).toThrow();
    writeFileSync(path, "x".repeat(1_048_577), "utf8");
    expect(() => new CompiledWorldModelBindingRegistry(environment(path))).toThrow();

    rmSync(path);
    mkdirSync(path);
    expect(() => new CompiledWorldModelBindingRegistry(environment(path))).toThrow();
    rmSync(path, { recursive: true });
    const target = join(workspace, "target.json");
    writeFileSync(target, policy([valid]), "utf8");
    try {
      symlinkSync(target, path, "file");
      expect(() => new CompiledWorldModelBindingRegistry(environment(path))).toThrow();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });

  test("rejects malformed, duplicate, wildcard, or dataset-invalid source profiles at startup", () => {
    const workspace = root();
    const path = join(workspace, "policy.json");
    const valid = sourceProfile("profiled-module", "c".repeat(64));
    const invalidPolicies: unknown[] = [
      { schemaVersion: "1.1.0", kind: "compiled_cthulhu_world_model_policy", bindings: [], sourceProfiles: [] },
      { schemaVersion: "1.1.0", kind: "compiled_cthulhu_world_model_policy", bindings: [], sourceProfiles: [valid], extra: true },
      profilePolicy([], [{ ...valid, documentHash: "*" }]),
      profilePolicy([], [{ ...valid, documentHash: "C".repeat(64) }]),
      profilePolicy([], [valid, { ...valid }]),
      profilePolicy([], [{ ...valid, allowedWorkIds: ["unsupported-work"] }]),
      profilePolicy([], [{ ...valid, corpusScopeId: "not-a-manifest-corpus" }]),
    ];
    for (const invalid of invalidPolicies) {
      writeFileSync(path, JSON.stringify(invalid), "utf8");
      expect(() => new CompiledWorldModelBindingRegistry(environment(path))).toThrow();
    }

    // Authorization-shape validation is intentionally prior to touching the
    // configured dataset. A missing root must not mask an invalid work scope.
    writeFileSync(path, profilePolicy([], [{ ...valid, allowedWorkIds: ["unsupported-work"] }]), "utf8");
    expect(() => new CompiledWorldModelBindingRegistry(environment(path, join(workspace, "missing-dataset"))))
      .toThrow("allowedWorkIds is invalid");
  });

  test("fails closed when the pinned policy leaf grows or is replaced after descriptor open", () => {
    const workspace = root();
    const path = join(workspace, "policy.json");
    const replacement = join(workspace, "replacement.json");
    const valid = policy([entry("module-a", "a".repeat(64))]);
    writeFileSync(path, valid, "utf8");
    expect(() => new CompiledWorldModelBindingRegistry(environment(path), {
      afterPolicyDescriptorOpened: () => appendFileSync(path, " ", "utf8"),
    })).toThrow("changed while being read");

    writeFileSync(path, valid, "utf8");
    writeFileSync(replacement, valid, "utf8");
    expect(() => new CompiledWorldModelBindingRegistry(environment(path), {
      afterPolicyDescriptorOpened: () => {
        rmSync(path);
        renameSync(replacement, path);
      },
    })).toThrow("changed while being read");
  });
});
