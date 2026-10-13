import {
  acknowledgeCompiledDurableSessionSnapshot,
  commitCompiledDurableAction,
  createCompiledDurableSessionSnapshot,
  readCompiledDurableSessionAccessBinding,
  resolveCompiledDurablePlayerChoice,
  type CompiledActionCommitResult,
  type GameSession,
} from "../../api/game-session";
import type { CompiledSessionAccessBinding, CompiledSessionSnapshot } from "../../api/compiled-session-snapshot";

/**
 * Test-only analogue of the process-private server authority. Every factory
 * must create one explicitly and pass `runtimeDependencies` to each durable
 * source or rehydrated target; this module deliberately has no shared token.
 */
export interface CompiledDurableTestHost {
  readonly capability: object;
  readonly runtimeDependencies: { readonly compiledDurableHostCapability: object };
  /** Present for factory-backed fixtures; the unbound form throws if misused. */
  readonly session: GameSession;
  access(session: GameSession): CompiledSessionAccessBinding | null;
  access(): CompiledSessionAccessBinding | null;
  snapshot(session: GameSession): CompiledSessionSnapshot;
  snapshot(): CompiledSessionSnapshot;
  createSnapshot(): CompiledSessionSnapshot;
  acknowledge(session: GameSession, snapshot: CompiledSessionSnapshot): void;
  acknowledge(snapshot: CompiledSessionSnapshot): void;
  resolvePlayerChoice(session: GameSession, choiceId: string, generation: number): string | null;
  resolvePlayerChoice(choiceId: string, generation: number): string | null;
  commit(
    session: GameSession,
    input: string,
    actionId: string,
    generation: number,
    persist: (snapshot: CompiledSessionSnapshot) => void,
  ): CompiledActionCommitResult;
  commit(
    input: string,
    actionId: string,
    generation: number,
    persist: (snapshot: CompiledSessionSnapshot) => void,
  ): CompiledActionCommitResult;
}

export function createCompiledDurableTestHost(): CompiledDurableTestHost;
export function createCompiledDurableTestHost(
  createSession: (runtimeDependencies: { readonly compiledDurableHostCapability: object }) => GameSession,
): CompiledDurableTestHost;
export function createCompiledDurableTestHost(
  createSession?: (runtimeDependencies: { readonly compiledDurableHostCapability: object }) => GameSession,
): CompiledDurableTestHost {
  const capability = Object.freeze(Object.create(null)) as object;
  const runtimeDependencies = Object.freeze({ compiledDurableHostCapability: capability });
  const access = (session: GameSession) => readCompiledDurableSessionAccessBinding(session, capability);
  const snapshot = (session: GameSession) => createCompiledDurableSessionSnapshot(session, capability);
  const acknowledge = (session: GameSession, value: CompiledSessionSnapshot) => acknowledgeCompiledDurableSessionSnapshot(session, capability, value);
  const resolvePlayerChoice = (session: GameSession, choiceId: string, generation: number) =>
    resolveCompiledDurablePlayerChoice(session, capability, choiceId, generation);
  const commit = (
    session: GameSession,
    input: string,
    actionId: string,
    generation: number,
    persist: (value: CompiledSessionSnapshot) => void,
  ) => commitCompiledDurableAction(session, capability, input, actionId, generation, persist);
  const boundSession = createSession?.(runtimeDependencies);
  const requireBoundSession = (): GameSession => {
    if (!boundSession) throw new Error("this compiled durable test host is not bound to a session");
    return boundSession;
  };
  return Object.freeze({
    capability,
    runtimeDependencies,
    get session() { return requireBoundSession(); },
    access: (session?: GameSession) => access(session ?? requireBoundSession()),
    snapshot: (session?: GameSession) => snapshot(session ?? requireBoundSession()),
    createSnapshot: () => snapshot(requireBoundSession()),
    acknowledge: (sessionOrSnapshot: GameSession | CompiledSessionSnapshot, maybeSnapshot?: CompiledSessionSnapshot) =>
      maybeSnapshot
        ? acknowledge(sessionOrSnapshot as GameSession, maybeSnapshot)
        : acknowledge(requireBoundSession(), sessionOrSnapshot as CompiledSessionSnapshot),
    resolvePlayerChoice: (sessionOrChoiceId: GameSession | string, choiceIdOrGeneration: string | number, maybeGeneration?: number) =>
      typeof sessionOrChoiceId === "string"
        ? resolvePlayerChoice(requireBoundSession(), sessionOrChoiceId, choiceIdOrGeneration as number)
        : resolvePlayerChoice(sessionOrChoiceId, choiceIdOrGeneration as string, maybeGeneration!),
    commit: (
      sessionOrInput: GameSession | string,
      inputOrActionId: string,
      actionIdOrGeneration: string | number,
      generationOrPersist: number | ((snapshot: CompiledSessionSnapshot) => void),
      maybePersist?: (snapshot: CompiledSessionSnapshot) => void,
    ) => typeof sessionOrInput === "string"
      ? commit(requireBoundSession(), sessionOrInput, inputOrActionId, actionIdOrGeneration as number, generationOrPersist as (snapshot: CompiledSessionSnapshot) => void)
      : commit(sessionOrInput, inputOrActionId, actionIdOrGeneration as string, generationOrPersist as number, maybePersist!),
  }) as CompiledDurableTestHost;
}
