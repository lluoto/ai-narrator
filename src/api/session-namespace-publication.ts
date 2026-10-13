import {
  SessionNamespaceFailure,
  type RuntimeSessionKind,
  type SessionNamespacePublicationPermit,
  type SessionNamespacePublicationPermitExpectation,
} from "./session-namespace-coordinator";

/**
 * The only capability bridge from the namespace coordinator to a snapshot
 * store.  It is intentionally synchronous: both stores consume this before
 * mkdir/open/write so a direct, forged, stale, or replayed save cannot mutate
 * a namespace-required root.
 */
export interface SessionNamespacePublicationGate {
  required: boolean;
  consume(permit: SessionNamespacePublicationPermit, expected: SessionNamespacePublicationPermitExpectation): void;
}

export interface SessionNamespaceStorePublication {
  permit: SessionNamespacePublicationPermit;
}

export function consumeSessionNamespacePublication(
  gate: SessionNamespacePublicationGate | undefined,
  publication: SessionNamespaceStorePublication | undefined,
  expected: {
    kind: RuntimeSessionKind;
    sessionId: string;
    hash: string;
    generation: number;
    format: string;
  },
  allowUncoordinatedTestWrites = false,
): void {
  // A store is namespace-required by default.  This has to be enforced here,
  // before the store creates its root or opens its local CAS database: an
  // omitted gate is otherwise an accidental raw-write backdoor that can move
  // a durable locator without advancing namespace currentIdentity.
  if (!gate) {
    if (allowUncoordinatedTestWrites) return;
    throw new SessionNamespaceFailure("SESSION_NAMESPACE_FENCED", "namespace-required snapshot publication has no coordinator gate");
  }
  if (!publication || !publication.permit) {
    if (gate.required) throw new SessionNamespaceFailure("SESSION_NAMESPACE_FENCED", "namespace-required snapshot publication has no coordinator permit");
    return;
  }
  const permit = publication.permit;
  gate.consume(permit, {
    kind: expected.kind,
    sessionId: expected.sessionId,
    fencingToken: permit.fencingToken,
    previousIdentity: permit.previousIdentity,
    nextIdentity: { hash: expected.hash, generation: expected.generation, format: expected.format },
  });
}
