import { createHash } from "crypto";

/** Durable owner verifier for ordinary (non-compiled) sessions. */
export const ORDINARY_SESSION_ACCESS_BINDING_SCHEMA_VERSION = "1.0.0";

/**
 * This deliberately has no compiled player grant, choice secret, or artifact
 * fields. Ordinary sessions need only an exact owner verifier.
 */
export interface OrdinarySessionAccessBinding {
  schemaVersion: typeof ORDINARY_SESSION_ACCESS_BINDING_SCHEMA_VERSION;
  ownerRole: "operator" | "keeper";
  ownerPrincipalFingerprint: string;
}

export type OrdinarySessionPrincipal = {
  id: string;
  role: "operator" | "keeper" | "player";
};

function isOwnerPrincipal(value: unknown): value is OrdinarySessionPrincipal & { role: "operator" | "keeper" } {
  return !!value
    && typeof value === "object"
    && typeof (value as { id?: unknown }).id === "string"
    && (value as { id: string }).id.trim().length > 0
    && ["operator", "keeper"].includes((value as { role?: unknown }).role as string);
}

/** Separate domain from compiled owner hashes so bindings cannot be interchanged. */
export function ordinarySessionOwnerFingerprint(principal: OrdinarySessionPrincipal): string {
  if (!isOwnerPrincipal(principal)) throw new Error("ordinary session owner principal is invalid");
  return createHash("sha256").update(`ordinary-session-owner-v1|${principal.role}|${principal.id.trim()}`).digest("hex");
}

export function createOrdinarySessionAccessBinding(principal: OrdinarySessionPrincipal): OrdinarySessionAccessBinding {
  if (!isOwnerPrincipal(principal)) throw new Error("ordinary session owner principal is invalid");
  return {
    schemaVersion: ORDINARY_SESSION_ACCESS_BINDING_SCHEMA_VERSION,
    ownerRole: principal.role,
    ownerPrincipalFingerprint: ordinarySessionOwnerFingerprint(principal),
  };
}

export function isOrdinarySessionAccessBinding(value: unknown): value is OrdinarySessionAccessBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3
    && Object.hasOwn(record, "schemaVersion")
    && Object.hasOwn(record, "ownerRole")
    && Object.hasOwn(record, "ownerPrincipalFingerprint")
    && record.schemaVersion === ORDINARY_SESSION_ACCESS_BINDING_SCHEMA_VERSION
    && (record.ownerRole === "operator" || record.ownerRole === "keeper")
    && typeof record.ownerPrincipalFingerprint === "string"
    && /^[a-f0-9]{64}$/.test(record.ownerPrincipalFingerprint);
}

/** Exact owner match; body/query values never participate. */
export function principalMatchesOrdinarySessionAccess(
  principal: OrdinarySessionPrincipal,
  binding: OrdinarySessionAccessBinding,
): boolean {
  return isOwnerPrincipal(principal)
    && principal.role === binding.ownerRole
    && ordinarySessionOwnerFingerprint(principal) === binding.ownerPrincipalFingerprint;
}

export function sameOrdinarySessionAccessBinding(
  left: OrdinarySessionAccessBinding,
  right: OrdinarySessionAccessBinding,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.ownerRole === right.ownerRole
    && left.ownerPrincipalFingerprint === right.ownerPrincipalFingerprint;
}
