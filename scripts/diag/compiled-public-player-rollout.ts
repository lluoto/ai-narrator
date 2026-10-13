/** Offline-first, public-only planning adapter. Transport authority and phase
 * admission remain with the caller; this module cannot inspect a session, IR,
 * catalog, snapshot, or witness. It is not wired into the live campaign yet. */
import { PlayerAgent, type ConfirmedPlayerTurn } from "../../src/agent/player-agent";
import type { LLMLike } from "../../src/llm/client";

export type PublicPlayerRoute = "player-view" | "player-intents" | "player-actions" | "player-followups";
type Phase = "player_decision" | "player_intent" | "narration" | "followup";
export type PublicPlayerPersona = Readonly<{
  name: string; occupation: string; personality: string; backstory: string; currentGoal: string;
  backgroundProfile?: Readonly<Record<"appearance" | "beliefs" | "significantPeople" | "meaningfulPlace" | "treasuredPossession" | "woundsAndScars" | "phobiasAndManias", string>>;
}>;
type PublicAction = { label: string; check?: { kind: "check"; difficulty: string } };
type PublicObservation = {
  scene: { name: string; description: string };
  knownClues: Array<{ name: string; revelation: string }>;
  contacts: Array<{ name: string }>;
  actions: PublicAction[];
  terminal: boolean;
  character?: { name: string; hp: number; maxHp: number };
  sanity?: { currentSAN: number; maxSAN: number; temporaryInsanity: boolean; indefiniteInsanity: boolean };
};
type CurrentView = {
  generation: number; observation: PublicObservation;
  choices: Array<{ choiceId: string; label: string }>;
  contacts: Array<{ name: string; contactToken: string }>;
  turn?: { generation: number; text: string };
};
type FailureCode = "no_match" | "ambiguous" | "conflict" | "unavailable" | "contract_invalid" | "insufficient_contact";
type Failure = { action: string; code: FailureCode };
type StopReason = "limits_reached" | "terminal" | "aborted" | "model_refused" | "no_progress" | "unavailable" | "contract_invalid";
export type PublicPlayerRolloutResult = {
  reason: StopReason;
  counters: { decisions: number; intents: number; actions: number; followups: number };
  confirmed: ConfirmedPlayerTurn[];
  failures: Failure[];
};
type RolloutOptions = {
  request(route: PublicPlayerRoute, body?: object): Promise<Response>;
  llm: LLMLike | null;
  isLlmEnabled(): boolean;
  persona: PublicPlayerPersona;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Limits can only narrow this slice's fixed 6-action / 2-question policy. */
  maxActions?: number;
  maxFollowups?: number;
  runPhase?<T>(phase: Phase, run: () => Promise<T>): Promise<T>;
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 8_000): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const generation = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const order = <T>(values: T[]): T[] => values.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);

