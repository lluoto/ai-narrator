import { expect, test } from "bun:test";
// @ts-ignore Browser controller deliberately has no declaration file.
import {
  ordinaryCharacterEditorVisible,
  ordinaryCharacterPatchOutcome,
  ordinaryCharacterPatchRequest,
  submitOrdinaryCharacterPatch,
} from "../../frontend/src/ordinary-character-patch-controller.js";

const SESSION_ID = "ordinary-character-ui";

const authority = (generation = 3, hp = 10) => ({
  sessionKind: "ordinary",
  ordinaryGeneration: generation,
  pcId: "p1",
  summary: { id: SESSION_ID, playerName: "Ada", archetype: "detective", ruleset: "cosmic-horror" },
  character: {
    name: "Ada", archetype: "detective", hp, maxHp: 10, luck: 42, creditRating: 31,
    skills: { stealth: 55 }, attributes: { dexterity: 61 },
  },
  inventory: ["flashlight"], weapons: ["revolver"], sanity: { currentSAN: 50, maxSAN: 99 },
});

async function loadOwnerCharacterHarness(input: {
  getCharacter: (sessionId: string) => Promise<Record<string, unknown>>;
  characterPatch: (sessionId: string, patch: Record<string, unknown>, options: { expectedGeneration: number }) => Promise<unknown>;
}) {
  const sfc = await Bun.file("frontend/src/App.vue").text();
  const match = /<script setup>\s*([\s\S]*?)<\/script>/.exec(sfc);
  if (!match) throw new Error("App script setup is required");
  const script = match[1]!.replace(/^import .*$/gm, "");
  const ref = <T>(value: T) => ({ value });
  const reactive = <T>(value: T) => value;
  const computed = <T>(getter: () => T) => ({ get value() { return getter(); } });
  const noop = () => {};
  class AudioStub { volume = 0; src = ""; play() { return Promise.resolve(); } pause() {} }
  const factory = new Function("deps", `
    const {
      ref, reactive, computed, watch, nextTick, Audio,
      createSession, sendSessionAction, retryPendingCompiledAction, retryPendingOrdinaryAction,
      pendingOrdinaryActionKind, compiledSessionGeneration, ordinarySessionGeneration, isAuthoritativeOrdinaryCharacter,
      getArchetypes, getSuggestions, getCompiledActions, getHistory, listSessions, getSession, getCharacter,
      luckSpend, partyMemberCreate, characterPatch,
      ordinaryLuckFromAuthoritativeState, ordinaryLuckFromCreateResponse, ordinaryLuckSpendOutcome,
      ordinaryLuckSpendRequest, ordinaryLuckSpendVisible, submitOrdinaryLuckSpend,
      ordinaryPartyMemberCreateOutcome, ordinaryPartyMemberCreateRequest, ordinaryPartyMemberCreateVisible,
      ordinaryPendingKindFromDurableStorage, submitOrdinaryPartyMemberCreate,
      ordinaryCharacterEditorVisible, ordinaryCharacterPatchOutcome, ordinaryCharacterPatchRequest, submitOrdinaryCharacterPatch,
      clearOwnerBearer, ownerFetch, setOwnerBearer
    } = deps;
    ${script}
    return {
      session, loading, ordinaryPendingKind, charEditorVisible, charEditorOpening,
      charEditorCharacter, charEditorSanity, charEditorStatus,
      openOrdinaryCharacterEditor, saveOrdinaryCharacterPatch, newGame
    };
  `) as (deps: Record<string, unknown>) => Record<string, any>;
  const ordinaryGeneration = (payload: any, kind?: string) => kind === "ordinary" && Number.isSafeInteger(payload?.ordinaryGeneration)
    ? payload.ordinaryGeneration : null;
  const strictAuthority = (payload: any, sessionId: string) => payload?.sessionKind === "ordinary"
    && payload?.summary?.id === sessionId && Number.isSafeInteger(payload?.ordinaryGeneration)
    && typeof payload?.pcId === "string" && !!payload?.character && Array.isArray(payload?.inventory)
    && Array.isArray(payload?.weapons) && Number.isSafeInteger(payload?.sanity?.currentSAN)
    && Number.isSafeInteger(payload?.sanity?.maxSAN);
  return factory({
    ref, reactive, computed, watch: noop, nextTick: async () => {}, Audio: AudioStub,
    createSession: async () => ({}), sendSessionAction: async () => ({}), retryPendingCompiledAction: async () => null,
    retryPendingOrdinaryAction: async () => null, pendingOrdinaryActionKind: () => null,
    compiledSessionGeneration: () => null, ordinarySessionGeneration: ordinaryGeneration, isAuthoritativeOrdinaryCharacter: strictAuthority,
    getArchetypes: async () => ({ archetypes: [] }), getSuggestions: async () => [], getCompiledActions: async () => ({}),
    getHistory: async () => ({ messages: [] }), listSessions: async () => [], getSession: async () => ({}),
    getCharacter: input.getCharacter, characterPatch: input.characterPatch,
    luckSpend: async () => ({}), partyMemberCreate: async () => ({}),
    ordinaryLuckFromAuthoritativeState: () => null, ordinaryLuckFromCreateResponse: () => null,
    ordinaryLuckSpendOutcome: () => ({ kind: "invalid" }), ordinaryLuckSpendRequest: () => null,
    ordinaryLuckSpendVisible: () => false, submitOrdinaryLuckSpend: async () => ({ kind: "not-submitted" }),
    ordinaryPartyMemberCreateOutcome: () => ({ kind: "invalid" }), ordinaryPartyMemberCreateRequest: () => null,
    ordinaryPartyMemberCreateVisible: () => false, ordinaryPendingKindFromDurableStorage: () => null,
    submitOrdinaryPartyMemberCreate: async () => ({ kind: "not-submitted" }),
    ordinaryCharacterEditorVisible, ordinaryCharacterPatchOutcome, ordinaryCharacterPatchRequest, submitOrdinaryCharacterPatch,
    clearOwnerBearer: noop, ownerFetch: async () => new Response(), setOwnerBearer: noop,
  });
}

