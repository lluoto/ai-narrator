import { readSync, writeSync } from "node:fs";
import { OrdinarySessionCreationAdmissionCoordinator } from "../api/ordinary-session-creation-admission";

const root = process.env.ORDINARY_CREATION_ADMISSION_ROOT;
const principalFingerprint = process.env.ORDINARY_CREATION_ADMISSION_PRINCIPAL;
const hold = process.env.ORDINARY_CREATION_ADMISSION_HOLD === "1";
const leaseTtlMs = Number(process.env.ORDINARY_CREATION_ADMISSION_LEASE_TTL_MS ?? "30000");
if (!root || !principalFingerprint || !/^[a-f0-9]{64}$/.test(principalFingerprint)) {
  throw new Error("ordinary creation admission child requires root and a principal fingerprint");
}

const coordinator = new OrdinarySessionCreationAdmissionCoordinator({
  root,
  globalConcurrent: 1,
  perPrincipalConcurrent: 1,
  startsPerPrincipal: 4,
  windowMs: 60_000,
  maxTrackedPrincipals: 8,
  leaseTtlMs,
  wholeJobDeadlineMs: 120_000,
  busyTimeoutMs: 25,
});
const result = coordinator.acquire({ principalFingerprint });
let final: unknown = result;
if (result.status === "acquired") {
  try {
    writeSync(1, `${JSON.stringify({ event: "acquired", status: result.status, expiresAt: result.expiresAt, deadlineAt: result.deadlineAt })}\n`);
    if (hold) readSync(0, new Uint8Array(1), 0, 1, null);
  } finally {
    final = { status: "released", released: result.release() };
  }
} else {
  writeSync(1, `${JSON.stringify({ event: "acquired", status: result.status, code: result.code })}\n`);
}
writeSync(1, `${JSON.stringify({ event: "result", result: final })}\n`);
