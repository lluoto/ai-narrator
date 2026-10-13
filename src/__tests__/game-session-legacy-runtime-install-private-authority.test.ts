import { expect, test } from "bun:test";
import { GameSession } from "../api/game-session";
import {
  ordinaryGameSessionSnapshotHash,
  type OrdinaryGameSessionSnapshot,
} from "../api/ordinary-game-session-snapshot";
import { worldStateSnapshotHash } from "../state/world-state-snapshot";

type ShadowTarget = "own" | "prototype";
type ShadowMode = "fake" | "throw";
type AuthorityMethod =
  | "installRuntimeModulePackage"
  | "assertPickupOriginsAreUnclaimed"
  | "installOrdinarySnapshotModule"
  | "assertInstalledOrdinaryModuleStatics"
  | "assertInstalledOrdinaryPickupState";

const BARN_COMMAND = "加载模组 普瑞米尔的谷仓";

function sessionWithId(id: string, withCharacter = true): GameSession {
  return new GameSession(
    id,
    "cosmic-horror",
    undefined,
    withCharacter ? "detective" : undefined,
    withCharacter ? "Ada" : undefined,
    undefined,
    undefined,
    undefined,
    "development_fallback",
  );
}

function fresh(label: string, withCharacter = true): GameSession {
  return sessionWithId(`legacy-runtime-install-private-${label}-${crypto.randomUUID()}`, withCharacter);
}

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

/** Creates a same-name own/prototype decoy; production methods need not exist. */
function shadowAuthority(
  session: GameSession,
  method: AuthorityMethod,
  target: ShadowTarget,
  mode: ShadowMode,
): { calls: () => number; restore: () => void } {
  const receiver = target === "own" ? session : GameSession.prototype;
  const original = Object.getOwnPropertyDescriptor(receiver, method);
  let calls = 0;
  Object.defineProperty(receiver, method, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      calls += 1;
      if (mode === "throw") throw new Error(`forged ${target} ${method} authority`);
      if (method === "installRuntimeModulePackage") {
        const packageValue = args[0] as { module?: unknown } | undefined;
        // This reports an installed identity while deliberately performing no
        // loader projection. The ordinary command used to publish it anyway.
        return {
          kind: "runtime_module_data_legacy",
          module: packageValue?.module,
          lines: ["forged empty runtime projection"],
          entryScene: undefined,
        };
      }
      return undefined;
    },
  });
  return {
    calls: () => calls,
    restore: () => restoreProperty(receiver, method, original),
  };
}

function eventText(response: Awaited<ReturnType<GameSession["act"]>>): string {
  return response.events.map((event) => event.content).join("\n");
}

async function loadBarn(session: GameSession): Promise<void> {
  const loaded = await session.act(BARN_COMMAND);
  expect(loaded.error).toBeUndefined();
  expect(session.world.listScenes()).not.toHaveLength(0);
}

function resign(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { snapshotHash: _discarded, ...unsigned } = snapshot;
  return { ...unsigned, snapshotHash: ordinaryGameSessionSnapshotHash(unsigned) };
}

function resignWorld(snapshot: OrdinaryGameSessionSnapshot): OrdinaryGameSessionSnapshot {
  const { hash: _discarded, ...unsignedWorld } = snapshot.world;
  snapshot.world = { ...unsignedWorld, hash: worldStateSnapshotHash(unsignedWorld) };
  return resign(snapshot);
}