test("ordinary character controller admits only an idle current ordinary owner state", async () => {
  const ready = { sessionKind: "ordinary", ordinaryGeneration: 3, loading: false, terminal: null, pendingKind: null, patch: { hp: 9 } };
  expect(ordinaryCharacterEditorVisible(ready)).toBe(true);
  expect(ordinaryCharacterEditorVisible({ ...ready, sessionKind: "compiled" })).toBe(false);
  expect(ordinaryCharacterPatchRequest(ready)).toEqual({ patch: { hp: 9 }, expectedGeneration: 3 });
  for (const invalid of [
    { ...ready, sessionKind: "compiled" }, { ...ready, loading: true },
    { ...ready, terminal: { kind: "death" } }, { ...ready, pendingKind: "text_action" }, { ...ready, patch: null },
  ]) expect(ordinaryCharacterPatchRequest(invalid)).toBeNull();
  await expect(submitOrdinaryCharacterPatch(ready, async (request: { patch: Record<string, unknown> }) => ({ request }))).resolves.toMatchObject({ kind: "submitted" });
  // A receipt without the owner GET cannot be displayed as a saved sheet.
  expect(ordinaryCharacterPatchOutcome({ kind: "reconciled", pendingKind: "character_patch", receipt: { hp: 9 } })).toEqual({ kind: "character-not-committed", character: undefined });
});

test("owner App fetches before first ordinary open and projects only confirmed authority", async () => {
  const getCalls: string[] = [];
  const patchCalls: Array<{ sessionId: string; patch: Record<string, unknown>; expectedGeneration: number }> = [];
  const app = await loadOwnerCharacterHarness({
    getCharacter: async sessionId => { getCalls.push(sessionId); return authority(); },
    characterPatch: async (sessionId, patch, options) => {
      patchCalls.push({ sessionId, patch, expectedGeneration: options.expectedGeneration });
      return { kind: "reconciled", pendingKind: "character_patch", committed: true, committedGeneration: 4, receipt: { ordinaryGeneration: 4 }, character: authority(4, 9), session: {
        sessionKind: "ordinary", ordinaryGeneration: 4, summary: authority(4, 9).summary,
        state: { party: [{ pcId: "p1", name: "Ada" }] },
      }, history: { messages: [] } };
    },
  });
  Object.assign(app.session, { id: SESSION_ID, sessionKind: "ordinary", ordinaryGeneration: 3, ruleset: "cosmic-horror", terminal: null, dead: false });
  await app.openOrdinaryCharacterEditor();
  expect(getCalls).toEqual([SESSION_ID]);
  expect(app.charEditorVisible.value).toBe(true);
  expect(app.charEditorCharacter.value).toMatchObject({ hp: 10, inventory: ["flashlight"], weapons: ["revolver"] });

  await app.saveOrdinaryCharacterPatch({ hp: 9, maxHp: 10, luck: 42, creditRating: 31, skills: { stealth: 55 }, attributes: { dexterity: 61 }, inventory: ["flashlight"], weapons: ["revolver"] });
  expect(patchCalls).toEqual([{ sessionId: SESSION_ID, expectedGeneration: 3, patch: {
    hp: 9, maxHp: 10, luck: 42, creditRating: 31, skills: { stealth: 55 }, attributes: { dexterity: 61 }, inventory: ["flashlight"], weapons: ["revolver"],
  } }]);
  expect(app.session.hp).toBe(9);
  expect(app.session.ordinaryGeneration).toBe(4);
  expect(app.charEditorCharacter.value.hp).toBe(9);
  expect(app.charEditorStatus.value).toContain("confirmed");
});

test("compiled and session-switch states cannot retain or open an ordinary character editor", async () => {
  let getCalls = 0;
  const app = await loadOwnerCharacterHarness({ getCharacter: async () => { getCalls++; return authority(); }, characterPatch: async () => ({}) });
  Object.assign(app.session, { id: SESSION_ID, sessionKind: "compiled", ordinaryGeneration: null, terminal: null, dead: false });
  await app.openOrdinaryCharacterEditor();
  expect(getCalls).toBe(0);
  expect(app.charEditorVisible.value).toBe(false);
  app.charEditorVisible.value = true;
  app.charEditorCharacter.value = authority().character;
  app.ordinaryPendingKind.value = "character_patch";
  app.newGame();
  expect(app.charEditorVisible.value).toBe(false);
  expect(app.charEditorCharacter.value).toBeNull();
  expect(app.ordinaryPendingKind.value).toBeNull();

  const owner = await Bun.file("frontend/src/App.vue").text();
  const player = await Bun.file("frontend/src/PlayerApp.vue").text();
  expect(owner).toContain('v-if="ordinaryCharacterEditorVisibleForSession"');
  expect(owner).toContain("await getCharacter(sessionId)");
  expect(owner).not.toContain("saveCharacterSheet");
  expect(player).not.toContain("CharacterEditor");
  expect(player).not.toContain("characterPatch(");
});
