/**
 * Process-local admission for public compiler JSON request bodies.
 *
 * This is intentionally a small, non-queued guard. It bounds the number of
 * authenticated callers whose JSON body (and its subsequent compiler work) is
 * in flight in this process. It is not the durable automatic-compiler
 * admission, which has separate cross-process ownership semantics.
 */
export const COMPILER_JSON_INGRESS_LIMITS = Object.freeze({
  globalLimit: 8,
  perPrincipalLimit: 2,
  retryAfterSeconds: 1,
});

export interface CompilerJsonIngressLease {
  /** Safe on every terminal path; only the first release changes accounting. */
  release(): void;
}

export type CompilerJsonIngressAdmissionResult =
  | { status: "admitted"; lease: CompilerJsonIngressLease }
  | { status: "busy"; retryAfterSeconds: number };

export interface CompilerJsonIngressAdmissionController {
  acquire(principalFingerprint: string): CompilerJsonIngressAdmissionResult;
}

export interface CompilerJsonIngressAdmissionLimits {
  globalLimit: number;
  perPrincipalLimit: number;
  retryAfterSeconds: number;
}

/**
 * Alternate limits exist only for a host-controlled test seam. Production
 * always receives the single fixed instance exported below.
 */
export class CompilerJsonIngressAdmission implements CompilerJsonIngressAdmissionController {
  readonly #globalLimit: number;
  readonly #perPrincipalLimit: number;
  readonly #retryAfterSeconds: number;
  #active = 0;
  readonly #activeByPrincipal = new Map<string, number>();

  constructor(limits: CompilerJsonIngressAdmissionLimits = COMPILER_JSON_INGRESS_LIMITS) {
    if (!Number.isSafeInteger(limits.globalLimit) || limits.globalLimit < 1
      || !Number.isSafeInteger(limits.perPrincipalLimit) || limits.perPrincipalLimit < 1
      || limits.perPrincipalLimit > limits.globalLimit
      || !Number.isSafeInteger(limits.retryAfterSeconds) || limits.retryAfterSeconds < 1) {
      throw new Error("compiler JSON ingress admission limits must be positive bounded integers");
    }
    this.#globalLimit = limits.globalLimit;
    this.#perPrincipalLimit = limits.perPrincipalLimit;
    this.#retryAfterSeconds = limits.retryAfterSeconds;
  }

  acquire(principalFingerprint: string): CompilerJsonIngressAdmissionResult {
    // This boundary receives a server-authenticated fingerprint only. Do not
    // create an accidental shared key for malformed host integration values.
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

  #busy(): CompilerJsonIngressAdmissionResult {
    return { status: "busy", retryAfterSeconds: this.#retryAfterSeconds };
  }

  #release(principalFingerprint: string): void {
    const principalActive = this.#activeByPrincipal.get(principalFingerprint);
    // The lease is idempotent; this defensive guard ensures an unexpected
    // accounting failure cannot undercount the global limit.
    if (!principalActive || this.#active < 1) return;
    this.#active--;
    if (principalActive === 1) this.#activeByPrincipal.delete(principalFingerprint);
    else this.#activeByPrincipal.set(principalFingerprint, principalActive - 1);
  }
}

/** The sole production controller; routes must never construct one per request. */
export const sharedCompilerJsonIngressAdmission = new CompilerJsonIngressAdmission();