for (const target of ["own", "prototype"] as const) {
  for (const mode of ["fake", "throw"] as const) {
    test(`public load ignores a ${target} ${mode} runtime dispatcher shadow`, async () => {
      const control = fresh(`load-control-${target}-${mode}`);
      const subject = fresh(`load-subject-${target}-${mode}`);
      let shadow: ReturnType<typeof shadowAuthority> | undefined;
      try {
        await loadBarn(control);
        shadow = shadowAuthority(subject, "installRuntimeModulePackage", target, mode);

        await loadBarn(subject);

        // A forged dispatcher used to publish a package identity even though
        // its loader had installed zero scenes. A throwing one could DoS the
        // same public load. Neither may participate in the real path.
        expect(shadow.calls()).toBe(0);
        expect(subject.exportOrdinarySessionSnapshot().module).toEqual(control.exportOrdinarySessionSnapshot().module);
        expect(subject.world.listScenes()).toEqual(control.world.listScenes());
      } finally {
        shadow?.restore();
        subject.close();
        control.close();
      }
    });

    test(`generated-story install ignores a ${target} ${mode} runtime dispatcher shadow`, async () => {
        const subject = fresh(`generated-${target}-${mode}`);
      let shadow: ReturnType<typeof shadowAuthority> | undefined;
      try {
        shadow = shadowAuthority(subject, "installRuntimeModulePackage", target, mode);

        const generated = await subject.act("生成故事");

        expect(generated.error).toBeUndefined();
        expect(shadow.calls()).toBe(0);
        expect(subject.exportOrdinarySessionSnapshot().module.package).not.toBeNull();
        expect(subject.world.listScenes()).not.toHaveLength(0);
      } finally {
        shadow?.restore();
        subject.close();
      }
    });

    test(`pre-host pickup-origin rejection ignores a ${target} ${mode} assertion shadow`, async () => {
      const subject = fresh(`origin-${target}-${mode}`);
      let shadow: ReturnType<typeof shadowAuthority> | undefined;
      try {
        expect(subject.setPlayerInventory("p1", ["老旧文件"])).toBe(true);
        shadow = shadowAuthority(subject, "assertPickupOriginsAreUnclaimed", target, mode);

        const rejected = await subject.act(BARN_COMMAND);

        expect(shadow.calls()).toBe(0);
        expect(eventText(rejected)).toContain("runtime pickup origin already exists in player inventory: 老旧文件");
        expect(subject.world.getScene("艾德里安的卧室")).toBeNull();
        expect(subject.exportOrdinarySessionSnapshot().module).toEqual({ package: null, contentHash: null });
        expect(subject.world.getPlayerInventory("p1")).toEqual(["老旧文件"]);
      } finally {
        shadow?.restore();
        subject.close();
      }
    });

    test(`ordinary restore ignores a ${target} ${mode} snapshot-installer shadow`, async () => {
      const id = `legacy-runtime-install-private-restore-${target}-${mode}-${crypto.randomUUID()}`;
      const source = sessionWithId(id);
      const restored = sessionWithId(id, false);
      let shadow: ReturnType<typeof shadowAuthority> | undefined;
      try {
        await loadBarn(source);
        const snapshot = structuredClone(source.exportOrdinarySessionSnapshot());
        shadow = shadowAuthority(restored, "installOrdinarySnapshotModule", target, mode);

        expect(() => restored.restoreOrdinarySessionSnapshot(snapshot)).not.toThrow();

        expect(shadow.calls()).toBe(0);
        expect(restored.exportOrdinarySessionSnapshot()).toEqual(snapshot);
      } finally {
        shadow?.restore();
        restored.close();
        source.close();
      }
    });

    test(`rehashed source projection cannot bypass a ${target} ${mode} static assertion shadow`, async () => {
      const id = `legacy-runtime-install-private-static-${target}-${mode}-${crypto.randomUUID()}`;
      const source = sessionWithId(id);
      const restored = sessionWithId(id, false);
      let shadow: ReturnType<typeof shadowAuthority> | undefined;
      try {
        await loadBarn(source);
        const rawForged = structuredClone(source.exportOrdinarySessionSnapshot());
        const scene = rawForged.world.tables.scenes.find((entry) => entry.description.length > 0);
        if (!scene) throw new Error("Barn fixture requires a source scene description");
        scene.description = "forged rehashed source projection";
        const forged = resignWorld(rawForged);

        shadow = shadowAuthority(restored, "assertInstalledOrdinaryModuleStatics", target, mode);

        expect(() => restored.restoreOrdinarySessionSnapshot(forged)).toThrow("ordinary snapshot restore failed closed");

        expect(shadow.calls()).toBe(0);
      } finally {
        shadow?.restore();
        restored.close();
        source.close();
      }
    });

    test(`rehashed pickup conservation forge cannot bypass a ${target} ${mode} pickup assertion shadow`, async () => {
      const id = `legacy-runtime-install-private-pickup-${target}-${mode}-${crypto.randomUUID()}`;
      const source = sessionWithId(id);
      const restored = sessionWithId(id, false);
      let shadow: ReturnType<typeof shadowAuthority> | undefined;
      try {
        await loadBarn(source);
        const rawForged = structuredClone(source.exportOrdinarySessionSnapshot());
        const bedroom = rawForged.state.sceneItems.find((entry) => entry.sceneId === "艾德里安的卧室");
        if (!bedroom) throw new Error("Barn fixture requires the old-file placement");
        bedroom.items = bedroom.items.filter((item) => item !== "老旧文件");
        const forged = resign(rawForged);

        shadow = shadowAuthority(restored, "assertInstalledOrdinaryPickupState", target, mode);

        expect(() => restored.restoreOrdinarySessionSnapshot(forged)).toThrow("ordinary snapshot restore failed closed");

        expect(shadow.calls()).toBe(0);
      } finally {
        shadow?.restore();
        restored.close();
        source.close();
      }
    });
  }
}
