/**
 * Internal installation envelope owned by the API/session layer.
 *
 * It intentionally lives outside `module/`: compiler projections may be
 * presented as ModuleData, but module code must never import compiler code or
 * mistake that presentation for a legacy runtime module.
 */
import {
  assertRuntimeModuleData,
  type RuntimeModuleData,
} from "../module/types";
import type { ResolvedCompilerArtifactPayload } from "../compiler/compiler-artifact";
import type { LoadedBundleCatalogEntry } from "../compiler/compiler-artifact-catalog";
import type { CompilerModuleDataProjection } from "../compiler/compiler-module-data-projection";
import { assertMythosModuleForInstall, type MythosModule } from "../rules/mythos-module";

export interface RuntimeModulePackageIdentity {
  moduleId: string;
  mechanicsHash?: string;
}

export type RuntimeModulePackage =
  | {
    kind: "compiled_bundle";
    identity: RuntimeModulePackageIdentity & { mechanicsHash: string };
    payload: ResolvedCompilerArtifactPayload;
    projection: CompilerModuleDataProjection;
    durableBundle?: Pick<LoadedBundleCatalogEntry, "id" | "bundleHash">;
  }
  | {
    kind: "runtime_module_data_legacy";
    identity: RuntimeModulePackageIdentity;
    module: RuntimeModuleData;
  }
  | {
    kind: "mythos_legacy";
    identity: RuntimeModulePackageIdentity;
    module: MythosModule;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertText(value: unknown, label: string): asserts value is string {
  if (!isText(value)) throw new Error(`RuntimeModulePackage ${label} must be non-blank text`);
}

export function runtimeModuleDataLegacyPackage(module: RuntimeModuleData): RuntimeModulePackage {
  assertRuntimeModuleData(module);
  return { kind: "runtime_module_data_legacy", identity: { moduleId: module.id }, module };
}

export function mythosLegacyPackage(module: MythosModule): RuntimeModulePackage {
  assertMythosModuleForInstall(module);
  return { kind: "mythos_legacy", identity: { moduleId: module.id }, module };
}

export function compiledBundlePackage(
  payload: ResolvedCompilerArtifactPayload,
  projection: CompilerModuleDataProjection,
  durableBundle?: Pick<LoadedBundleCatalogEntry, "id" | "bundleHash">,
): RuntimeModulePackage {
  const identity = (payload as unknown as { identity?: { moduleId?: unknown; mechanicsHash?: unknown } }).identity;
  return {
    kind: "compiled_bundle",
    identity: { moduleId: typeof identity?.moduleId === "string" ? identity.moduleId : "", mechanicsHash: typeof identity?.mechanicsHash === "string" ? identity.mechanicsHash : "" },
    payload,
    projection,
    ...(durableBundle ? { durableBundle } : {}),
  };
}

/** Reject a forged discriminator or mismatched identity before any installer is entered. */
export function assertRuntimeModulePackage(value: unknown): asserts value is RuntimeModulePackage {
  if (!isRecord(value)) throw new Error("RuntimeModulePackage must be an object");
  if (!isRecord(value.identity)) throw new Error("RuntimeModulePackage identity must be an object");
  assertText(value.identity.moduleId, "identity.moduleId");
  switch (value.kind) {
    case "runtime_module_data_legacy": {
      assertRuntimeModuleData(value.module);
      if (value.identity.moduleId !== value.module.id) throw new Error("RuntimeModulePackage runtime identity does not match module");
      return;
    }
    case "mythos_legacy": {
      assertMythosModuleForInstall(value.module);
      if (value.identity.moduleId !== value.module.id) throw new Error("RuntimeModulePackage mythos identity does not match module");
      return;
    }
    case "compiled_bundle": {
      if (!isRecord(value.payload) || !isRecord(value.payload.identity) || !isRecord(value.projection)
        || value.projection.status !== "projected" || !isRecord(value.projection.artifact) || !isRecord(value.projection.artifact.identity)
        || !isRecord(value.projection.mechanics)) {
        throw new Error("RuntimeModulePackage compiled bundle has an invalid shape");
      }
      const payloadIdentity = value.payload.identity;
      const projectionIdentity = value.projection.artifact.identity;
      const mechanics = value.projection.mechanics;
      assertText(payloadIdentity.moduleId, "compiled payload identity.moduleId");
      assertText(payloadIdentity.mechanicsHash, "compiled payload identity.mechanicsHash");
      assertText(projectionIdentity.moduleId, "compiled projection identity.moduleId");
      assertText(projectionIdentity.mechanicsHash, "compiled projection identity.mechanicsHash");
      assertText(mechanics.moduleId, "compiled mechanics.moduleId");
      assertText(mechanics.mechanicsHash, "compiled mechanics.mechanicsHash");
      assertText(value.identity.mechanicsHash, "compiled package identity.mechanicsHash");
      if (value.identity.moduleId !== payloadIdentity.moduleId || value.identity.mechanicsHash !== payloadIdentity.mechanicsHash
        || projectionIdentity.moduleId !== payloadIdentity.moduleId || projectionIdentity.mechanicsHash !== payloadIdentity.mechanicsHash
        || mechanics.moduleId !== payloadIdentity.moduleId || mechanics.mechanicsHash !== payloadIdentity.mechanicsHash) {
        throw new Error("RuntimeModulePackage compiled identity does not match payload, projection, and MechanicsIR metadata");
      }
      if (value.durableBundle !== undefined && (!isRecord(value.durableBundle) || !isText(value.durableBundle.id) || !isText(value.durableBundle.bundleHash))) {
        throw new Error("RuntimeModulePackage durable bundle identity is invalid");
      }
      return;
    }
    default:
      throw new Error("RuntimeModulePackage kind is invalid");
  }
}
