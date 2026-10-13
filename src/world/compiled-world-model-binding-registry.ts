import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { CTHULHU_DATASET_MANIFEST, type CthulhuWorkId } from "../dataset/cthulhu-manifest";
import { sha256 } from "../ingest/document-ir";
import type { CompiledWorldModelBindingResolver } from "../api/compiled-module-http";
import {
  createCompiledCthulhuWorldModelBinding,
  type CompiledCthulhuWorldModelBinding,
  validateCompiledCthulhuWorldModelScopeInput,
} from "./compiled-world-model-scope";

const POLICY_MAX_BYTES = 1_024 * 1_024;
const POLICY_MAX_BINDINGS = 1_024;

export interface CompiledWorldModelBindingRegistryEnvironment {
  COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH?: string;
  CTHULHU_DATASET_PATH?: string;
}

export interface CompiledWorldModelBindingPolicyStatus {
  readonly enabled: boolean;
  readonly policyHash: string | null;
  readonly bindingCount: number;
  readonly datasetId: string | null;
  readonly datasetVersion: string | null;
}

/** Narrow construction seam for deterministic descriptor-stability tests. */
export interface CompiledWorldModelBindingRegistryOptions {
  readonly afterPolicyDescriptorOpened?: () => void;
}

type PolicyEntry = {
  readonly moduleId: string;
  readonly artifactHash: string;
  readonly allowedWorkIds: readonly CthulhuWorkId[];
  readonly corpusScopeId: string | null;
  readonly transferPolicy: "mechanic_only" | "analogy_only";
};

type SourceProfileEntry = {
  readonly moduleId: string;
  readonly documentHash: string;
  readonly allowedWorkIds: readonly CthulhuWorkId[];
  readonly corpusScopeId: string | null;
  readonly transferPolicy: "mechanic_only" | "analogy_only";
};

type ParsedPolicy = {
  readonly bindings: readonly PolicyEntry[];
  readonly sourceProfiles: readonly SourceProfileEntry[];
};

type FileIdentity = Pick<Stats, "dev" | "ino" | "size">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sameIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRegularStable(stat: Stats, expected: FileIdentity): void {
  if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, expected) || stat.size !== expected.size) {
    throw new Error("compiled world-model policy file changed while being read");
  }
}

