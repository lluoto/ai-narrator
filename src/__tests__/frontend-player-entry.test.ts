import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, extname, join, normalize } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "url";
import { compileScript, compileTemplate, parse } from "../../frontend/node_modules/vue/compiler-sfc/index.mjs";
import { renderToString } from "../../frontend/node_modules/vue/server-renderer/index.mjs";
// @ts-expect-error Browser module intentionally has no declaration file.
import { createPlayerFacadePolling, createPlayerInvitationClaim, isPlayerNamespacePath } from "../../frontend/src/player-lifecycle.js";

const root = join(import.meta.dir, "..", "..", "frontend", "src");
const playerApp = readFileSync(join(root, "PlayerApp.vue"), "utf8");
const playerApi = readFileSync(join(root, "player-api.js"), "utf8");
const playerLifecycle = readFileSync(join(root, "player-lifecycle.js"), "utf8");
const main = readFileSync(join(root, "main.js"), "utf8");
const ownerMarkers = ["mechanismId", "pcId", "@compiled", "/compiled/actions", "/kp", "/character", "/npc-chat"];

const vueRuntime = pathToFileURL(join(root, "..", "node_modules", "vue", "index.mjs")).href;
const vueServerRenderer = pathToFileURL(join(root, "..", "node_modules", "vue", "server-renderer", "index.mjs")).href;
const playerApiModule = pathToFileURL(join(root, "player-api.js")).href;
const playerLifecycleModule = pathToFileURL(join(root, "player-lifecycle.js")).href;

type CreateSSRApp = typeof import("../../frontend/node_modules/vue/dist/vue.d.mts").createSSRApp;
type EffectScope = typeof import("../../frontend/node_modules/vue/dist/vue.d.mts").effectScope;
type PlayerAppSetupState = {
  view: { value: Record<string, unknown> };
  loading: { value: boolean };
  actionPending: { value: boolean };
  componentActive: boolean;
  intentInput: { value: string };
  intentChoices: { value: Array<{ choiceId: string; label: string }> };
  submitIntent: () => Promise<void>;
  followupContact: { value: { name: string; contactToken: string } | null };
  followupInput: { value: string };
  submitFollowup: () => Promise<void>;
};
type PlayerAppComponent = Parameters<CreateSSRApp>[0] & {
  setup: (props: unknown, context: unknown) => PlayerAppSetupState;
};
type CapturedPlayerApp = { html: string; state: PlayerAppSetupState; render: () => Promise<string>; dispose: () => void };
const liveSetupScopes = new Set<() => void>();
afterEach(() => { for (const dispose of liveSetupScopes) dispose(); });
type PlayerAppTestGlobals = {
  window?: { location: { pathname: string; search: string; hash: string }; sessionStorage: null };
  document?: { hidden: boolean };
};

