/**
 * Process-local admission for compiled durable-session creation.
 *
 * This intentionally has no queue and is independent from ordinary session
 * creation and compiler JSON/PDF ingress policy. It bounds expensive durable
 * construction from the server-authenticated creator through publication.
 */
export const COMPILED_SESSION_CREATION_INGRESS_LIMITS = Object.freeze({
  globalLimit: 2,
  perPrincipalLimit: 1,
  retryAfterSeconds: 1,
});

export interface CompiledSessionCreationIngressLease {
  /** Safe on every terminal path; only the first release changes accounting. */
  release(): void;
}

export type CompiledSessionCreationIngressAdmissionResult =
  | { status: "admitted"; lease: CompiledSessionCreationIngressLease }
  | { status: "busy"; retryAfterSeconds: number };

export interface CompiledSessionCreationIngressAdmissionController {
  acquire(principalFingerprint: string): CompiledSessionCreationIngressAdmissionResult;
}

export interface CompiledSessionCreationIngressAdmissionLimits {
  globalLimit: number;
  perPrincipalLimit: number;
  retryAfterSeconds: number;
}

/**
 * Alternate limits exist only for the host/test injection seam. Production
 * always uses the one module-shared controller below.
 */
export class CompiledSessionCreationIngressAdmission implements CompiledSessionCreationIngressAdmissionController {
  readonly #globalLimit: number;
  readonly #perPrincipalLimit: number;
  readonly #retryAfterSeconds: number;
  #active = 0;
  readonly #activeByPrincipal = new Map<string, number>();

  constructor(limits: CompiledSessionCreationIngressAdmissionLimits = COMPILED_SESSION_CREATION_INGRESS_LIMITS) {
    if (!Number.isSafeInteger(limits.globalLimit) || limits.globalLimit < 1
      || !Number.isSafeInteger(limits.perPrincipalLimit) || limits.perPrincipalLimit < 1
      || limits.perPrincipalLimit > limits.globalLimit
      || !Number.isSafeInteger(limits.retryAfterSeconds) || limits.retryAfterSeconds < 1) {
      throw new Error("compiled session creation ingress admission limits must be positive bounded integers");
    }
    this.#globalLimit = limits.globalLimit;
    this.#perPrincipalLimit = limits.perPrincipalLimit;
    this.#retryAfterSeconds = limits.retryAfterSeconds;
  }

  acquire(principalFingerprint: string): CompiledSessionCreationIngressAdmissionResult {
    // Only the server-authenticated creator fingerprint may reach this
    // boundary. Do not turn malformed host integration into a shared bucket.
    if (!principalFingerprint || typeof principalFingerprint !== "string") return this.#busy();
    const principalActive = this.#activeByPrincipal.get(principalFingerprint) ?? 0;
    if (this.#active >= this.#globalLimit || principalActive >= this.#perPrincipalLimit) return this.#busy();

    this.#active++;
    this.#activeByPrincipal.set(principalFingerprint, principalActive + 1);
    let released = false;
    return {
      status: "admitted",
      lease: {
        release: () => {
          if (released) return;
          released = true;
          this.#release(principalFingerprint);
        },
      },
    };
  }

  #busy(): CompiledSessionCreationIngressAdmissionResult {
    return { status: "busy", retryAfterSeconds: this.#retryAfterSeconds };
  }

  #release(principalFingerprint: string): void {
    const principalActive = this.#activeByPrincipal.get(principalFingerprint);
    // The lease's idempotency makes this unreachable in ordinary operation;
    // keep it defensive so an accounting fault cannot undercount a bound.
    if (!principalActive || this.#active < 1) return;
    this.#active--;
    if (principalActive === 1) this.#activeByPrincipal.delete(principalFingerprint);
    else this.#activeByPrincipal.set(principalFingerprint, principalActive - 1);
  }
}

/** The sole production fallback; never allocate a controller per request. */
export const sharedCompiledSessionCreationIngressAdmission = new CompiledSessionCreationIngressAdmission();
