const PARTY_META_KEYS = ['personality', 'backstory', 'currentGoal']
// One owner browser slot is shared by every ordinary mutation. Keep this
// closed list in sync with api.js so a persisted character/KP request remains
// visibly blocking after reload, while corrupt/unknown values never gain UI
// authority.
const ORDINARY_PENDING_KINDS = new Set(['text_action', 'luck_spend', 'party_member_create', 'character_patch', 'kp_message'])

function isOrdinaryGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function validText(value, maxLength) {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && Array.from(value).length <= maxLength
}

function normalizeMeta(value) {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) return null
  const keys = Object.getOwnPropertyNames(value)
  if (!keys.every((key) => PARTY_META_KEYS.includes(key))) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) return null
  const result = {}
  for (const key of PARTY_META_KEYS) {
    if (!Object.hasOwn(descriptors, key)) continue
    if (!validText(descriptors[key].value, 4000)) return null
    result[key] = descriptors[key].value
  }
  return result
}

/** An ordinary owner session is the only place the form may be rendered. */
export function ordinaryPartyMemberCreateVisible({ sessionKind, ordinaryGeneration } = {}) {
  return sessionKind === 'ordinary' && isOrdinaryGeneration(ordinaryGeneration)
}

/**
 * UI pending state is a reflection of the one durable browser slot, never a
 * promise made before `setItem` succeeds. The injected read keeps this rule
 * testable without reaching into the API module's private storage helpers.
 */
export function ordinaryPendingKindFromDurableStorage(readPendingKind) {
  const kind = readPendingKind()
  return ORDINARY_PENDING_KINDS.has(kind) ? kind : null
}

/**
 * Produce only the request the API helper needs. It intentionally has no
 * pcId: the durable server operation allocates the next party member itself.
 */
export function ordinaryPartyMemberCreateRequest({
  sessionKind,
  ordinaryGeneration,
  loading,
  terminal,
  pendingKind,
  name,
  archetype,
  meta,
} = {}) {
  if (!ordinaryPartyMemberCreateVisible({ sessionKind, ordinaryGeneration })
    || loading || terminal !== null && terminal !== undefined || pendingKind) return null
  if (!validText(name, 128) || !validText(archetype, 128)) return null
  const normalizedMeta = normalizeMeta(meta)
  if (meta !== undefined && normalizedMeta === null) return null
  return { name, archetype, ...(normalizedMeta && Object.keys(normalizedMeta).length ? { meta: normalizedMeta } : {}), expectedGeneration: ordinaryGeneration }
}

/** Injection keeps the UI admission gate testable without mounting Vue. */
export async function submitOrdinaryPartyMemberCreate(view, execute) {
  const request = ordinaryPartyMemberCreateRequest(view)
  if (!request) return { kind: 'not-submitted' }
  return { kind: 'submitted', request, result: await execute(request) }
}

/** Classify a shared-queue replay without falsely reporting a party success. */
export function ordinaryPartyMemberCreateOutcome(result) {
  if (result?.kind !== 'reconciled') return { kind: 'invalid' }
  if (result.pendingKind !== 'party_member_create') {
    return result.pendingRetained
      ? { kind: 'other-pending', pendingKind: result.pendingKind }
      : { kind: 'other-reconciled', pendingKind: result.pendingKind }
  }
  if (result.pendingRetained) return { kind: 'party-pending' }
  return result.receipt ? { kind: 'party-reconciled' } : { kind: 'party-not-confirmed' }
}
