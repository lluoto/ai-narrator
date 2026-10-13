/**
 * Process-local HTTP ingress guard for untrusted PDF preparation.
 *
 * This deliberately sits outside the PDF worker admission: it bounds request
 * bodies held by this process, while the worker admission separately protects
 * disposable parser processes.  There is no queue here; refusing before a
 * body reader is acquired is the memory/connection safety property.
 */
export const PDF_PREPARE_INGRESS_LIMITS = Object.freeze({
  globalLimit: 5,
  perPrincipalLimit: 2,
  retryAfterSeconds: 1,
});

export interface PdfPrepareIngressLease {
  /** Safe to call from every terminal path; only the first call changes state. */
  release(): void;
}

export type PdfPrepareIngressAdmissionResult =
  | { status: "admitted"; lease: PdfPrepareIngressLease }
  | { status: "busy"; retryAfterSeconds: number };

export interface PdfPrepareIngressAdmissionController {
  acquire(principalIdentity: string): PdfPrepareIngressAdmissionResult;
}

export interface PdfPrepareIngressAdmissionLimits {
  globalLimit: number;
  perPrincipalLimit: number;
}

/**
 * The constructor accepts narrower limits solely so an injected host/test
 * controller can exercise the boundary. Production always uses the shared
 * module instance below and its fixed server-owned contract.
 */
export class PdfPrepareIngressAdmission implements PdfPrepareIngressAdmissionController {
  readonly #globalLimit: number;
  readonly #perPrincipalLimit: number;
  #active = 0;
  readonly #activeByPrincipal = new Map<string, number>();

  constructor(limits: PdfPrepareIngressAdmissionLimits = PDF_PREPARE_INGRESS_LIMITS) {
    if (!Number.isSafeInteger(limits.globalLimit) || limits.globalLimit < 1
      || !Number.isSafeInteger(limits.perPrincipalLimit) || limits.perPrincipalLimit < 1
      || limits.perPrincipalLimit > limits.globalLimit) {
      throw new Error("PDF prepare ingress admission limits must be positive bounded integers");
    }
    this.#globalLimit = limits.globalLimit;
    this.#perPrincipalLimit = limits.perPrincipalLimit;
  }

  acquire(principalIdentity: string): PdfPrepareIngressAdmissionResult {
    // The HTTP boundary supplies an authenticated host-derived fingerprint.
    // Treat malformed identities as busy rather than inventing a shared key.
    if (!principalIdentity || typeof principalIdentity !== "string") return this.#busy();
    const principalActive = this.#activeByPrincipal.get(principalIdentity) ?? 0;
    if (this.#active >= this.#globalLimit || principalActive >= this.#perPrincipalLimit) return this.#busy();

    this.#active++;
    this.#activeByPrincipal.set(principalIdentity, principalActive + 1);
    let released = false;
    return {
      status: "admitted",
      lease: {
        release: () => {
          if (released) return;
          released = true;
          this.#release(principalIdentity);
        },
      },
    };
  }

  #busy(): PdfPrepareIngressAdmissionResult {
    return { status: "busy", retryAfterSeconds: PDF_PREPARE_INGRESS_LIMITS.retryAfterSeconds };
  }

  #release(principalIdentity: string): void {
    // The idempotent lease makes this defensive branch unreachable for normal
    // callers, but never let an internal accounting fault make a future
    // request undercount the global bound.
    const principalActive = this.#activeByPrincipal.get(principalIdentity);
    if (!principalActive || this.#active < 1) return;
    this.#active--;
    if (principalActive === 1) this.#activeByPrincipal.delete(principalIdentity);
    else this.#activeByPrincipal.set(principalIdentity, principalActive - 1);
  }
}

/** The sole production controller: never create one per HTTP request. */
export const sharedPdfPrepareIngressAdmission = new PdfPrepareIngressAdmission();
