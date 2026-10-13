const ORDINARY_LUCK_RULESET = 'cosmic-horror'

export function isCanonicalOrdinaryLuck(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 99
}

function isOrdinaryGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function amountFromInput(value) {
  if (typeof value === 'number') return value
  if (typeof value !== 'string' || !value.trim()) return Number.NaN
  return Number(value)
}

/** The create endpoint's character summary is the only creation-time Luck source. */
export function ordinaryLuckFromCreateResponse(payload) {
  const luck = payload?.character?.luck
  return isCanonicalOrdinaryLuck(luck) ? luck : null
}

/** GET/reconciliation/action state owns Luck after a session already exists. */
export function ordinaryLuckFromAuthoritativeState(payload) {
  const luck = payload?.state?.player?.luck
  return isCanonicalOrdinaryLuck(luck) ? luck : null
}

/** A validated durable Luck receipt is authoritative for its exact successor. */
export function ordinaryLuckFromReceipt(payload) {
  const luck = payload?.luck
  return payload?.sessionKind === 'ordinary' && isCanonicalOrdinaryLuck(luck) ? luck : null
}

export function ordinaryLuckSpendVisible({ sessionKind, ruleset, ordinaryGeneration, luck } = {}) {
  return sessionKind === 'ordinary'
    && ruleset === ORDINARY_LUCK_RULESET
    && isOrdinaryGeneration(ordinaryGeneration)
    && isCanonicalOrdinaryLuck(luck)
}

/**
 * Return the exact request App may give to the existing durable helper, or
 * null when any UI precondition is not proven. This keeps hidden/disabled
 * controls from accidentally posting a guessed Luck or old generation.
 */
export function ordinaryLuckSpendRequest({
  sessionKind,
  ruleset,
  ordinaryGeneration,
  luck,
  loading,
  terminal,
  pendingKind,
  amount,
} = {}) {
  if (!ordinaryLuckSpendVisible({ sessionKind, ruleset, ordinaryGeneration, luck })
    || loading || terminal !== null && terminal !== undefined || pendingKind || luck === 0) return null
  const parsedAmount = amountFromInput(amount)
  if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0 || parsedAmount > luck) return null
  return { amount: parsedAmount, expectedGeneration: ordinaryGeneration }
}

/** A tiny injection seam makes the UI gate executable without a browser or Vue. */
export async function submitOrdinaryLuckSpend(view, execute) {
  const request = ordinaryLuckSpendRequest(view)
  if (!request) return { kind: 'not-submitted' }
  return { kind: 'submitted', request, result: await execute(request) }
}

/**
 * Reconciled pending work has one queue for text and Luck. Callers must never
 * narrate a text-action recovery as a Luck spend; a retained request is also
 * deliberately not a success acknowledgement.
 */
export function ordinaryLuckSpendOutcome(result) {
  if (result?.kind === 'reconciled') {
    const luck = ordinaryLuckFromAuthoritativeState(result.session)
    const ordinaryGeneration = result?.session?.sessionKind === 'ordinary'
      && isOrdinaryGeneration(result.session?.ordinaryGeneration)
      ? result.session.ordinaryGeneration
      : null
    if (luck === null || ordinaryGeneration === null) return { kind: 'invalid' }
    if (result.pendingKind === 'text_action') {
      return result.pendingRetained
        ? { kind: 'text-pending', luck, ordinaryGeneration }
        : { kind: 'text-reconciled', luck, ordinaryGeneration }
    }
    if (result.pendingKind !== 'luck_spend') return { kind: 'invalid' }
    if (result.pendingRetained) return { kind: 'luck-pending', luck, ordinaryGeneration }
    return result.receipt
      ? { kind: 'luck-reconciled', luck, ordinaryGeneration }
      : { kind: 'luck-not-confirmed', luck, ordinaryGeneration }
  }
  const luck = ordinaryLuckFromReceipt(result)
  const ordinaryGeneration = result?.sessionKind === 'ordinary' && isOrdinaryGeneration(result?.ordinaryGeneration)
    ? result.ordinaryGeneration
    : null
  return luck === null || ordinaryGeneration === null
    ? { kind: 'invalid' }
    : { kind: 'luck-receipt', luck, ordinaryGeneration }
}
