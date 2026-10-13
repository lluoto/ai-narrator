import { expect, it } from "bun:test";
import { GameSession, acknowledgeOrdinaryDurableIdentity, type OrdinarySessionDurableIdentity } from "../api/game-session";
import {
  createOrdinarySessionAccessBinding,
  principalMatchesOrdinarySessionAccess,
  type OrdinarySessionAccessBinding,
} from "../api/session-access";

const owner = { role: "keeper" as const, id: "ordinary-private-field-owner" };
const attacker = { role: "operator" as const, id: "ordinary-private-field-attacker" };
const durableHostCapability = Object.freeze(Object.create(null)) as object;

function fresh(id: string, access: OrdinarySessionAccessBinding): GameSession {
  return new GameSession(id, "cosmic-horror", undefined, undefined, undefined, undefined, undefined, access, "development_fallback", {
    ordinaryDurableHostCapability: durableHostCapability,
  });
}

function durableIdentity(generation = 7): OrdinarySessionDurableIdentity {
  return {
    generation,
    envelopeHash: "a".repeat(64),
    snapshotHash: `sha256:${"b".repeat(64)}`,
  };
}

function expectOwnerBinding(access: OrdinarySessionAccessBinding | null, ownerBinding: OrdinarySessionAccessBinding): void {
  expect(access).toEqual(ownerBinding);
  if (!access) throw new Error("owner access binding is required for this authority boundary");
  expect(principalMatchesOrdinarySessionAccess(owner, access)).toBe(true);
  expect(principalMatchesOrdinarySessionAccess(attacker, access)).toBe(false);
}

it("keeps ordinary owner authority private across retained inputs, same-name writes, snapshots, restore, and detached outputs", () => {
  const ownerBinding = createOrdinarySessionAccessBinding(owner);
  const attackerBinding = createOrdinarySessionAccessBinding(attacker);
  const session = fresh("ordinary_private_access", ownerBinding);
  const restoreTarget = fresh("ordinary_private_access", ownerBinding);
  try {
    // Constructor input is retained by the caller, but cannot become a write-through authority.
    ownerBinding.ownerRole = attackerBinding.ownerRole;
    ownerBinding.ownerPrincipalFingerprint = attackerBinding.ownerPrincipalFingerprint;
    expectOwnerBinding(session.getOrdinarySessionAccessBinding(), createOrdinarySessionAccessBinding(owner));

    // An ordinary assignment and an own-property definition may create decoys,
    // but neither may replace the binding read by HTTP authorization or export.
    (session as unknown as Record<string, unknown>).ordinarySessionAccess = attackerBinding;
    expectOwnerBinding(session.getOrdinarySessionAccessBinding(), createOrdinarySessionAccessBinding(owner));
    Object.defineProperty(session, "ordinarySessionAccess", { value: attackerBinding, configurable: true, writable: true });
    expectOwnerBinding(session.getOrdinarySessionAccessBinding(), createOrdinarySessionAccessBinding(owner));

    const observedBinding = session.getOrdinarySessionAccessBinding();
    if (!observedBinding) throw new Error("owner access binding is required for this authority boundary");
    observedBinding.ownerRole = attackerBinding.ownerRole;
    observedBinding.ownerPrincipalFingerprint = attackerBinding.ownerPrincipalFingerprint;
    expectOwnerBinding(session.getOrdinarySessionAccessBinding(), createOrdinarySessionAccessBinding(owner));

    const exported = session.exportOrdinarySessionSnapshot();
    expectOwnerBinding(exported.session.access, createOrdinarySessionAccessBinding(owner));
    if (!exported.session.access) throw new Error("ordinary snapshot must retain its owner access binding");
    exported.session.access.ownerRole = attackerBinding.ownerRole;
    exported.session.access.ownerPrincipalFingerprint = attackerBinding.ownerPrincipalFingerprint;
    expectOwnerBinding(session.getOrdinarySessionAccessBinding(), createOrdinarySessionAccessBinding(owner));
    expectOwnerBinding(session.exportOrdinarySessionSnapshot().session.access, createOrdinarySessionAccessBinding(owner));

    (restoreTarget as unknown as Record<string, unknown>).ordinarySessionAccess = attackerBinding;
    Object.defineProperty(restoreTarget, "ordinarySessionAccess", { value: attackerBinding, configurable: true, writable: true });
    restoreTarget.restoreOrdinarySessionSnapshot(session.exportOrdinarySessionSnapshot());
    expectOwnerBinding(restoreTarget.getOrdinarySessionAccessBinding(), createOrdinarySessionAccessBinding(owner));
  } finally {
    session.close();
    restoreTarget.close();
  }
});

it("keeps acknowledged durable identity private and detached while rejecting invalid acknowledgement", () => {
  const session = fresh("ordinary_private_durable_identity", createOrdinarySessionAccessBinding(owner));
  const acknowledged = durableIdentity();
  const forged = {
    generation: 999,
    envelopeHash: "not-validated",
    snapshotHash: "not-validated",
  };
  try {
    acknowledgeOrdinaryDurableIdentity(session, durableHostCapability, acknowledged);
    acknowledged.generation = 8;
    expect(session.getOrdinaryDurableIdentity()).toEqual(durableIdentity());

    const observed = session.getOrdinaryDurableIdentity();
    if (!observed) throw new Error("durable identity acknowledgement is required for this authority boundary");
    observed.generation = 42;
    observed.envelopeHash = forged.envelopeHash;
    observed.snapshotHash = forged.snapshotHash;
    expect(session.getOrdinaryDurableIdentity()).toEqual(durableIdentity());

    (session as unknown as Record<string, unknown>).ordinaryDurableIdentity = forged;
    expect(session.getOrdinaryDurableIdentity()).toEqual(durableIdentity());
    Object.defineProperty(session, "ordinaryDurableIdentity", { value: forged, configurable: true, writable: true });
    expect(session.getOrdinaryDurableIdentity()).toEqual(durableIdentity());

    expect(() => acknowledgeOrdinaryDurableIdentity(session, durableHostCapability, forged)).toThrow("invalid ordinary durable identity");
    expect(session.getOrdinaryDurableIdentity()).toEqual(durableIdentity());
  } finally {
    session.close();
  }
});

it("does not expose ordinary authority state as raw runtime own properties", () => {
  const session = fresh("ordinary_private_runtime_keys", createOrdinarySessionAccessBinding(owner));
  try {
    expect(Object.getOwnPropertyNames(session)).not.toContain("ordinarySessionAccess");
    expect(Object.getOwnPropertyNames(session)).not.toContain("ordinaryDurableIdentity");
  } finally {
    session.close();
  }
});
