import { describe, expect, it } from "bun:test";

// @ts-ignore The frontend owns this development dependency rather than root package.json.
const compiler: any = await import("../../frontend/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js");

async function compileSfc(path: string) {
  const source = await Bun.file(path).text();
  const parsed = compiler.parse(source, { filename: path });
  expect(parsed.errors).toEqual([]);
  const script = compiler.compileScript(parsed.descriptor, { id: "legacy-direct-mutation-retirement" });
  const template = compiler.compileTemplate({
    source: parsed.descriptor.template?.content ?? "",
    filename: path,
    id: "legacy-direct-mutation-retirement",
    compilerOptions: { bindingMetadata: script.bindings },
  });
  expect(template.errors).toEqual([]);
  return source;
}

describe("owner UI retires legacy direct-mutation controls", () => {
  it("compiles the owner components while wiring KP only for ordinary durable announcements", async () => {
    const [app, dashboard, scene, api] = await Promise.all([
      compileSfc("frontend/src/App.vue"),
      compileSfc("frontend/src/KPDashboard.vue"),
      compileSfc("frontend/src/SceneOverview.vue"),
      Bun.file("frontend/src/api.js").text(),
    ]);

    expect(app).toContain("session.sessionKind === 'ordinary'");
    expect(app).toContain('<KPDashboard v-if="kpVisible && session.sessionKind === \'ordinary\'"');
    expect(app).not.toContain('<KPDashboard v-if="kpVisible && session.sessionKind !== \'compiled\'"');
    expect(app).not.toMatch(/NpcChat|npcChatVisible|chattingNpc|chatNpc|hasLegacyDirectMutations/);
    expect(app).not.toContain("chat-enabled");
    expect(scene).not.toMatch(/chatEnabled|defineEmits\(\['chat'/);

    expect(dashboard).toContain("defineEmits(['close', 'ordinary-message'])");
    expect(dashboard).toContain('v-if="isOrdinary"');
    expect(dashboard).toMatch(/ordinary-kp-(announcement|unavailable)/);
    expect(dashboard).not.toMatch(/getKPState|kpAction|sendLegacyMsg|setSan|setHp|applyDmg|setScene|setDiff|legacy-kp-dashboard/);
    expect(api).not.toMatch(/export async function (getKPState|kpAction|saveCharacterSheet|npcChat)\b/);
    expect(await Bun.file("frontend/src/NpcChat.vue").exists()).toBe(false);
  });

  it("fails closed when KPDashboard is directly mounted outside an ordinary session", async () => {
    const source = await Bun.file("frontend/src/KPDashboard.vue").text();
    const match = /<script setup>\s*([\s\S]*?)<\/script>/.exec(source);
    if (!match) throw new Error("KPDashboard script setup is required");
    const script = match[1]!.replace(/^import .*$/gm, "");
    const ref = <T>(value: T) => ({ value });
    const computed = <T>(getter: () => T) => ({ get value() { return getter(); } });
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const factory = new Function("deps", `
      const { ref, computed, watch, defineProps, defineEmits } = deps;
      ${script}
      return { isOrdinary, ordinaryAnnouncementDisabled, msgText, sendOrdinaryMessage };
    `) as (deps: Record<string, unknown>) => Record<string, any>;
    const mounted = factory({
      ref,
      computed,
      watch: () => {},
      defineProps: () => ({ sessionId: "session", sessionKind: "compiled", ordinaryGeneration: 0, pendingKind: null, busy: false, terminal: null }),
      defineEmits: () => (event: string, payload: Record<string, unknown>) => emitted.push([event, payload]),
    });

    mounted.msgText.value = "this must not emit";
    mounted.sendOrdinaryMessage();
    expect(mounted.isOrdinary.value).toBe(false);
    expect(mounted.ordinaryAnnouncementDisabled.value).toBe(true);
    expect(emitted).toEqual([]);
  });
});
