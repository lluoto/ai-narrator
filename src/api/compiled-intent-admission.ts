import { createHash, randomBytes } from "crypto";
import {
  OrdinaryActionAdmissionCoordinator,
  type OrdinaryActionAdmissionConfig,
  type OrdinaryActionAdmissionOptions,
  type OrdinaryActionAdmissionRecoveryResult,
  type OrdinaryActionAdmissionResult,
} from "./ordinary-action-admission";

/**
 * Durable, cross-process admission for one compiled natural-language
 * classification.  It deliberately shares the audited SQLite fencing
 * primitive used for model-bearing ordinary actions, but has its own database
 * and a generation-scoped opaque lease key.
 *
 * The persisted request correlation value is a fresh random nonce. Raw player
 * prose, catalog labels, and mechanism identifiers never enter this database.
 */
export const COMPILED_INTENT_ADMISSION_SCHEMA_VERSION = "1.0.0";
export const COMPILED_INTENT_ADMISSION_DOMAIN = "compiled-intent-classification-admission";
const COMPILED_INTENT_ADMISSION_ACTION_ID = "compiled-intent-classification-v1";
// This is a synchronization deadline for the short SQLite transaction which
// records one classification lease, not a provider deadline. It lets a fresh
// competing process observe the first committed lease (429) instead of
// mistaking schema/bootstrap locking for storage failure. Sustained locking
// still reaches the fail-closed storage-unavailable path.
const COMPILED_INTENT_ADMISSION_BUSY_TIMEOUT_MS = 1_000;

export interface CompiledIntentAdmissionBinding {
  sessionId: string;
  expectedGeneration: number;
  input: string;
}

export type CompiledIntentAdmissionResult = OrdinaryActionAdmissionResult;

/**
 * Only fault-injection seams are configurable. The physical filename and
 * policy identity are part of the production security boundary, so callers
 * cannot select a second lock domain under an otherwise matching root.
 */
export type CompiledIntentAdmissionOptions = Pick<OrdinaryActionAdmissionOptions,
  "connectionFactory" | "pathOps">;

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(":");
    hash.update(part);
    hash.update("|");
  }
  return hash.digest("hex");
}

/**
 * An expired lease becomes quarantine in the underlying coordinator; it is
 * never automatically taken over because the old worker may still be inside
 * a provider call. The authenticated HTTP recovery route derives the exact
 * current generation from authoritative durable session state; no request can
 * select a fence, a generation, or a replacement lease key.
 */
export class CompiledIntentAdmissionCoordinator {
  readonly root: string;
  readonly file: string;
  private readonly delegate: OrdinaryActionAdmissionCoordinator;

  constructor(root: string, config: OrdinaryActionAdmissionConfig = {}, options: CompiledIntentAdmissionOptions = {}) {
    this.delegate = new OrdinaryActionAdmissionCoordinator(root, config, {
      ...options,
      // This is a distinct coordinator schema/policy file.  Sharing a root
      // with the runtime namespace is intentional; sharing an ordinary-action
      // SQLite file is not.
      fileName: ".compiled-intent-admission.sqlite",
      schemaVersion: COMPILED_INTENT_ADMISSION_SCHEMA_VERSION,
      coordinatorDomain: COMPILED_INTENT_ADMISSION_DOMAIN,
      // A competing committed lease is 429. SQLite lock acquisition itself
      // is infrastructure uncertainty and must remain a fail-closed 503.
      contentionAsBusy: false,
      busyTimeoutMs: COMPILED_INTENT_ADMISSION_BUSY_TIMEOUT_MS,
    });
    this.root = this.delegate.root;
    this.file = this.delegate.file;
  }

  acquire(binding: CompiledIntentAdmissionBinding): CompiledIntentAdmissionResult {
    if (typeof binding.sessionId !== "string" || !binding.sessionId
      || !Number.isSafeInteger(binding.expectedGeneration) || binding.expectedGeneration < 0
      || typeof binding.input !== "string" || !binding.input) {
      throw new Error("compiled intent admission binding is invalid");
    }
    // The physical SQLite primary key is opaque, but hashes the session and
    // exact expected generation together.  Thus a later generation has an
    // independent admission key while neither route can select a key itself.
    const leaseSessionId = this.leaseSessionId(binding.sessionId, binding.expectedGeneration);
    const delegateBinding = {
      sessionId: leaseSessionId,
      expectedGeneration: binding.expectedGeneration,
      actionId: COMPILED_INTENT_ADMISSION_ACTION_ID,
      // Correlation is a fresh CSPRNG nonce, never a value derived from player
      // prose. It is not returned over HTTP and does not affect exclusivity.
      requestHash: randomBytes(32).toString("hex"),
    };
    const result = this.delegate.acquire(delegateBinding);
    return result;
  }

  /**
   * This accepts only server-read identity. The underlying DELETE CAS can
   * remove a row only when it was already quarantined before this operation;
   * an active row (even past its TTL) is never automatic recovery authority.
   */
  recoverQuarantinedForOperator(input: { sessionId: string; currentGeneration: number }): OrdinaryActionAdmissionRecoveryResult {
    if (typeof input.sessionId !== "string" || !input.sessionId
      || !Number.isSafeInteger(input.currentGeneration) || input.currentGeneration < 0) {
      throw new Error("compiled intent admission recovery binding is invalid");
    }
    return this.delegate.recoverQuarantinedForOperator({
      sessionId: this.leaseSessionId(input.sessionId, input.currentGeneration),
      currentGeneration: input.currentGeneration,
    });
  }

  private leaseSessionId(sessionId: string, expectedGeneration: number): string {
    return digest(["compiled-intent-admission-key-v1", sessionId, String(expectedGeneration)]);
  }
}
