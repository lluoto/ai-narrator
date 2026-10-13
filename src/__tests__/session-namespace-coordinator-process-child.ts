import { SessionNamespaceCoordinator, SessionNamespaceFailure, type RuntimeSessionKind } from "../api/session-namespace-coordinator";
import { readSync, writeFileSync } from "fs";

const root = process.env.SESSION_NAMESPACE_ROOT;
const sessionId = process.env.SESSION_NAMESPACE_ID;
const kind = process.env.SESSION_NAMESPACE_KIND as RuntimeSessionKind | undefined;
const leaseMs = process.env.SESSION_NAMESPACE_LEASE_MS === undefined ? undefined : Number(process.env.SESSION_NAMESPACE_LEASE_MS);
const action = process.env.SESSION_NAMESPACE_ACTION ?? "reserve";
const marker = process.env.SESSION_NAMESPACE_MARKER;
const holdPublication = process.env.SESSION_NAMESPACE_HOLD_PUBLICATION === "1";

if (!root || !sessionId || (kind !== "ordinary" && kind !== "compiled") || (action !== "reserve" && action !== "adopt" && action !== "publish") || (leaseMs !== undefined && (!Number.isSafeInteger(leaseMs) || leaseMs < 1))) {
  throw new Error("session namespace child requires root, session id, and kind");
}

const coordinator = new SessionNamespaceCoordinator(root);
try {
  if (action === "adopt") {
    const record = coordinator.adoptCommitted({
      sessionId,
      kind,
      observedIdentity: { hash: "a".repeat(64), generation: 0, format: "runtime-session-v1" },
    });
    process.stdout.write(`${JSON.stringify({ status: record.state, kind: record.kind })}\n`);
  } else if (action === "publish") {
    const reservation = coordinator.reserve({ sessionId, kind, leaseMs });
    const prepared = coordinator.prepare({
      reservation,
      expectedIdentity: { hash: "a".repeat(64), generation: 0, format: "runtime-session-v1" },
    });
    const result = coordinator.publishPrepared({
      reservation: prepared,
      publish() {
        if (holdPublication) {
          process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`);
          readSync(0, new Uint8Array(1), 0, 1, null);
        }
        if (marker) writeFileSync(marker, kind);
        return { status: "published", observedIdentity: { hash: "a".repeat(64), generation: 0, format: "runtime-session-v1" } };
      },
    });
    process.stdout.write(`${JSON.stringify({ event: "result", result: { status: result.status, kind } })}\n`);
  } else {
    const reservation = coordinator.reserve({
      sessionId,
      kind,
      leaseMs,
    });
    process.stdout.write(`${JSON.stringify({ status: "reserved", kind: reservation.kind })}\n`);
  }
} catch (error) {
  if (error instanceof SessionNamespaceFailure) {
    process.stdout.write(`${JSON.stringify({ status: "refused", code: error.code })}\n`);
  } else {
    throw error;
  }
}
