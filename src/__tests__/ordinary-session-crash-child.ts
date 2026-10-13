import { readSync, writeSync } from "fs";
import { GameSession } from "../api/game-session";
import { createOrdinarySessionAccessBinding } from "../api/session-access";
import { ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, OrdinarySessionSnapshotStore, createOrdinarySessionEnvelope } from "../api/ordinary-session-snapshot-store";

const AUTHORITY_ID = "ordinary-crash-authority";
const NEXT_ID = "ordinary-crash-next";
const CONFIG = { apiKey: "sk-test", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 };

function initial(sessionId: string) {
  const access = createOrdinarySessionAccessBinding({ role: "keeper", id: "ordinary-crash-owner" });
  const session = new GameSession(sessionId, "cosmic-horror", CONFIG, "detective", "Ada", undefined, undefined, access, "development_fallback");
  try {
    return createOrdinarySessionEnvelope({
      kind: "ordinary-session-envelope", schemaVersion: ORDINARY_SESSION_ENVELOPE_SCHEMA_VERSION, sessionId, generation: 0, previousEnvelopeHash: null,
      access, snapshot: session.exportOrdinarySessionSnapshot(), idempotency: [],
    });
  } finally { session.close(); }
}

function emit(value: Record<string, unknown>): void { writeSync(1, `@@ordinary-crash@@${JSON.stringify(value)}\n`); }
function summarize(result: { status: string; code?: string; value?: { generation?: number } }): Record<string, unknown> {
  return result.status === "ok" ? { status: "ok", generation: result.value?.generation } : { status: result.status, code: result.code };
}

const [phase, root] = process.argv.slice(2);
if (!root || !["crash-body", "crash-pointer", "recover-body", "recover-pointer"].includes(phase ?? "")) throw new Error("ordinary crash child phase/root is invalid");

const authority = initial(AUTHORITY_ID);
const next = initial(NEXT_ID);
// SQLite bootstrap, manifest finalization, and a generation-zero header/body
// settle at four entries; its final manifest replacement peaks at five.
const maxEntries = 5;

if (phase === "crash-body" || phase === "crash-pointer") {
  const wanted = phase === "crash-body" ? "first-artifact-persisted" : "pointer-durable-before-clean";
  let paused = false;
  const store = new OrdinarySessionSnapshotStore({
    root,
    allowUncoordinatedTestWrites: true,
    maxEntries,
    maxBytes: 16 * 1024 * 1024,
    // This dependency-injected hook exists only in this test child. It has no
    // HTTP/environment route and blocks after an acknowledged durable stage.
    testHooks: {
      onPublicationStage(stage) {
        if (!paused && stage === wanted) {
          paused = true;
          emit({ event: "stage", phase, stage });
          readSync(0, new Uint8Array(1), 0, 1, null);
        }
      },
    },
  });
  const result = store.save(authority);
  emit({ event: "unexpected-result", phase, result: summarize(result) });
} else {
  const store = new OrdinarySessionSnapshotStore({ root, maxEntries, maxBytes: 16 * 1024 * 1024, allowUncoordinatedTestWrites: true });
  if (phase === "recover-body") {
    const absent = store.audit(AUTHORITY_ID);
    const saved = store.save(next);
    const authorityAfter = store.audit(AUTHORITY_ID);
    const nextAfter = store.audit(NEXT_ID);
    emit({ event: "recovered", phase, absent: summarize(absent), saved: summarize(saved), authorityAfter: summarize(authorityAfter), nextAfter: summarize(nextAfter) });
  } else {
    const authorityBefore = store.audit(AUTHORITY_ID);
    const exact = authorityBefore.status === "ok" ? store.save(authorityBefore.value) : authorityBefore;
    const blocked = store.save(next);
    const authorityAfter = store.audit(AUTHORITY_ID);
    emit({ event: "recovered", phase, authorityBefore: summarize(authorityBefore), exact: summarize(exact), blocked: summarize(blocked), authorityAfter: summarize(authorityAfter) });
  }
}