function readPublicView(value: unknown): CurrentView | null {
  if (!record(value) || !generation(value.generation) || typeof value.terminal !== "boolean"
    || !Array.isArray(value.actions) || value.actions.length > 128 || !record(value.presentation)) return null;
  const presentation = value.presentation;
  if (!record(presentation.scene) || !text(presentation.scene.name, 1_000) || !text(presentation.scene.description)
    || !Array.isArray(presentation.clues) || presentation.clues.length > 128
    || (presentation.contacts !== undefined && (!Array.isArray(presentation.contacts) || presentation.contacts.length > 32))) return null;
  const actions: PublicAction[] = [];
  const choices: CurrentView["choices"] = [];
  for (const action of value.actions) {
    if (!record(action) || !text(action.choiceId, 256) || !text(action.label, 1_000)) return null;
    const projected: PublicAction = { label: action.label };
    if (action.check !== undefined) {
      if (!record(action.check) || action.check.kind !== "check" || !text(action.check.difficulty, 64)) return null;
      projected.check = { kind: "check", difficulty: action.check.difficulty };
    }
    actions.push(projected); choices.push({ choiceId: action.choiceId, label: action.label });
  }
  if (new Set(choices.map((action) => action.choiceId)).size !== choices.length) return null;
  const knownClues: PublicObservation["knownClues"] = [];
  for (const clue of presentation.clues) {
    if (!record(clue) || !text(clue.name, 1_000) || !text(clue.revelation)) return null;
    knownClues.push({ name: clue.name, revelation: clue.revelation });
  }
  const contacts: CurrentView["contacts"] = [];
  for (const contact of (presentation.contacts ?? []) as unknown[]) {
    if (!record(contact) || !text(contact.name, 1_000) || !text(contact.contactToken, 2_048)) return null;
    contacts.push({ name: contact.name, contactToken: contact.contactToken });
  }
  const observation: PublicObservation = {
    scene: { name: presentation.scene.name, description: presentation.scene.description },
    knownClues: order(knownClues), contacts: order(contacts.map(({ name }) => ({ name }))),
    // Equal generic labels are distinct choices; sorting must not deduplicate.
    actions: order(actions), terminal: value.terminal,
  };
  if (value.character !== undefined) {
    if (!record(value.character) || !text(value.character.name, 1_000) || !Number.isFinite(value.character.hp) || !Number.isFinite(value.character.maxHp)) return null;
    observation.character = { name: value.character.name, hp: value.character.hp as number, maxHp: value.character.maxHp as number };
  }
  if (value.sanity !== undefined) {
    if (!record(value.sanity) || !Number.isFinite(value.sanity.currentSAN) || !Number.isFinite(value.sanity.maxSAN)
      || typeof value.sanity.temporaryInsanity !== "boolean" || typeof value.sanity.indefiniteInsanity !== "boolean") return null;
    observation.sanity = { currentSAN: value.sanity.currentSAN as number, maxSAN: value.sanity.maxSAN as number,
      temporaryInsanity: value.sanity.temporaryInsanity, indefiniteInsanity: value.sanity.indefiniteInsanity };
  }
  if (JSON.stringify(observation).length > 16_000) return null;
  const turn = record(value.turn) && generation(value.turn.generation) && text(value.turn.text)
    ? { generation: value.turn.generation, text: value.turn.text } : undefined;
  return { generation: value.generation, observation, choices, contacts, ...(turn ? { turn } : {}) };
}

/** Deliberately does not return choice/contact tokens, generations or old turn text. */
export function projectCompiledPublicPlayerObservation(value: unknown): PublicObservation | null {
  return readPublicView(value)?.observation ?? null;
}

function capturePersona(input: PublicPlayerPersona): ConstructorParameters<typeof PlayerAgent>[0] | null {
  if (!record(input)) return null;
  const fields = ["name", "occupation", "personality", "backstory", "currentGoal"] as const;
  for (const field of fields) if (!text(input[field], 1_000)) return null;
  const own = { name: input.name, occupation: input.occupation, personality: input.personality, backstory: input.backstory, currentGoal: input.currentGoal };
  let backgroundProfile: PublicPlayerPersona["backgroundProfile"];
  if (input.backgroundProfile !== undefined) {
    const bp = input.backgroundProfile;
    if (!record(bp)) return null;
    const keys = ["appearance", "beliefs", "significantPeople", "meaningfulPlace", "treasuredPossession", "woundsAndScars", "phobiasAndManias"] as const;
    for (const key of keys) if (!text(bp[key], 1_000)) return null;
    backgroundProfile = Object.fromEntries(keys.map((key) => [key, bp[key]])) as PublicPlayerPersona["backgroundProfile"];
  }
  return { ...own, char: backgroundProfile ? { backgroundProfile } : {} } as ConstructorParameters<typeof PlayerAgent>[0];
}

function limit(value: number | undefined, cap: number): number | null {
  const chosen = value ?? cap;
  return Number.isSafeInteger(chosen) && chosen >= 0 && chosen <= cap ? chosen : null;
}
function normalized(action: string): string { return action.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(); }

function publicChanges(before: PublicObservation, after: PublicObservation): object {
  const known = new Set(before.knownClues.map((clue) => JSON.stringify(clue)));
  const newKnownClues = after.knownClues.filter((clue) => !known.has(JSON.stringify(clue)));
  return {
    ...(JSON.stringify(before.scene) !== JSON.stringify(after.scene) ? { scene: after.scene } : {}),
    ...(newKnownClues.length ? { newKnownClues } : {}),
    ...(JSON.stringify(before.character) !== JSON.stringify(after.character) ? { character: after.character } : {}),
    ...(JSON.stringify(before.sanity) !== JSON.stringify(after.sanity) ? { sanity: after.sanity } : {}),
    ...(before.terminal !== after.terminal ? { terminal: after.terminal } : {}),
  };
}