function renderPlayerApp(view: Record<string, unknown>): Promise<string>;
function renderPlayerApp(view: Record<string, unknown>, capture: true, sessionId?: string): Promise<CapturedPlayerApp>;
async function renderPlayerApp(view: Record<string, unknown>, capture = false, sessionId = "player-render"): Promise<string | CapturedPlayerApp> {
  const parsed = parse(playerApp, { filename: join(root, "PlayerApp.vue") });
  if (parsed.errors.length) throw new Error(String(parsed.errors[0]));
  const script = compileScript(parsed.descriptor, { id: "player-entry-render", genDefaultAs: "__sfc__" });
  const template = compileTemplate({
    source: parsed.descriptor.template?.content || "",
    filename: join(root, "PlayerApp.vue"),
    id: "player-entry-render",
    ssr: true,
    ssrCssVars: parsed.descriptor.cssVars,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  if (template.errors.length) throw new Error(String(template.errors[0]));
  const moduleSource = `${script.content}\n${template.code.replace("export function ssrRender", "function ssrRender")}\n__sfc__.ssrRender = ssrRender;\nexport default __sfc__;`
    .replaceAll("from 'vue'", `from '${vueRuntime}'`)
    .replaceAll('from "vue"', `from "${vueRuntime}"`)
    .replaceAll("from 'vue/server-renderer'", `from '${vueServerRenderer}'`)
    .replaceAll('from "vue/server-renderer"', `from "${vueServerRenderer}"`)
    .replaceAll("from './player-api.js'", `from '${playerApiModule}'`)
    .replaceAll("from './player-lifecycle.js'", `from '${playerLifecycleModule}'`);
  const directory = mkdtempSync(join(tmpdir(), "aitrpg-player-entry-render-"));
  const filename = join(directory, "PlayerApp.render.mjs");
  writeFileSync(filename, moduleSource, "utf8");
  const testGlobals = globalThis as typeof globalThis & PlayerAppTestGlobals;
  const originalWindow = testGlobals.window;
  const originalDocument = testGlobals.document;
  Object.defineProperty(testGlobals, "window", {
    configurable: true,
    value: { location: { pathname: `/play/${sessionId}`, search: "", hash: "" }, sessionStorage: null },
  });
  Object.defineProperty(testGlobals, "document", { configurable: true, value: { hidden: false } });
  try {
    const component = (await import(`${pathToFileURL(filename).href}?render=${Date.now()}`) as { default: PlayerAppComponent }).default;
    const { createSSRApp, effectScope } = await import(vueRuntime) as { createSSRApp: CreateSSRApp; effectScope: EffectScope };
    const setup = component.setup;
    let captured: PlayerAppSetupState | undefined;
    component.setup = (props: unknown, context: unknown) => {
      const state = setup(props, context);
      state.view.value = view;
      state.loading.value = false;
      captured = state;
      return state;
    };
    if (capture) {
      // SSR stops its setup watchers after rendering. Run the real setup in a
      // live Vue effect scope so subsequent handler/ref changes keep the same
      // reactive lifecycle. Mount hooks are covered separately by poller tests.
      const scope = effectScope();
      const originalWarn = console.warn;
      console.warn = (message: unknown, ...args: unknown[]) => {
        if (typeof message === "string" && /^\[Vue warn\]: on(Mounted|BeforeUnmount) is called/.test(message)) return;
        originalWarn(message, ...args);
      };
      try { scope.run(() => component.setup({}, { expose: () => {} })); }
      finally { console.warn = originalWarn; }
      if (!captured) throw new Error("player app setup did not run");
      const render = () => renderToString(createSSRApp({ ...component, setup: () => captured! }));
      const dispose = () => { scope.stop(); liveSetupScopes.delete(dispose); };
      liveSetupScopes.add(dispose);
      return { html: await render(), state: captured, render, dispose };
    }
    return renderToString(createSSRApp(component));
  } finally {
    Object.defineProperty(testGlobals, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(testGlobals, "document", { configurable: true, value: originalDocument });
    rmSync(directory, { recursive: true, force: true });
  }
}

function localImports(source: string): string[] {
  const imports: string[] = [];
  for (const pattern of [
    /\bimport\s+(?:[\w*${},\s]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]?.startsWith(".")) imports.push(match[1]);
    }
  }
  return imports;
}

function resolveLocalModule(from: string, specifier: string): string {
  const candidate = normalize(join(dirname(from), specifier));
  if (extname(candidate)) return candidate;
  for (const extension of [".js", ".vue", "/index.js", "/index.vue"]) {
    if (existsSync(`${candidate}${extension}`)) return `${candidate}${extension}`;
  }
  throw new Error(`unresolved player-local import ${specifier} from ${from}`);
}

function reachablePlayerSources(): Map<string, string> {
  const roots = [join(root, "PlayerApp.vue"), join(root, "player-api.js"), join(root, "player-lifecycle.js")];
  const visited = new Map<string, string>();
  const visit = (filename: string) => {
    if (visited.has(filename)) return;
    const source = readFileSync(filename, "utf8");
    visited.set(filename, source);
    for (const specifier of localImports(source)) visit(resolveLocalModule(filename, specifier));
  };
  for (const filename of roots) visit(filename);
  return visited;
}

const FOLLOWUP_CONTACT = { name: "Mira", contactToken: `contact_${"m".repeat(43)}` };
const OTHER_FOLLOWUP_CONTACT = { name: "Noah", contactToken: `contact_${"n".repeat(43)}` };
type FollowupBody = { contactToken: string; actionId: string; expectedGeneration: number; playerInput: string; previousActionId?: string };

function followupView(generation = 3) {
  return {
    character: { name: "Ada", hp: 9, maxHp: 12 },
    sanity: { currentSAN: 57, maxSAN: 70 },
    round: 4, generation, terminal: false, actions: [],
    presentation: { scene: { name: "Dock", description: "The launch is gone." }, clues: [], contacts: [FOLLOWUP_CONTACT, OTHER_FOLLOWUP_CONTACT] },
  };
}

async function withFollowupTransport(run: (harness: {
  calls: Array<{ url: string; body: FollowupBody }>;
  storage: Map<string, string>;
  respond: (reply: (body: FollowupBody) => Response) => void;
}) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map<string, string>();
  const calls: Array<{ url: string; body: FollowupBody }> = [];
  let reply = (body: FollowupBody) => new Response(JSON.stringify({ status: "delivered", followup: { text: "Mira saw someone by the dock." }, view: followupView(body.expectedGeneration) }));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } },
  });
  globalThis.fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith("/player-followups")) throw new Error(`unexpected player request: ${url}`);
    const body = JSON.parse(String(init?.body)) as FollowupBody;
    calls.push({ url: String(url), body });
    return reply(body);
  }, { preconnect: originalFetch.preconnect });
  try {
    await run({ calls, storage, respond: (next) => { reply = next; } });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

const INTENT_CHOICES = [
  { choiceId: `choice_${"q".repeat(43)}`, label: "Go to another area" },
  { choiceId: `choice_${"r".repeat(43)}`, label: "Go to another area" },
];
const INTENT_TOPIC_BOUND = "a".repeat(64);
type IntentCall = { url: string; body: Record<string, unknown> };

async function clickMatchingAction(state: PlayerAppSetupState, action: typeof INTENT_CHOICES[number]) {
  const expression = /v-for="action in intentChoices"[^>]*@click="([^"]+)"/.exec(playerApp)?.[1];
  if (!expression) throw new Error("matching action button lacks its click handler");
  const { proxyRefs } = await import(vueRuntime) as { proxyRefs: (value: PlayerAppSetupState) => object };
  // Execute the actual template event expression with Vue's setup unwrapping,
  // so an assertion cannot silently use a better hand-written event binding.
  await new Function("scope", "action", `with (scope) { return ${expression}; }`)(proxyRefs(state), action);
}

