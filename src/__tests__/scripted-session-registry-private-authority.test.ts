import { describe, expect, it } from "bun:test";
import { createOrdinarySessionAccessBinding } from "../api/session-access";
import { ScriptedSessionRegistry, type ScriptedSession } from "../api/scripted-session";

const OWNER = { role: "keeper" as const, id: "keeper:scripted-expiry-authority" };
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

interface ExpiryRegistryRuntime {
  registry: ScriptedSessionRegistry;
  advanceTo: (value: number) => void;
  starts: () => string[];
}

function createExpiryRegistry(): ExpiryRegistryRuntime {
  let now = 0;
  const started: string[] = [];
  const ids = [UUID_A, UUID_B];
  const registry = new ScriptedSessionRegistry({
    now: () => now,
    maxActive: 1,
    idleTimeoutMs: 100,
    generateId: () => ids.shift() ?? UUID_B,
    createSession: (id) => ({
      id,
      start() { started.push(id); },
    }) as unknown as ScriptedSession,
  });
  return {
    registry,
    advanceTo: (value) => { now = value; },
    starts: () => [...started],
  };
}

type CleanupShadowTarget = {
  cleanupExpired: () => void;
};

describe("ScriptedSessionRegistry expiry cleanup private authority", () => {
  it("does not let an own no-op cleanup shadow retain an expired full-capacity entry", () => {
    const runtime = createExpiryRegistry();
    const access = createOrdinarySessionAccessBinding(OWNER);
    const first = runtime.registry.create(access)!;
    let shadowCalls = 0;
    Object.defineProperty(runtime.registry, "cleanupExpired", {
      configurable: true,
      value: () => { shadowCalls++; },
    });
    const poisoned = runtime.registry as unknown as CleanupShadowTarget;

    runtime.advanceTo(100);
    expect(runtime.registry.create(access)).toBeUndefined();
    expect(runtime.registry.size).toBe(1);
    const callsBeforeDirectInvocation = shadowCalls;
    poisoned.cleanupExpired();
    expect(shadowCalls).toBe(callsBeforeDirectInvocation + 1);
    expect(runtime.registry.size).toBe(1);

    runtime.advanceTo(101);
    const replacement = runtime.registry.create(access);
    expect(replacement?.id).toBe(UUID_B);
    expect(runtime.registry.size).toBe(1);
    expect(runtime.registry.getAuthorized(first.id, OWNER)).toBeUndefined();
    expect(runtime.registry.getAuthorized(UUID_B, OWNER)).toBe(replacement);
    expect(runtime.starts()).toEqual([UUID_A, UUID_B]);
  });

  it("does not let an own throwing cleanup shadow deny an expired replacement", () => {
    const runtime = createExpiryRegistry();
    const access = createOrdinarySessionAccessBinding(OWNER);
    const first = runtime.registry.create(access)!;
    Object.defineProperty(runtime.registry, "cleanupExpired", {
      configurable: true,
      value: () => { throw new Error("forged cleanup failure"); },
    });
    const poisoned = runtime.registry as unknown as CleanupShadowTarget;

    expect(() => poisoned.cleanupExpired()).toThrow("forged cleanup failure");
    runtime.advanceTo(101);
    let replacement: ScriptedSession | undefined;
    expect(() => { replacement = runtime.registry.create(access); }).not.toThrow();
    expect(replacement?.id).toBe(UUID_B);
    expect(runtime.registry.size).toBe(1);
    expect(runtime.registry.getAuthorized(first.id, OWNER)).toBeUndefined();
    expect(runtime.registry.getAuthorized(UUID_B, OWNER)).toBe(replacement);
    expect(runtime.starts()).toEqual([UUID_A, UUID_B]);
  });
});