export async function runCompiledPublicPlayerRollout(options: RolloutOptions): Promise<PublicPlayerRolloutResult> {
  const counters = { decisions: 0, intents: 0, actions: 0, followups: 0 };
  const confirmed: ConfirmedPlayerTurn[] = [];
  const failures: Failure[] = [];
  const maxActions = limit(options.maxActions, 6), maxFollowups = limit(options.maxFollowups, 2);
  const persona = capturePersona(options.persona);
  // Fresh instance and captured persona per module: no caller-supplied agent/history.
  const agent = persona ? new PlayerAgent(persona, options.llm, { isLlmEnabled: options.isLlmEnabled }) : null;
  const finish = (reason: StopReason): PublicPlayerRolloutResult => ({ reason, counters: { ...counters }, confirmed: confirmed.map((turn) => ({ ...turn })), failures: failures.map((failure) => ({ ...failure })) });
  if (!agent || maxActions === null || maxFollowups === null) return finish("contract_invalid");
  const aborted = () => !!options.signal?.aborted;
  const phase = <T>(name: Phase, run: () => Promise<T>): Promise<T> => options.runPhase ? options.runPhase(name, run) : run();
  const request = async (route: PublicPlayerRoute, body?: object): Promise<{ status: number; body: unknown }> => {
    if (aborted()) return { status: 499, body: null };
    try {
      const response = await options.request(route, body);
      // Never parse an error body, even for diagnostics or next-plan feedback.
      return { status: response.status, body: response.status === 200 ? await response.json() : null };
    } catch { return { status: 503, body: null }; }
  };
  const refresh = async (): Promise<CurrentView | null> => {
    const response = await request("player-view");
    return response.status === 200 ? readPublicView(response.body) : null;
  };
  if (aborted()) return finish("aborted");
  let current = await refresh();
  if (!current) return finish(aborted() ? "aborted" : "unavailable");
  let previousPlan: { action: string; observation: string } | undefined;
  const feedback = (action: string, code: FailureCode) => { failures.push({ action, code }); };
  const decide = async (kind: "action" | "question") => {
    if (aborted()) return { status: "refused" as const, code: "aborted" as const };
    const observation = JSON.stringify(current!.observation);
    const prompt = [observation, "【本轮任务】", kind === "action"
      ? "提出一项可由公开信息理解的行动。通用出口不提供目的地；不明确时可观察、搜索或询问，不凭选项排列猜路。"
      : "向当前公开联系人提出一个自然问句；多联系人时在问句中明确公开姓名。",
    "【最近未获执行授权的计划及安全反馈】", JSON.stringify(failures.slice(-2))].join("\n");
    counters.decisions++;
    const decision = await phase("player_decision", () => agent.decideControlled(prompt, { signal: options.signal, timeoutMs: options.timeoutMs }));
    if (decision.status !== "decided") return decision;
    const action = normalized(decision.action);
    if (previousPlan?.action === action && previousPlan.observation === observation) return { status: "refused" as const, code: "no_progress" as const };
    previousPlan = { action, observation };
    return decision;
  };
  const refusedReason = (code: string): StopReason => code === "aborted" ? "aborted" : code === "no_progress" ? "no_progress" : "model_refused";

  for (let attempt = 0; attempt < maxActions; attempt++) {
    if (aborted()) return finish("aborted");
    if (current.observation.terminal) return finish("terminal");
    const decision = await decide("action");
    if (decision.status !== "decided") return finish(refusedReason(decision.code));
    if (aborted()) return finish("aborted");
    counters.intents++;
    const classified = await phase("player_intent", () => request("player-intents", { input: decision.action, expectedGeneration: current!.generation }));
    if (aborted()) return finish("aborted");
    if (classified.status !== 200) {
      feedback(decision.action, classified.status === 409 ? "conflict" : "unavailable");
      current = await refresh(); if (!current) return finish(aborted() ? "aborted" : "unavailable");
      continue;
    }
    const intent = classified.body;
    if (!record(intent) || intent.generation !== current.generation) return finish("contract_invalid");
    // Ambiguous and no_match are not execution authority. Do not choose any
    // alternative, including the first; exploration can still be replanned.
    if (intent.status === "ambiguous" || intent.status === "no_match") {
      feedback(decision.action, intent.status);
      current = await refresh(); if (!current) return finish(aborted() ? "aborted" : "unavailable");
      continue;
    }
    if (intent.status !== "selected" || !record(intent.action) || !text(intent.action.choiceId, 256)
      || typeof intent.topicBound !== "string" || !/^[a-f0-9]{64}$/.test(intent.topicBound)) return finish("contract_invalid");
    const selectedChoiceId = intent.action.choiceId;
    const selectedLabel = intent.action.label;
    if (!current.choices.some((choice) => choice.choiceId === selectedChoiceId && choice.label === selectedLabel)) return finish("contract_invalid");
    const expectedGeneration = current.generation;
    const before = current.observation;
    const actionId = `public_action_${crypto.randomUUID().replaceAll("-", "")}`;
    if (aborted()) return finish("aborted");
    counters.actions++;
    const committed = await phase("narration", () => request("player-actions", {
      choiceId: (intent.action as { choiceId: string }).choiceId, actionId, expectedGeneration, playerInput: decision.action, topicBound: intent.topicBound,
    }));
    if (committed.status !== 200) {
      // A lost response may follow a committed transaction. Do not classify
      // that uncertainty as "not executed" or submit a new action ID.
      if (committed.status !== 409) return finish(aborted() ? "aborted" : "unavailable");
      feedback(decision.action, "conflict");
      current = await refresh(); if (!current) return finish(aborted() ? "aborted" : "unavailable");
      continue;
    }
    const body = committed.body;
    if (!record(body) || !record(body.result) || body.result.status !== "committed") return finish("contract_invalid");
    const next = readPublicView(body.view);
    if (!next || next.generation !== expectedGeneration + 1) return finish("contract_invalid");
    const result = JSON.stringify({ committed: true, changes: publicChanges(before, next.observation),
      ...(next.turn?.generation === next.generation ? { narration: next.turn.text } : {}) });
    if (!agent.recordConfirmedTurn(decision.action, result)) return finish("contract_invalid");
    confirmed.push({ action: decision.action, result });
    current = next;
  }

  // A separate, narrower public-question phase uses only already released
  // contact tokens; it never fabricates history or repeats an old receipt.
  let head: { actionId: string; contactToken: string; generation: number } | undefined;
  for (let attempt = 0; attempt < maxFollowups; attempt++) {
    if (aborted()) return finish("aborted");
    if (current.observation.terminal) return finish("terminal");
    if (!current.contacts.length) break;
    const decision = await decide("question");
    if (decision.status !== "decided") return finish(refusedReason(decision.code));
    if (aborted()) return finish("aborted");
    const named = current.contacts.filter((contact) => decision.action.toLocaleLowerCase().includes(contact.name.toLocaleLowerCase()));
    const contact = named.length === 1 ? named[0] : named.length === 0 && current.contacts.length === 1 ? current.contacts[0] : undefined;
    if (!contact) { feedback(decision.action, "insufficient_contact"); continue; }
    const actionId = `public_question_${crypto.randomUUID().replaceAll("-", "")}`;
    const expectedGeneration = current.generation;
    const previousActionId = head?.contactToken === contact.contactToken && head.generation === expectedGeneration ? head.actionId : undefined;
    counters.followups++;
    const delivered = await phase("followup", () => request("player-followups", {
      contactToken: contact.contactToken, actionId, expectedGeneration, playerInput: decision.action, ...(previousActionId ? { previousActionId } : {}),
    }));
    if (delivered.status !== 200) {
      if (delivered.status !== 409) return finish(aborted() ? "aborted" : "unavailable");
      feedback(decision.action, "conflict");
      current = await refresh(); if (!current) return finish(aborted() ? "aborted" : "unavailable");
      continue;
    }
    const body = delivered.body;
    if (!record(body) || body.status !== "delivered" || !record(body.followup)
      || body.followup.schemaVersion !== "1.0.0" || !text(body.followup.text)) return finish("contract_invalid");
    const next = readPublicView(body.view);
    if (!next || next.generation !== expectedGeneration) return finish("contract_invalid");
    const result = JSON.stringify({ delivered: true, contact: contact.name, reply: body.followup.text });
    if (!agent.recordConfirmedTurn(decision.action, result)) return finish("contract_invalid");
    confirmed.push({ action: decision.action, result });
    current = next; head = { actionId, contactToken: contact.contactToken, generation: expectedGeneration };
  }
  return finish(current.observation.terminal ? "terminal" : "limits_reached");
}