async function withIntentTransport(run: (harness: {
  calls: IntentCall[];
  storage: Map<string, string>;
  respondAction: (reply: (body: Record<string, unknown>) => Response) => void;
  respondIntent: (reply: (body: Record<string, unknown>) => Response | Promise<Response>) => void;
}) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map<string, string>();
  const calls: IntentCall[] = [];
  let intentReply = (body: Record<string, unknown>): Response | Promise<Response> => new Response(JSON.stringify({
    status: "ambiguous", actions: INTENT_CHOICES, topicBound: INTENT_TOPIC_BOUND, generation: body.expectedGeneration,
  }));
  let actionReply = (body: Record<string, unknown>) => new Response(JSON.stringify({ result: { status: "committed" }, view: followupView(Number(body.expectedGeneration) + 1) }));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } },
  });
  globalThis.fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/player-intents")) return intentReply(body);
    if (String(url).endsWith("/player-actions")) return actionReply(body);
    throw new Error(`unexpected player request: ${url}`);
  }, { preconnect: originalFetch.preconnect });
  try { await run({ calls, storage, respondAction: (reply) => { actionReply = reply; }, respondIntent: (reply) => { intentReply = reply; } }); }
  finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

describe("/play player entry", () => {
  it("selects the sealed player application rather than the owner/Keeper client", () => {
    expect(main).toContain("isPlayerNamespacePath(window.location.pathname)");
    expect(main).toContain("await import('./PlayerApp.vue')");
    expect(main).toContain("await import('./App.vue')");
    expect(main).not.toContain("import App from './App.vue'");
    expect(main).not.toContain("import PlayerApp from './PlayerApp.vue'");
    expect(playerApp).toContain("from './player-api.js'");
    expect(playerApp).not.toContain("from './api.js'");
    expect(playerApi).not.toContain("from './api.js'");
    for (const forbidden of ["getSession", "listSessions", "getHistory", "getKPState", "getCompiledActions", "sendSessionAction", "mechanismId", "pcId", "@compiled"]) {
      expect(playerApp).not.toContain(forbidden);
      expect(playerApi).not.toContain(forbidden);
    }
    for (const forbidden of ["/compiled/actions", "/kp", "/character", "/npc-chat"]) expect(playerApi).not.toContain(forbidden);
    expect(isPlayerNamespacePath("/play")).toBe(true);
    expect(isPlayerNamespacePath("/play/id/")).toBe(true);
    expect(isPlayerNamespacePath("/play/a/b")).toBe(true);
    expect(isPlayerNamespacePath("/sessions/id")).toBe(false);
  });

  it("keeps every local source reachable from the player entries free of the owner API surface", () => {
    const reachable = reachablePlayerSources();
    expect(reachable.size).toBeGreaterThanOrEqual(3);
    for (const [filename, source] of reachable) {
      expect(filename.replace(/\\/g, "/")).not.toMatch(/\/api\.js$/);
      for (const forbidden of ownerMarkers) expect(source).not.toContain(forbidden);
    }
  });

  it("clears the fragment before the sealed in-memory claim lifecycle and never stores the invite", () => {
    const clearFragment = playerApp.indexOf("window.history.replaceState");
    const claim = playerApp.indexOf("await invitationClaim.claimInvite(invite)");
    expect(clearFragment).toBeGreaterThanOrEqual(0);
    expect(claim).toBeGreaterThan(clearFragment);
    expect(playerLifecycle).toContain("claimIdInMemory = claimId");
    expect(playerLifecycle).toContain("persistClaimId(claimId)");
    expect(playerLifecycle).not.toContain("setItem(storageKey, invite");
    expect(playerLifecycle).not.toContain("localStorage");
  });

  it("uses the abortable player poller for hidden/unmounted pages", () => {
    for (const signal of ["createPlayerFacadePolling", "playerPoller.pause()", "playerPoller.stop()", "onBeforeUnmount", "visibilitychange", "isSafePlayerFacadeSessionId"]) {
      expect(playerApp).toContain(signal);
    }
    expect(playerApp.indexOf("playerPoller.pause()")).toBeLessThan(playerApp.indexOf("await sendPlayerFacadeAction"));
    expect(playerApp.indexOf("playerPoller.resume()")).toBeGreaterThan(playerApp.indexOf("await sendPlayerFacadeAction"));
  });

  it("offers natural-language classification through the sealed player transport before reusing opaque choices", () => {
    expect(playerApp).toContain("resolvePlayerFacadeIntent");
    expect(playerApp).toContain("submitIntent");
    expect(playerApi).toContain("/player-intents");
    expect(playerApi).not.toContain("/compiled/intents");
  });

  it("posts only the explicitly chosen ambiguous option with the response's top-level topic binding", async () => {
    await withIntentTransport(async ({ calls, storage }) => {
      const { state } = await renderPlayerApp(followupView(), true);
      state.componentActive = true;
      state.intentInput.value = "I go through one of the passages.";
      await state.submitIntent();
      expect(calls).toHaveLength(1);
      expect(state.intentChoices.value).toEqual(INTENT_CHOICES);
      expect(state.intentChoices.value[1]).not.toHaveProperty("topicBound");
      await clickMatchingAction(state, state.intentChoices.value[1]!);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.url).toBe("/api/sessions/player-render/player-actions");
      expect(calls[1]!.body).toEqual({ choiceId: INTENT_CHOICES[1]!.choiceId, actionId: expect.any(String), expectedGeneration: 3, topicBound: INTENT_TOPIC_BOUND, playerInput: "I go through one of the passages." });
      expect(storage.size).toBe(0);
    });
  });

  it("invalidates ambiguous choices on edited input, cancellation, generation advance, and terminal state", async () => {
    await withIntentTransport(async ({ calls, storage }) => {
      const invalidate = [
        (state: PlayerAppSetupState) => { state.intentInput.value = "I look behind the door instead."; },
        (state: PlayerAppSetupState) => { state.intentInput.value = ""; },
        (state: PlayerAppSetupState) => { state.view.value = followupView(4); },
        (state: PlayerAppSetupState) => { state.view.value = { ...followupView(), terminal: true }; },
      ];
      for (const [index, change] of invalidate.entries()) {
        const { state } = await renderPlayerApp(followupView(), true, `ambiguous-scope-${index}`);
        state.componentActive = true;
        state.intentInput.value = "I go through one of the passages.";
        await state.submitIntent();
        const stale = state.intentChoices.value[1]!;
        change(state);
        expect(state.intentChoices.value).toEqual([]);
        await clickMatchingAction(state, stale);
      }
      expect(calls).toHaveLength(4);
      expect(calls.every((call) => call.url.endsWith("/player-intents"))).toBe(true);
      expect(storage.size).toBe(0);
    });
  });

  it("retries the same explicitly chosen ambiguous action after a lost response without persisting prose", async () => {
    await withIntentTransport(async ({ calls, storage, respondAction }) => {
      const { state } = await renderPlayerApp(followupView(), true);
      state.componentActive = true;
      const raw = "I go through the second passage.";
      state.intentInput.value = raw;
      await state.submitIntent();
      respondAction(() => { throw new TypeError("lost action response"); });
      await clickMatchingAction(state, state.intentChoices.value[1]!);
      expect(storage.size).toBe(1);
      const pending = JSON.parse([...storage.values()][0]!) as Record<string, unknown>;
      expect(pending).toMatchObject({ version: 2, choiceId: INTENT_CHOICES[1]!.choiceId, topicBound: INTENT_TOPIC_BOUND, expectedGeneration: 3 });
      expect(JSON.stringify(pending)).not.toContain(raw);
      respondAction((body) => new Response(JSON.stringify({ result: { status: "duplicate" }, view: followupView(Number(body.expectedGeneration) + 1) })));
      await state.submitIntent();
      await clickMatchingAction(state, state.intentChoices.value[1]!);
      const actions = calls.filter((call) => call.url.endsWith("/player-actions"));
      expect(actions).toHaveLength(2);
      expect(actions[1]!.body).toEqual(actions[0]!.body);
      expect(actions[1]!.body.choiceId).toBe(INTENT_CHOICES[1]!.choiceId);
      expect(storage.size).toBe(0);
    });
  });

  it("discards a late ambiguous classification after its input or generation has changed", async () => {
    await withIntentTransport(async ({ calls, respondIntent }) => {
      for (const changed of ["input", "generation"] as const) {
        const { state } = await renderPlayerApp(followupView(), true);
        state.componentActive = true;
        state.intentInput.value = "I go through one of the passages.";
        let finish: ((response: Response) => void) | undefined;
        respondIntent(() => new Promise<Response>((resolve) => { finish = resolve; }));
        const request = state.submitIntent();
        if (changed === "input") state.intentInput.value = "I wait here instead.";
        else state.view.value = followupView(4);
        finish?.(new Response(JSON.stringify({ status: "ambiguous", actions: INTENT_CHOICES, topicBound: INTENT_TOPIC_BOUND, generation: 3 })));
        await request;
        expect(state.intentChoices.value).toEqual([]);
      }
      expect(calls).toHaveLength(2);
    });
  });

  it("renders only authorized presentation and persisted turn text from a reloaded player view", async () => {
    const reloadedView = {
      character: { name: "Ada", hp: 9, maxHp: 12 },
      sanity: { currentSAN: 57, maxSAN: 70 },
      round: 4,
      terminal: true,
      actions: [],
      presentation: {
        scene: { name: "档案室", description: "雨水敲打着紧闭的窗。" },
        clues: [{ name: "父线索", revelation: "一把档案室钥匙。" }],
        contacts: [{ name: "Mira", npcId: "npc-private", knowledge: "不应显示的 NPC 私密信息。" }],
        ending: { name: "平安离开", description: "你们带着证据离开了小镇。" },
        endingId: "ending_private_clean",
        endings: [{ name: "未选择结局", description: "不应显示。" }],
      },
      turn: { generation: 4, text: "雨水渐歇。<img src=x onerror=alert(1)>" },
      history: [{ text: "不应显示的历史。" }],
    };
    const html = await renderPlayerApp(reloadedView);
    for (const publicText of ["档案室", "雨水敲打着紧闭的窗。", "父线索", "一把档案室钥匙。", "Contacts", "Mira", "平安离开", "你们带着证据离开了小镇。", "雨水渐歇。"]) {
      expect(html).toContain(publicText);
    }
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    for (const hidden of ["ending_private_clean", "未选择结局", "不应显示。", "不应显示的历史。", "npc-private", "不应显示的 NPC 私密信息。", "<img src=x onerror=alert(1)>"]) {
      expect(html).not.toContain(hidden);
    }
    const withoutTurn = await renderPlayerApp({ ...reloadedView, turn: undefined });
    expect(withoutTurn).not.toContain("雨水渐歇。");
    expect(withoutTurn).not.toContain("Latest turn");
  });

  it("renders a terminal contact as read-only rather than offering a new follow-up", async () => {
    const html = await renderPlayerApp({
      character: { name: "Ada", hp: 9, maxHp: 12 },
      sanity: { currentSAN: 57, maxSAN: 70 },
      round: 4,
      terminal: true,
      actions: [],
      presentation: {
        scene: { name: "Dock", description: "The launch is gone." },
        clues: [],
        contacts: [{ name: "Mira", contactToken: `contact_${"t".repeat(43)}` }],
      },
    });
    expect(html).toContain("Mira");
    expect(html).toContain('<button type="button" disabled>Mira</button>');
    expect(html).not.toContain("Ask Mira");
  });

  it("does not dispatch a terminal follow-up even if a stale UI handler is invoked", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = Object.assign(
      async (..._args: Parameters<typeof fetch>): Promise<Response> => {
        calls += 1;
        throw new Error("terminal follow-up reached transport");
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const rendered = await renderPlayerApp({
        character: { name: "Ada", hp: 9, maxHp: 12 },
        sanity: { currentSAN: 57, maxSAN: 70 },
        round: 4,
        generation: 1,
        terminal: true,
        actions: [],
        presentation: {
          scene: { name: "Dock", description: "The launch is gone." },
          clues: [],
          contacts: [{ name: "Mira", contactToken: `contact_${"t".repeat(43)}` }],
        },
      }, true);
      rendered.state.followupContact.value = { name: "Mira", contactToken: `contact_${"t".repeat(43)}` };
      rendered.state.followupInput.value = "Can you still answer?";
      expect(rendered.state.view.value.terminal).toBe(true);
      expect(rendered.state.actionPending.value).toBe(false);
      expect(rendered.state.followupContact.value?.contactToken).toEqual(`contact_${"t".repeat(43)}`);
      expect(rendered.state.followupInput.value).toBe("Can you still answer?");
      await rendered.state.submitFollowup();
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends the previous successful UI question's action ID with the next natural follow-up", async () => {
    await withFollowupTransport(async ({ calls, storage }) => {
      const { state, render } = await renderPlayerApp(followupView(), true);
      state.componentActive = true;
      state.followupContact.value = FOLLOWUP_CONTACT;
      state.followupInput.value = "你在码头看到了谁？";
      await state.submitFollowup();
      expect(await render()).toContain("Mira saw someone by the dock.");
      state.followupInput.value = "那个人之后往哪儿走？";
      await state.submitFollowup();
      expect(calls).toHaveLength(2);
      expect(calls[0]!.body.previousActionId).toBeUndefined();
      expect(calls[1]!.body.previousActionId).toBe(calls[0]!.body.actionId);
      expect(calls[1]!.body.actionId).not.toBe(calls[0]!.body.actionId);
      expect(calls[1]!.body.playerInput).toBe("那个人之后往哪儿走？");
      expect(storage.size).toBe(0);
    });
  });

  it("isolates the UI continuity head across contact, generation, and session changes", async () => {
    await withFollowupTransport(async ({ calls }) => {
      const { state, render } = await renderPlayerApp(followupView(), true);
      state.componentActive = true;
      const ask = async (contact: typeof FOLLOWUP_CONTACT, question: string) => {
        state.followupContact.value = contact;
        state.followupInput.value = question;
        await state.submitFollowup();
      };
      await ask(FOLLOWUP_CONTACT, "Who was at the dock?");
      expect(await render()).toContain("Mira saw someone by the dock.");
      state.followupContact.value = OTHER_FOLLOWUP_CONTACT;
      expect(await render()).not.toContain("Mira saw someone by the dock.");
      state.followupContact.value = FOLLOWUP_CONTACT;
      expect(await render()).not.toContain("Mira saw someone by the dock.");
      await ask(OTHER_FOLLOWUP_CONTACT, "What did you see?");
      await ask(FOLLOWUP_CONTACT, "Can you answer again?");
      state.view.value = followupView(4);
      expect(await render()).not.toContain("Mira saw someone by the dock.");
      await ask(FOLLOWUP_CONTACT, "What changed?");
      const other = await renderPlayerApp(followupView(4), true, "other-player-session");
      other.state.componentActive = true;
      other.state.followupContact.value = FOLLOWUP_CONTACT;
      other.state.followupInput.value = "Who was there in this session?";
      await other.state.submitFollowup();
      expect(calls).toHaveLength(5);
      for (const call of calls) expect(call.body.previousActionId).toBeUndefined();
      expect(calls[4]!.url).toBe("/api/sessions/other-player-session/player-followups");
      state.view.value = { ...followupView(4), terminal: true };
      expect(await render()).not.toContain("Mira saw someone by the dock.");
    });
  });

  it("uses the confirmed replay's actual pending action ID after a lost UI response", async () => {
    await withFollowupTransport(async ({ calls, storage, respond }) => {
      const { state } = await renderPlayerApp(followupView(), true);
      state.componentActive = true;
      state.followupContact.value = FOLLOWUP_CONTACT;
      state.followupInput.value = "Who did you see?";
      await state.submitFollowup();
      respond(() => { throw new TypeError("response lost"); });
      state.followupInput.value = "Where did that person go?";
      await state.submitFollowup();
      expect(storage.size).toBe(1);
      respond((body) => new Response(JSON.stringify({ status: "replayed", followup: { text: "Toward the lighthouse." }, view: followupView(body.expectedGeneration) })));
      await state.submitFollowup();
      state.followupInput.value = "Was anyone waiting there?";
      await state.submitFollowup();
      expect(calls).toHaveLength(4);
      expect(calls[1]!.body.previousActionId).toBe(calls[0]!.body.actionId);
      expect(calls[2]!.body).toEqual(calls[1]!.body);
      expect(calls[3]!.body.previousActionId).toBe(calls[1]!.body.actionId);
      expect(storage.size).toBe(0);
    });
  });

  it("keeps unknown HTTP success pending without showing or promoting its unconfirmed reply", async () => {
    await withFollowupTransport(async ({ calls, storage, respond }) => {
      const { state, render } = await renderPlayerApp(followupView(), true);
      state.componentActive = true;
      state.followupContact.value = FOLLOWUP_CONTACT;
      state.followupInput.value = "Who did you see?";
      await state.submitFollowup();
      respond((body) => new Response(JSON.stringify({ status: "unknown", followup: { text: "Unconfirmed private answer." }, view: followupView(body.expectedGeneration) })));
      state.followupInput.value = "Where did that person go?";
      await state.submitFollowup();
      expect(storage.size).toBe(1);
      expect(await render()).not.toContain("Unconfirmed private answer.");
      respond((body) => new Response(JSON.stringify({ status: "delivered", followup: { text: "Toward the lighthouse." }, view: followupView(body.expectedGeneration) })));
      await state.submitFollowup();
      expect(calls).toHaveLength(3);
      expect(calls[2]!.body).toEqual(calls[1]!.body);
      expect(calls[2]!.body.previousActionId).toBe(calls[0]!.body.actionId);
      expect(await render()).toContain("Toward the lighthouse.");
      expect(storage.size).toBe(0);
    });
  });

  it("reuses the in-memory 256-bit claim ID if sessionStorage rejects the first persistence", async () => {
    const attempts: Array<{ invite: string; claimId: string }> = [];
    const storage = {
      getItem() { throw new Error("storage denied"); },
      setItem() { throw new Error("storage denied"); },
      removeItem() { throw new Error("storage denied"); },
    };
    const lifecycle = createPlayerInvitationClaim({
      sessionId: "delivery-session",
      storage,
      createClaimId: () => "c".repeat(43),
      claim: async (attempt: { invite: string; claimId: string }) => {
        attempts.push(attempt);
        if (attempts.length === 1) throw new TypeError("response lost");
      },
    });
    await expect(lifecycle.claimInvite("i".repeat(43))).rejects.toThrow("response lost");
    await expect(lifecycle.retry()).resolves.toBe(true);
    expect(attempts).toEqual([
      { invite: "i".repeat(43), claimId: "c".repeat(43) },
      { invite: "i".repeat(43), claimId: "c".repeat(43) },
    ]);
  });

  it("discards polluted stored claim IDs before generating the protocol nonce", async () => {
    const removed: string[] = [];
    const attempts: Array<{ invite: string; claimId: string }> = [];
    const lifecycle = createPlayerInvitationClaim({
      sessionId: "delivery-session",
      storage: {
        getItem: () => "not-a-claim-id",
        setItem: () => {},
        removeItem: (key: string) => { removed.push(key); },
      },
      createClaimId: () => "z".repeat(43),
      claim: async (attempt: { invite: string; claimId: string }) => { attempts.push(attempt); },
    });
    await lifecycle.claimInvite("i".repeat(43));
    expect(attempts).toEqual([{ invite: "i".repeat(43), claimId: "z".repeat(43) }]);
    expect(removed).toEqual(["aitrpg.player-claim.v1:delivery-session", "aitrpg.player-claim.v1:delivery-session"]);
  });

  it("aborts an in-flight view on pause and does not reschedule after a 401", async () => {
    let resolveView: ((value: { generation: number }) => void) | undefined;
    let receivedSignal: AbortSignal | undefined;
    const writes: unknown[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    let unauthorized = 0;
    const poller = createPlayerFacadePolling({
      readView: ({ signal }: { signal: AbortSignal }) => new Promise<{ generation: number }>((resolve) => {
        receivedSignal = signal;
        resolveView = resolve;
      }),
      onView: (next: unknown) => writes.push(next),
      onError: () => { throw new Error("unexpected poll error"); },
      onUnauthorized: () => { unauthorized += 1; },
      isHidden: () => false,
      setTimer: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => {},
    });
    poller.activate();
    const inFlight = poller.refresh();
    expect(receivedSignal?.aborted).toBe(false);
    poller.pause();
    expect(receivedSignal?.aborted).toBe(true);
    // Model a durable action committing generation 2 while the aborted GET
    // still resolves with generation 1: the stale read must not overwrite it.
    writes.push({ generation: 2 });
    resolveView?.({ generation: 1 });
    await inFlight;
    expect(writes).toEqual([{ generation: 2 }]);

    const rejected = createPlayerFacadePolling({
      readView: async () => { const error = new Error("PLAYER_AUTH_REQUIRED") as Error & { status?: number }; error.status = 401; throw error; },
      onView: () => { throw new Error("unexpected view"); },
      onError: () => { throw new Error("unexpected retry"); },
      onUnauthorized: () => { unauthorized += 1; },
      isHidden: () => false,
      setTimer: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => {},
    });
    rejected.activate();
    await rejected.refresh();
    rejected.resume();
    expect(unauthorized).toBe(1);
    expect(timers).toEqual([]);
  });

  it("keeps view polling single-flight, backs off transient failures, resets after success, and does not start hidden", async () => {
    let calls = 0;
    let firstResolve: ((value: { generation: number }) => void) | undefined;
    const timerDelays: number[] = [];
    const outcomes: Array<"retry" | "success"> = ["retry", "retry", "success"];
    const poller = createPlayerFacadePolling({
      readView: async () => {
        calls += 1;
        if (calls === 1) return new Promise<{ generation: number }>((resolve) => { firstResolve = resolve; });
        if (outcomes.shift() === "retry") throw new TypeError("temporary network fault");
        return { generation: calls };
      },
      onView: () => {},
      onError: () => {},
      onUnauthorized: () => { throw new Error("unexpected auth refusal"); },
      isHidden: () => false,
      setTimer: (_callback: () => void, delay: number) => { timerDelays.push(delay); return timerDelays.length as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => {},
    });
    poller.activate();
    const first = poller.refresh();
    await poller.refresh();
    expect(calls).toBe(1);
    firstResolve?.({ generation: 1 });
    await first;
    await poller.refresh();
    await poller.refresh();
    await poller.refresh();
    expect(timerDelays).toEqual([1_000, 2_000, 4_000, 1_000]);

    const hidden = createPlayerFacadePolling({
      readView: async () => { throw new Error("hidden poll should not start"); },
      onView: () => { throw new Error("unexpected hidden view"); },
      onError: () => { throw new Error("unexpected hidden error"); },
      onUnauthorized: () => { throw new Error("unexpected hidden auth"); },
      isHidden: () => true,
    });
    hidden.activate();
    await hidden.refresh();
  });
});
