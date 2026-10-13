/**
 * Process-local websocket admission.  Websocket connections cannot be shared
 * across server processes, so this deliberately has no durable backing store.
 */
export interface OrdinarySessionWebSocketAdmissionLimits {
  readonly global: number;
  readonly perSession: number;
  readonly perPrincipal: number;
}

export interface OrdinarySessionWebSocketAdmissionBinding {
  readonly sessionId: string;
  readonly principalKey: string;
}

declare const ordinarySessionWebSocketAdmissionLease: unique symbol;

/** An opaque, controller-issued capability. */
export type OrdinarySessionWebSocketAdmissionLease = {
  readonly [ordinarySessionWebSocketAdmissionLease]: true;
};

export type OrdinarySessionWebSocketReservation =
  | { readonly status: "reserved"; readonly lease: OrdinarySessionWebSocketAdmissionLease }
  | { readonly status: "capacity-exceeded" | "draining" };

export interface BoundOrdinarySessionWebSocketAdmission {
  readonly lease: OrdinarySessionWebSocketAdmissionLease;
  readonly binding: OrdinarySessionWebSocketAdmissionBinding;
}

const admissionBinding = Symbol("ordinary-session-websocket-admission");

/**
 * Stores the capability as a non-enumerable symbol on Bun's server-only data
 * object.  It is neither a query value nor a websocket wire payload.
 */
export function bindOrdinarySessionWebSocketAdmission<T extends object>(
  data: T,
  bound: BoundOrdinarySessionWebSocketAdmission,
): T {
  Object.defineProperty(data, admissionBinding, {
    value: Object.freeze({ lease: bound.lease, binding: Object.freeze({ ...bound.binding }) }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return data;
}

export function readOrdinarySessionWebSocketAdmission(
  data: object,
): BoundOrdinarySessionWebSocketAdmission | undefined {
  return (data as { [admissionBinding]?: BoundOrdinarySessionWebSocketAdmission })[admissionBinding];
}

interface LeaseRecord extends OrdinarySessionWebSocketAdmissionBinding {
  state: "reserved" | "open";
  timeout: ReturnType<typeof setTimeout> | undefined;
}

export interface OrdinarySessionWebSocketAdmissionOptions {
  /** A successful HTTP upgrade must open quickly or it no longer owns capacity. */
  readonly handshakeTimeoutMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Owns the only counters used for ordinary websocket capacity.  A reservation
 * counts immediately; opening only changes state, avoiding a handshake race.
 */
export class OrdinarySessionWebSocketAdmissionController {
  readonly #limits: OrdinarySessionWebSocketAdmissionLimits;
  readonly #handshakeTimeoutMs: number;
  readonly #leases = new Map<OrdinarySessionWebSocketAdmissionLease, LeaseRecord>();
  readonly #sessionCounts = new Map<string, number>();
  readonly #principalCounts = new Map<string, number>();
  #total = 0;
  #draining = false;

  constructor(
    limits: OrdinarySessionWebSocketAdmissionLimits,
    options: OrdinarySessionWebSocketAdmissionOptions = {},
  ) {
    if (
      !Number.isSafeInteger(limits.global) || limits.global <= 0 ||
      !Number.isSafeInteger(limits.perSession) || limits.perSession <= 0 ||
      !Number.isSafeInteger(limits.perPrincipal) || limits.perPrincipal <= 0 ||
      limits.perSession > limits.global || limits.perPrincipal > limits.global
    ) {
      throw new Error("ordinary websocket admission limits must be positive safe integers not exceeding the global limit");
    }
    if (!Number.isSafeInteger(options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS) || (options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS) <= 0) {
      throw new Error("ordinary websocket admission handshake timeout must be a positive safe integer");
    }
    this.#limits = limits;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  reserve(binding: OrdinarySessionWebSocketAdmissionBinding): OrdinarySessionWebSocketReservation {
    if (this.#draining) {
      return { status: "draining" };
    }
    if (
      this.#total >= this.#limits.global ||
      (this.#sessionCounts.get(binding.sessionId) ?? 0) >= this.#limits.perSession ||
      (this.#principalCounts.get(binding.principalKey) ?? 0) >= this.#limits.perPrincipal
    ) {
      return { status: "capacity-exceeded" };
    }

    const lease = Object.freeze({}) as OrdinarySessionWebSocketAdmissionLease;
    const record: LeaseRecord = { ...binding, state: "reserved", timeout: undefined };
    record.timeout = setTimeout(() => { void this.releaseLease(lease); }, this.#handshakeTimeoutMs);
    this.#leases.set(lease, record);
    this.#total += 1;
    this.#increment(this.#sessionCounts, binding.sessionId);
    this.#increment(this.#principalCounts, binding.principalKey);
    return { status: "reserved", lease };
  }

  /** Activates one reservation as open after validating its binding. */
  activateReservedLease(lease: OrdinarySessionWebSocketAdmissionLease | undefined, binding: OrdinarySessionWebSocketAdmissionBinding): boolean {
    if (!lease || this.#draining) return false;
    const record = this.#leases.get(lease);
    if (!record) return false;
    // A replay must never release the live socket's allocation.  Only a
    // still-reserved capability can be reclaimed for a binding mismatch.
    if (record.state !== "reserved") return false;
    if (record.sessionId !== binding.sessionId || record.principalKey !== binding.principalKey) {
      if (!this.releaseLease(lease)) throw new Error("reserved websocket admission lease disappeared during binding rejection");
      return false;
    }
    if (record.timeout !== undefined) {
      clearTimeout(record.timeout);
      record.timeout = undefined;
    }
    record.state = "open";
    return true;
  }

  /** Idempotently releases either a pending handshake or an open socket. */
  releaseLease(lease: OrdinarySessionWebSocketAdmissionLease | undefined): boolean {
    if (!lease) return false;
    const record = this.#leases.get(lease);
    if (!record) return false;
    this.#leases.delete(lease);
    if (record.timeout !== undefined) clearTimeout(record.timeout);
    this.#total -= 1;
    this.#decrement(this.#sessionCounts, record.sessionId);
    this.#decrement(this.#principalCounts, record.principalKey);
    return true;
  }

  /** Synchronous shutdown fence.  Pending handshakes no longer reserve slots. */
  beginDraining(): void {
    if (this.#draining) return;
    this.#draining = true;
    for (const [lease, record] of this.#leases) {
      if (record.state === "reserved") void this.releaseLease(lease);
    }
  }

  /** Test-only observability; production config intentionally does not expose it. */
  snapshot(): { reserved: number; open: number; total: number } {
    let reserved = 0;
    let open = 0;
    for (const record of this.#leases.values()) {
      if (record.state === "reserved") reserved += 1;
      else open += 1;
    }
    return { reserved, open, total: this.#total };
  }

  #increment(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  #decrement(counts: Map<string, number>, key: string): void {
    const next = (counts.get(key) ?? 0) - 1;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
  }
}