/** One bounded, descriptor-pinned startup read. Policy bytes are never reread after construction. */
function readPinnedPolicy(path: string, afterPolicyDescriptorOpened?: () => void): Uint8Array {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > POLICY_MAX_BYTES) {
    throw new Error("compiled world-model policy file is not an admissible regular file");
  }
  const expected: FileIdentity = { dev: before.dev, ino: before.ino, size: before.size };
  let descriptor: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    assertRegularStable(fstatSync(descriptor), expected);
    afterPolicyDescriptorOpened?.();
    assertRegularStable(lstatSync(path), expected);
    const bytes = Buffer.allocUnsafe(expected.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    assertRegularStable(fstatSync(descriptor), expected);
    assertRegularStable(lstatSync(path), expected);
    if (offset !== expected.size || offset > POLICY_MAX_BYTES) {
      throw new Error("compiled world-model policy file changed while being read");
    }
    return bytes.subarray(0, offset);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parsePolicy(bytes: Uint8Array): ParsedPolicy {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new Error("compiled world-model policy is not valid UTF-8 JSON");
  }
  if (!isRecord(value)) throw new Error("compiled world-model policy has an incompatible shape");
  const policy = value;
  const legacy = exactKeys(policy, ["schemaVersion", "kind", "bindings"])
    && policy.schemaVersion === "1.0.0";
  const profiled = exactKeys(policy, ["schemaVersion", "kind", "bindings", "sourceProfiles"])
    && policy.schemaVersion === "1.1.0";
  if ((!legacy && !profiled) || policy.kind !== "compiled_cthulhu_world_model_policy"
    || !Array.isArray(policy.bindings)
    || (profiled && !Array.isArray(policy.sourceProfiles))) {
    throw new Error("compiled world-model policy has an incompatible shape");
  }
  const sourceProfiles = profiled ? policy.sourceProfiles as unknown[] : [];
  if (policy.bindings.length + sourceProfiles.length === 0 || policy.bindings.length + sourceProfiles.length > POLICY_MAX_BINDINGS) {
    throw new Error("compiled world-model policy has an incompatible shape");
  }
  const exactSeen = new Set<string>();
  const bindings = policy.bindings.map((raw): PolicyEntry => {
    if (!isRecord(raw) || !exactKeys(raw, ["moduleId", "artifactHash", "allowedWorkIds", "corpusScopeId", "transferPolicy"])
      || typeof raw.moduleId !== "string" || raw.moduleId.length === 0 || raw.moduleId.trim().length === 0 || raw.moduleId.trim() !== raw.moduleId
      || typeof raw.artifactHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.artifactHash)
      || !Array.isArray(raw.allowedWorkIds) || raw.allowedWorkIds.length === 0 || !raw.allowedWorkIds.every((work) => typeof work === "string")
      || (raw.corpusScopeId !== null && (typeof raw.corpusScopeId !== "string" || raw.corpusScopeId.length === 0))
      || (raw.transferPolicy !== "mechanic_only" && raw.transferPolicy !== "analogy_only")) {
      throw new Error("compiled world-model policy binding has an incompatible shape");
    }
    const allowedWorkIds = raw.allowedWorkIds as CthulhuWorkId[];
    if (new Set(allowedWorkIds).size !== allowedWorkIds.length
      || [...allowedWorkIds].sort().some((work, index) => work !== allowedWorkIds[index])) {
      throw new Error("compiled world-model policy binding work scope is not canonical");
    }
    const tuple = `${raw.moduleId}\u0000${raw.artifactHash}`;
    if (exactSeen.has(tuple)) throw new Error("compiled world-model policy contains a duplicate binding");
    exactSeen.add(tuple);
    return Object.freeze({
      moduleId: raw.moduleId,
      artifactHash: raw.artifactHash,
      allowedWorkIds: Object.freeze([...allowedWorkIds]),
      corpusScopeId: raw.corpusScopeId,
      transferPolicy: raw.transferPolicy,
    });
  });
  const profileSeen = new Set<string>();
  const parsedProfiles = sourceProfiles.map((raw): SourceProfileEntry => {
    if (!isRecord(raw) || !exactKeys(raw, ["moduleId", "documentHash", "allowedWorkIds", "corpusScopeId", "transferPolicy"])
      || typeof raw.moduleId !== "string" || raw.moduleId.length === 0 || raw.moduleId.trim().length === 0 || raw.moduleId.trim() !== raw.moduleId
      || typeof raw.documentHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.documentHash)
      || !Array.isArray(raw.allowedWorkIds) || raw.allowedWorkIds.length === 0 || !raw.allowedWorkIds.every((work) => typeof work === "string")
      || (raw.corpusScopeId !== null && (typeof raw.corpusScopeId !== "string" || raw.corpusScopeId.length === 0))
      || (raw.transferPolicy !== "mechanic_only" && raw.transferPolicy !== "analogy_only")) {
      throw new Error("compiled world-model source profile has an incompatible shape");
    }
    const allowedWorkIds = raw.allowedWorkIds as CthulhuWorkId[];
    if (new Set(allowedWorkIds).size !== allowedWorkIds.length
      || [...allowedWorkIds].sort().some((work, index) => work !== allowedWorkIds[index])) {
      throw new Error("compiled world-model source profile work scope is not canonical");
    }
    const tuple = `${raw.moduleId}\u0000${raw.documentHash}`;
    if (profileSeen.has(tuple)) throw new Error("compiled world-model policy contains a duplicate source profile");
    profileSeen.add(tuple);
    return Object.freeze({
      moduleId: raw.moduleId,
      documentHash: raw.documentHash,
      allowedWorkIds: Object.freeze([...allowedWorkIds]),
      corpusScopeId: raw.corpusScopeId,
      transferPolicy: raw.transferPolicy,
    });
  });
  return Object.freeze({ bindings: Object.freeze(bindings), sourceProfiles: Object.freeze(parsedProfiles) });
}

function freezeBinding(binding: CompiledCthulhuWorldModelBinding): CompiledCthulhuWorldModelBinding {
  return Object.freeze({ ...binding, allowedWorkIds: Object.freeze([...binding.allowedWorkIds]) }) as CompiledCthulhuWorldModelBinding;
}

