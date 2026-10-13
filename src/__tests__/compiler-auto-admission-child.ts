import { readSync, writeSync } from "fs";
import { CompilerAutoAdmissionController } from "../api/compiler-auto-admission";

const root = process.env.COMPILER_AUTO_ADMISSION_PROCESS_ROOT;
const principal = process.env.COMPILER_AUTO_ADMISSION_PROCESS_PRINCIPAL;
const artifact = process.env.COMPILER_AUTO_ADMISSION_PROCESS_ARTIFACT;
if (!root || !principal || !artifact || !/^[a-f0-9]{64}$/.test(principal)) throw new Error("compiler auto admission child requires root, principal fingerprint, and artifact");

const admission = new CompilerAutoAdmissionController({
  root,
  globalConcurrent: Number(process.env.COMPILER_AUTO_ADMISSION_PROCESS_GLOBAL ?? "2"),
  perPrincipalConcurrent: 1,
  startsPerPrincipal: 4,
  windowMs: 60_000,
  maxTrackedPrincipals: 8,
  leaseTtlMs: 30_000,
  wholeJobDeadlineMs: 120_000,
  now: () => Number(process.env.COMPILER_AUTO_ADMISSION_PROCESS_NOW ?? "1000"),
});
const result = admission.acquire({ principalFingerprint: principal, preparedArtifactId: artifact });
let final: { status: "released"; released: boolean } | typeof result = result;
if (result.status === "acquired") {
  try {
    // Keep even the first parent-visible write inside the cleanup boundary:
    // a broken pipe/assertion timeout must not orphan a child-process lease.
    writeSync(1, `${JSON.stringify({ event: "acquired", result: { status: result.status, fence: result.fence, deadlineAt: result.deadlineAt } })}\n`);
    if (process.env.COMPILER_AUTO_ADMISSION_PROCESS_HOLD === "1") readSync(0, new Uint8Array(1), 0, 1, null);
  } finally {
    // A parent assertion timeout, stdin error, or child exception must not
    // leave a real-process lease behind until TTL reclaim.
    final = { status: "released", released: result.release() };
  }
} else {
  writeSync(1, `${JSON.stringify({ event: "acquired", result })}\n`);
}
writeSync(1, `${JSON.stringify({ event: "result", result: final })}\n`);
