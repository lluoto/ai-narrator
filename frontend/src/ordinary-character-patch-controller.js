const ORDINARY_CHARACTER_PENDING_KIND = 'character_patch'

function ordinaryGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/** The owner App is the only renderer; compiled/public surfaces never opt in. */
export function ordinaryCharacterEditorVisible({ sessionKind, ordinaryGeneration: generation } = {}) {
  return sessionKind === 'ordinary' && ordinaryGeneration(generation)
}

/**
 * The editor is admitted only with a current ordinary generation and an empty
 * shared durable queue. API-side validation owns the closed deep patch shape;
 * this layer prevents a disabled/stale screen from starting a request.
 */
export function ordinaryCharacterPatchRequest({
  sessionKind,
  ordinaryGeneration: generation,
  loading,
  terminal,
  pendingKind,
  patch,
} = {}) {
  if (!ordinaryCharacterEditorVisible({ sessionKind, ordinaryGeneration: generation })
    || loading || terminal !== null && terminal !== undefined || pendingKind
    || !patch || typeof patch !== 'object' || Array.isArray(patch)) return null
  return { patch, expectedGeneration: generation }
}

export async function submitOrdinaryCharacterPatch(view, execute) {
  const request = ordinaryCharacterPatchRequest(view)
  if (!request) return { kind: 'not-submitted' }
  return { kind: 'submitted', request, result: await execute(request) }
}

/** A POST receipt alone is never a sheet confirmation: require the GET view. */
export function ordinaryCharacterPatchOutcome(result) {
  if (result?.kind !== 'reconciled') return { kind: 'invalid' }
  if (result.pendingKind !== ORDINARY_CHARACTER_PENDING_KIND) {
    return result.pendingRetained
      ? { kind: 'other-pending', pendingKind: result.pendingKind }
      : { kind: 'other-reconciled', pendingKind: result.pendingKind }
  }
  if (result.pendingRetained) return { kind: 'character-pending' }
  // A deterministic refusal can retire the retry record after refreshing the
  // pre-existing authority. It is not a successful character save.
  if (!result.committed || !result.receipt
    || !ordinaryGeneration(result.committedGeneration)
    || result.receipt.ordinaryGeneration !== result.committedGeneration) {
    return { kind: 'character-not-committed', character: result.character }
  }
  const character = result.character
  if (character?.sessionKind !== 'ordinary' || !ordinaryGeneration(character?.ordinaryGeneration)
    || !character?.character || !character?.summary?.id) return { kind: 'character-not-confirmed' }
  return { kind: 'character-confirmed', character, ordinaryGeneration: character.ordinaryGeneration }
}