function isBlankConfigValue(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * Startup-only authority for compiled Cthulhu reference bindings. It mints
 * complete existing bindings from the immutable policy bytes and exposes just
 * the exact resolver required by publication; requests cannot select roots or
 * scopes and an already-published catalog binding remains self-contained.
 */
export class CompiledWorldModelBindingRegistry {
  readonly status: CompiledWorldModelBindingPolicyStatus;
  /**
   * Read-only startup-policy eligibility for a fresh PDF before it has a
   * resolved artifact hash. It exposes no binding, work scope, root, or
   * policy content; publication still calls `resolve` with the actual
   * resolved identity.
   */
  readonly hasSourceProfile: (moduleId: string, documentHash: string) => boolean;
  readonly resolve: CompiledWorldModelBindingResolver;

  constructor(
    environment: CompiledWorldModelBindingRegistryEnvironment = process.env as CompiledWorldModelBindingRegistryEnvironment,
    options: CompiledWorldModelBindingRegistryOptions = {},
  ) {
    const policyPath = environment.COMPILED_CTHULHU_WORLD_MODEL_POLICY_PATH;
    const datasetRoot = environment.CTHULHU_DATASET_PATH;
    if (isBlankConfigValue(policyPath) && isBlankConfigValue(datasetRoot)) {
      this.status = Object.freeze({ enabled: false, policyHash: null, bindingCount: 0, datasetId: null, datasetVersion: null });
      this.hasSourceProfile = Object.freeze(() => false);
      this.resolve = Object.freeze(() => undefined);
      Object.freeze(this);
      return;
    }
    if (isBlankConfigValue(policyPath) || isBlankConfigValue(datasetRoot)) {
      throw new Error("compiled world-model policy and dataset path must be configured together");
    }

    const configuredPolicyPath = policyPath as string;
    const configuredDatasetRoot = datasetRoot as string;
    const bytes = readPinnedPolicy(configuredPolicyPath, options.afterPolicyDescriptorOpened);
    const parsed = parsePolicy(bytes);
    const bindingsByModule = new Map<string, Map<string, CompiledCthulhuWorldModelBinding>>();
    for (const entry of parsed.bindings) {
      const binding = freezeBinding(createCompiledCthulhuWorldModelBinding({
        moduleId: entry.moduleId,
        artifactHash: entry.artifactHash,
        datasetRoot: configuredDatasetRoot,
        allowedWorkIds: [...entry.allowedWorkIds],
        ...(entry.corpusScopeId === null ? {} : { corpusScopeId: entry.corpusScopeId }),
        transferPolicy: entry.transferPolicy,
      }));
      const byArtifact = bindingsByModule.get(entry.moduleId) ?? new Map<string, CompiledCthulhuWorldModelBinding>();
      byArtifact.set(entry.artifactHash, binding);
      bindingsByModule.set(entry.moduleId, byArtifact);
    }
    const profilesByModule = new Map<string, Map<string, SourceProfileEntry>>();
    for (const profile of parsed.sourceProfiles) {
      // Profile startup validation intentionally has no artifact identity: it
      // validates the configured dataset/work scope now, while resolve below
      // mints only the actual reviewed artifact hash.
      validateCompiledCthulhuWorldModelScopeInput({
        moduleId: profile.moduleId,
        datasetRoot: configuredDatasetRoot,
        allowedWorkIds: [...profile.allowedWorkIds],
        ...(profile.corpusScopeId === null ? {} : { corpusScopeId: profile.corpusScopeId }),
        transferPolicy: profile.transferPolicy,
      });
      const byDocument = profilesByModule.get(profile.moduleId) ?? new Map<string, SourceProfileEntry>();
      byDocument.set(profile.documentHash, profile);
      profilesByModule.set(profile.moduleId, byDocument);
    }
    this.status = Object.freeze({
      enabled: true,
      policyHash: sha256(bytes),
      bindingCount: parsed.bindings.length + parsed.sourceProfiles.length,
      datasetId: CTHULHU_DATASET_MANIFEST.datasetId,
      datasetVersion: CTHULHU_DATASET_MANIFEST.version,
    });
    this.hasSourceProfile = Object.freeze((moduleId: string, documentHash: string): boolean =>
      typeof moduleId === "string" && moduleId.trim() === moduleId && moduleId.length > 0
      && typeof documentHash === "string" && /^[a-f0-9]{64}$/.test(documentHash)
      && profilesByModule.get(moduleId)?.has(documentHash) === true);
    this.resolve = Object.freeze((identity) => {
      const exact = bindingsByModule.get(identity.moduleId)?.get(identity.artifactHash);
      const profiles = profilesByModule.get(identity.moduleId);
      const profile = typeof identity.documentHash === "string" && /^[a-f0-9]{64}$/.test(identity.documentHash)
        ? profiles?.get(identity.documentHash)
        : undefined;
      if (exact && profile) throw new Error("compiled world-model policy has ambiguous exact and source-profile bindings");
      if (exact) return exact;
      if (!profiles) return undefined;
      if (profile === undefined && (identity.documentHash === null || typeof identity.documentHash !== "string" || !/^[a-f0-9]{64}$/.test(identity.documentHash))) {
        throw new Error("compiled world-model source profile requires a valid document hash");
      }
      if (!profile) return undefined;
      return freezeBinding(createCompiledCthulhuWorldModelBinding({
        moduleId: profile.moduleId,
        artifactHash: identity.artifactHash,
        datasetRoot: configuredDatasetRoot,
        allowedWorkIds: [...profile.allowedWorkIds],
        ...(profile.corpusScopeId === null ? {} : { corpusScopeId: profile.corpusScopeId }),
        transferPolicy: profile.transferPolicy,
      }));
    });
    Object.freeze(this);
  }
}

export function disabledCompiledWorldModelBindingPolicyStatus(): CompiledWorldModelBindingPolicyStatus {
  return Object.freeze({ enabled: false, policyHash: null, bindingCount: 0, datasetId: null, datasetVersion: null });
}
