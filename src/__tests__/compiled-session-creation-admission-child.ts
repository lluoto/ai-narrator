import { readSync, writeSync } from "node:fs";
import { CompiledSessionCreationAdmissionCoordinator } from "../api/compiled-session-creation-admission";

const root = process.env.COMPILED_CREATION_ADMISSION_ROOT;
const principalFingerprint = process.env.COMPILED_CREATION_ADMISSION_PRINCIPAL;
const waitForStart = process.env.COMPILED_CREATION_ADMISSION_WAIT_FOR_START === "1";
if (!root || !principalFingerprint || !/^[a-f0-9]{64}$/.test(principalFingerprint)) {
  throw new Error("compiled creation admission child requires a root and SHA-256 principal fingerprint");
}

// Test-only launch barrier: makes two fresh processes contend over schema
// initialization and their first BEGIN IMMEDIATE, rather than only testing a
// parent against a child that has already acquired.
if (waitForStart) readSync(0, new Uint8Array(1), 0, 1, null);

const admission = new CompiledSessionCreationAdmissionCoordinator({
  root,
  globalConcurrent: 1,
  perPrincipalConcurrent: 1,
  startsPerPrincipal: 4,
  windowMs: 60_000,
  maxTrackedPrincipals: 8,
  leaseTtlMs: 30_000,
  wholeJobDeadlineMs: 120_000,
  busyTimeoutMs: 25,
});
const result = admission.acquire({ principalFingerprint });
writeSync(1, `${JSON.stringify(result.status === "acquired" ? { status: result.status } : { status: result.status, code: result.code })}\n`);
if (result.status === "acquired") {
  try { readSync(0, new Uint8Array(1), 0, 1, null); }
  finally { result.release(); }
}
