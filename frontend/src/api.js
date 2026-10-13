import { ownerFetch } from './owner-auth.js'

const BASE = '/api'
const COMPILED_PENDING_VERSION = 1
const COMPILED_PENDING_PREFIX = `aitrpg.compiled-action.pending.v${COMPILED_PENDING_VERSION}:`
const COMPILED_PENDING_KEYS = ['version', 'sessionId', 'mechanismId', 'pcId', 'actionId', 'expectedGeneration']
const ORDINARY_PENDING_VERSION = 1
const ORDINARY_PENDING_PREFIX = `aitrpg.ordinary-action.pending.v${ORDINARY_PENDING_VERSION}:`
const ORDINARY_PENDING_KEYS = ['version', 'sessionId', 'input', 'actionId', 'expectedGeneration']
const ORDINARY_LUCK_SPEND_PENDING_KIND = 'luck_spend'
const ORDINARY_LUCK_SPEND_PENDING_KEYS = ['version', 'kind', 'sessionId', 'amount', 'actionId', 'expectedGeneration']
const ORDINARY_PARTY_MEMBER_CREATE_PENDING_KIND = 'party_member_create'
const ORDINARY_PARTY_MEMBER_CREATE_PENDING_KEYS = ['version', 'kind', 'sessionId', 'name', 'archetype', 'actionId', 'expectedGeneration']
const ORDINARY_PARTY_MEMBER_CREATE_PENDING_KEYS_WITH_META = ['version', 'kind', 'sessionId', 'name', 'archetype', 'meta', 'actionId', 'expectedGeneration']
const ORDINARY_PARTY_MEMBER_META_KEYS = ['personality', 'backstory', 'currentGoal']
const ORDINARY_CHARACTER_PATCH_PENDING_KIND = 'character_patch'
const ORDINARY_CHARACTER_PATCH_PENDING_KEYS = ['version', 'kind', 'sessionId', 'patch', 'actionId', 'expectedGeneration']
const ORDINARY_KP_MESSAGE_PENDING_KIND = 'kp_message'
const ORDINARY_KP_MESSAGE_AUTHORITY_UNCONFIRMED = 'ordinary_kp_message_authority_unconfirmed'
const ORDINARY_KP_MESSAGE_PENDING_KEYS = ['version', 'kind', 'sessionId', 'speaker', 'content', 'type', 'actionId', 'expectedGeneration']
const ORDINARY_CHARACTER_PATCH_KEYS = ['hp', 'maxHp', 'skills', 'inventory', 'weapons', 'luck', 'creditRating', 'attributes']
const ORDINARY_CHARACTER_ATTRIBUTE_KEYS = ['strength', 'constitution', 'size', 'dexterity', 'appearance', 'intelligence', 'power', 'education']
const ORDINARY_CHARACTER_RESERVED_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const SAFE_COMPILED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
// UUIDs carry enough entropy to make a browser retry key safely idempotent.
const HIGH_ENTROPY_ACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ORDINARY_KP_DEFAULT_SPEAKER = '守秘人'
const ORDINARY_KP_MESSAGE_TYPES = new Set(['system', 'narration'])

async function jsonOrThrow(res, fallback) {
  let data
  try {
    data = await res.json()
  } catch {
    // A request may already have committed even if its response body was lost.
    // Let the retry queue retain its exact idempotency key in that case.
    const error = new Error(fallback)
    error.status = res.status
    error.responseReadFailed = true
    throw error
  }
  if (res.ok) return data
  const nestedError = isRecord(data?.error)
    ? (typeof data.error.message === 'string' ? data.error.message : data.error.code)
    : data?.error
  const message = typeof nestedError === 'string'
    ? nestedError
    : typeof data?.code === 'string'
      ? data.code
      : fallback
  const error = new Error(message)
  error.status = res.status
  error.data = data
  throw error
}

/**
 * A compiled session always has a non-negative generation; zero is valid.
 * `sessionKind` lets callers reject an ordinary payload without inferring its
 * type from a bare number. Omitting it remains a compatibility path for old
 * compiled endpoints that predate the explicit session-kind response field.
 */
export function compiledSessionGeneration(payload, sessionKind) {
  const kind = sessionKind ?? payload?.sessionKind
  if (kind === 'ordinary' || (kind !== undefined && kind !== 'compiled')) return null
  if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'ordinaryGeneration')
    || Object.prototype.hasOwnProperty.call(payload?.summary ?? {}, 'ordinaryGeneration')) return null
  const generation = payload?.generation ?? payload?.summary?.generation
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : null
}

/** Ordinary sessions have their own durable generation namespace. */
export function ordinarySessionGeneration(payload, sessionKind) {
  const kind = sessionKind ?? payload?.sessionKind
  if (kind === 'compiled' || (kind !== undefined && kind !== 'ordinary')) return null
  const generation = payload?.ordinaryGeneration ?? payload?.summary?.ordinaryGeneration
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : null
}

function secureActionId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  throw new Error('浏览器不支持安全的编译动作 ID')
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The party endpoint accepts a deliberately closed JSON shape.  Do not read
 * values from a caller object until we have rejected accessors, symbols, and
 * non-plain prototypes: a durable retry record must never retain caller
 * aliases or invoke a getter again when it is replayed.
 */
function closedPlainDataRecord(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return null
  const names = Object.getOwnPropertyNames(value)
  if (!names.every((key) => allowedKeys.includes(key)) || !requiredKeys.every((key) => names.includes(key))) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))) return null
  return descriptors
}

/**
 * Skills and attributes deliberately accept caller-defined (or, for
 * attributes, allowlisted) keys, but still need the same no-getter/no-symbol
 * deep-copy boundary as closed request objects. Keep this separate from the
 * closed-key helper above: dynamic tables must not make any other wire shape
 * more permissive.
 */
function plainDataTable(value, maximumKeys) {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return null
  const names = Object.getOwnPropertyNames(value)
  if (names.length > maximumKeys) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))) return null
  return descriptors
}

function validPartyMemberText(value, maxLength) {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && Array.from(value).length <= maxLength
}

/** Build a fresh, canonical JSON value for the party durable record. */
function normalizePartyMemberMeta(value) {
  if (value === undefined) return null
  const descriptors = closedPlainDataRecord(value, ORDINARY_PARTY_MEMBER_META_KEYS, [])
  if (!descriptors) return null
  const normalized = {}
  for (const key of ORDINARY_PARTY_MEMBER_META_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) continue
    const text = descriptors[key].value
    if (!validPartyMemberText(text, 4000)) return null
    normalized[key] = text
  }
  // `{ meta: {} }` is equivalent to omitting optional HTTP metadata.  Keep
  // the public input ergonomic, but canonicalize the durable record by
  // dropping the empty object entirely.
  return normalized
}

/**
 * The public helper exposes `meta`, while the server receives its three
 * sanctioned fields at the top level.  Returning a new object establishes a
 * real deep-copy boundary before localStorage and before fetch.
 */
function normalizePartyMemberCreateInput(input) {
  const descriptors = closedPlainDataRecord(input, ['name', 'archetype', 'meta'], ['name', 'archetype'])
  if (!descriptors) return null
  const name = descriptors.name.value
  const archetype = descriptors.archetype.value
  if (!validPartyMemberText(name, 128) || !validPartyMemberText(archetype, 128)) return null
  const hasMeta = Object.prototype.hasOwnProperty.call(descriptors, 'meta')
  const meta = hasMeta ? normalizePartyMemberMeta(descriptors.meta.value) : null
  if (hasMeta && (descriptors.meta.value === undefined || meta === null)) return null
  return { name, archetype, ...(meta && Object.keys(meta).length ? { meta } : {}) }
}

function isSafeIntegerIn(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

/**
 * Accept exactly the durable ordinary character contract and produce a deep,
 * JSON-only copy before it can enter the one browser retry slot. The server
 * repeats this validation; doing it here prevents an accessor/prototype or a
 * later caller mutation from changing what a reload replays.
 */
function normalizeOrdinaryCharacterPatch(input) {
  const descriptors = closedPlainDataRecord(input, ORDINARY_CHARACTER_PATCH_KEYS, [])
  if (!descriptors || Object.keys(descriptors).length === 0) return null
  const patch = {}
  for (const key of ['hp', 'maxHp']) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) continue
    const value = descriptors[key].value
    if (!isSafeIntegerIn(value, key === 'hp' ? 0 : 1, 999)) return null
    patch[key] = value
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'hp')
    && Object.prototype.hasOwnProperty.call(patch, 'maxHp')
    && patch.hp > patch.maxHp) return null
  for (const key of ['luck', 'creditRating']) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) continue
    const value = descriptors[key].value
    if (!isSafeIntegerIn(value, 0, 99)) return null
    patch[key] = value
  }
  for (const key of ['skills', 'attributes']) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) continue
    const record = plainDataTable(descriptors[key].value, 256)
    if (!record) return null
    const normalized = {}
    for (const [name, descriptor] of Object.entries(record)) {
      if (!name || ORDINARY_CHARACTER_RESERVED_RECORD_KEYS.has(name) || Array.from(name).length > 128
        || key === 'attributes' && !ORDINARY_CHARACTER_ATTRIBUTE_KEYS.includes(name)
        || !isSafeIntegerIn(descriptor.value, key === 'skills' ? 0 : 1, 100)) return null
      Object.defineProperty(normalized, name, { value: descriptor.value, enumerable: true, configurable: true, writable: true })
    }
    patch[key] = normalized
  }
  for (const key of ['inventory', 'weapons']) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) continue
    const source = descriptors[key].value
    if (!Array.isArray(source) || Object.getPrototypeOf(source) !== Array.prototype
      || Object.getOwnPropertySymbols(source).length || source.length > 4096) return null
    const sourceDescriptors = Object.getOwnPropertyDescriptors(source)
    const names = Object.getOwnPropertyNames(source)
    if (names.length !== source.length + 1 || !Object.prototype.hasOwnProperty.call(sourceDescriptors, 'length')) return null
    const normalized = []
    for (let index = 0; index < source.length; index++) {
      const descriptor = sourceDescriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || typeof descriptor.value !== 'string' || Array.from(descriptor.value).length > 512) return null
      normalized.push(descriptor.value)
    }
    patch[key] = normalized
  }
  return Object.keys(patch).length ? patch : null
}

function isSafeCompiledIdentifier(value) {
  return typeof value === 'string' && SAFE_COMPILED_IDENTIFIER.test(value)
}

function isHighEntropyActionId(value) {
  return typeof value === 'string' && HIGH_ENTROPY_ACTION_ID.test(value)
}

function isStorageLike(value) {
  return !!value
    && typeof value.getItem === 'function'
    && typeof value.setItem === 'function'
    && typeof value.removeItem === 'function'
}

function defaultStorage() {
  try {
    return isStorageLike(globalThis.localStorage) ? globalThis.localStorage : null
  } catch {
    // Privacy modes can deny localStorage access. Without durable storage we
    // keep the legacy direct behavior for non-browser consumers, but never
    // clear an already persisted request before its explicit response.
    return null
  }
}

function retryStorage(storage) {
  if (storage === undefined) {
    const browserStorage = defaultStorage()
    if (!browserStorage && typeof globalThis.window !== 'undefined') throw new Error('编译动作重试存储不可用')
    return browserStorage
  }
  if (!isStorageLike(storage)) throw new Error('编译动作重试存储不可用')
  return storage
}

function ordinaryRetryStorage(storage) {
  if (storage === undefined) {
    const browserStorage = defaultStorage()
    // Ordinary actions have no safe non-durable fallback: a response loss
    // after a POST would otherwise turn one player action into a fresh action.
    if (!browserStorage) throw new Error('ordinary action retry storage is unavailable')
    return browserStorage
  }
  if (!isStorageLike(storage)) throw new Error('ordinary action retry storage is unavailable')
  return storage
}

export function compiledActionPendingStorageKey(sessionId) {
  if (!isSafeCompiledIdentifier(sessionId)) throw new Error('编译会话 ID 无效')
  return `${COMPILED_PENDING_PREFIX}${encodeURIComponent(sessionId)}`
}

function validPendingRequest(value, sessionId) {
  if (!isRecord(value)
    || Object.keys(value).length !== COMPILED_PENDING_KEYS.length
    || !COMPILED_PENDING_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return false
  return value.version === COMPILED_PENDING_VERSION
    && value.sessionId === sessionId
    && isSafeCompiledIdentifier(value.sessionId)
    && isSafeCompiledIdentifier(value.mechanismId)
    && isSafeCompiledIdentifier(value.pcId)
    && isHighEntropyActionId(value.actionId)
    && Number.isSafeInteger(value.expectedGeneration)
    && value.expectedGeneration >= 0
}

function removePending(storage, key) {
  try {
    storage.removeItem(key)
  } catch {
    // A successful server result remains safe to replay with the same action
    // ID if browser quota/privacy policy prevents this best-effort cleanup.
  }
}

function readPending(sessionId, storage) {
  if (!storage) return null
  const key = compiledActionPendingStorageKey(sessionId)
  let raw
  try {
    raw = storage.getItem(key)
  } catch {
    throw new Error('无法读取编译动作重试请求')
  }
  if (raw === null) return null
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    removePending(storage, key)
    return null
  }
  if (!validPendingRequest(value, sessionId)) {
    removePending(storage, key)
    return null
  }
  return value
}

function savePending(request, storage) {
  if (!storage) return
  if (!validPendingRequest(request, request.sessionId)) throw new Error('编译动作重试请求无效')
  try {
    storage.setItem(compiledActionPendingStorageKey(request.sessionId), JSON.stringify(request))
  } catch {
    // Do not send a selected compiled action if its idempotency request could
    // not first be durably recorded in the browser.
    throw new Error('无法保存编译动作重试请求')
  }
}

function catalogStillAuthorizes(request, catalog) {
  return isRecord(catalog)
    && catalog.generation === request.expectedGeneration
    && Array.isArray(catalog.actions)
    && catalog.actions.some((action) => isRecord(action) && action.mechanismId === request.mechanismId)
}

function pendingNoLongerCurrent(storage, request, catalog) {
  removePending(storage, compiledActionPendingStorageKey(request.sessionId))
  const error = new Error('待重试的编译动作已不再是当前可执行动作')
  error.status = 409
  error.data = catalog
  error.pendingDiscarded = true
  return error
}

async function reconcileDiscardedPending(storage, request, catalog) {
  try {
    // A generation/catalog mismatch can mean the original POST committed but
    // its response was lost. It must never be replayed; instead give the app
    // a single authoritative snapshot to replace its stale visible state.
    const session = await getSession(request.sessionId)
    removePending(storage, compiledActionPendingStorageKey(request.sessionId))
    return { kind: 'reconciled', catalog, session }
  } catch (error) {
    // The stale request is still unsafe to replay, but retaining it lets a
    // later refresh retry reconciliation without ever posting the mechanism.
    error.pendingReconciliation = true
    error.reconcileCatalog = catalog
    throw error
  }
}

async function reconcilePossiblyCommittedFailure(storage, request, failure) {
  try {
    // `compiled_unavailable` can be emitted after snapshot persistence but
    // before the server installs its replacement object. Never discard its
    // idempotency record on the status code alone: first obtain the server's
    // authoritative session view, then retire the unsafe retry request.
    const session = await getSession(request.sessionId)
    removePending(storage, compiledActionPendingStorageKey(request.sessionId))
    return { kind: 'reconciled', catalog: null, session }
  } catch {
    // No authoritative answer means the outcome is still unknown, so preserve
    // the pending request rather than converting a possible commit to a loss.
    throw failure
  }
}

function explicitCompiledRefusal(error) {
  if (error?.responseReadFailed) return false
  const status = error?.status
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) return true
  const code = error?.data?.code
  return ['compiled_terminal', 'compiled_action_unavailable', 'compiled_persistence_failed', 'compiled_execution_failed']
    .includes(code)
}

async function postPendingCompiledAction(request, storage, retried) {
  try {
    const data = await executeCompiledAction(request.sessionId, request)
    // Explicitly successful JSON response only: a transport/read failure above
    // leaves this record intact for an idempotent retry.
    if (storage) removePending(storage, compiledActionPendingStorageKey(request.sessionId))
    return {
      kind: 'executed',
      ...(retried ? { retried: true } : {}),
      resolution: { status: 'selected', mechanismId: request.mechanismId, generation: request.expectedGeneration },
      data,
    }
  } catch (error) {
    if (storage && error?.data?.code === 'compiled_unavailable') {
      return reconcilePossiblyCommittedFailure(storage, request, error)
    }
    if (storage && explicitCompiledRefusal(error)) {
      removePending(storage, compiledActionPendingStorageKey(request.sessionId))
      error.pendingCleared = true
    }
    throw error
  }
}

/**
 * Recover exactly one durable browser request. It validates the current
 * server-owned executable catalog before reusing a stored mechanism, so local
 * storage can never grant a mechanism permission of its own.
 */
export async function retryPendingCompiledAction(sessionId, { pcId = 'p1', storage } = {}) {
  const durableStorage = retryStorage(storage)
  const request = readPending(sessionId, durableStorage)
  if (!request) return null
  if (request.pcId !== pcId) throw pendingNoLongerCurrent(durableStorage, request, { generation: null, actions: [] })
  const catalog = await getCompiledActions(sessionId, request.pcId)
  if (!catalogStillAuthorizes(request, catalog)) return reconcileDiscardedPending(durableStorage, request, catalog)
  return postPendingCompiledAction(request, durableStorage, true)
}

export function ordinaryActionPendingStorageKey(sessionId) {
  if (!isSafeCompiledIdentifier(sessionId)) throw new Error('ordinary session ID is invalid')
  return `${ORDINARY_PENDING_PREFIX}${encodeURIComponent(sessionId)}`
}

function validOrdinaryTextPendingRequest(value, sessionId) {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  const expectedKeys = Object.prototype.hasOwnProperty.call(value, 'pcId')
    ? [...ORDINARY_PENDING_KEYS, 'pcId']
    : ORDINARY_PENDING_KEYS
  if (keys.length !== expectedKeys.length
    || !expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return false
  return value.version === ORDINARY_PENDING_VERSION
    && value.sessionId === sessionId
    && isSafeCompiledIdentifier(value.sessionId)
    && typeof value.input === 'string'
    && value.input.length > 0
    && value.input.trim() === value.input
    && value.input.length <= 8192
    && (!Object.prototype.hasOwnProperty.call(value, 'pcId') || isSafeCompiledIdentifier(value.pcId))
    && isHighEntropyActionId(value.actionId)
    && Number.isSafeInteger(value.expectedGeneration)
    && value.expectedGeneration >= 0
}

function validOrdinaryLuckSpendPendingRequest(value, sessionId) {
  return isRecord(value)
    && Object.keys(value).length === ORDINARY_LUCK_SPEND_PENDING_KEYS.length
    && ORDINARY_LUCK_SPEND_PENDING_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && value.version === ORDINARY_PENDING_VERSION
    && value.kind === ORDINARY_LUCK_SPEND_PENDING_KIND
    && value.sessionId === sessionId
    && isSafeCompiledIdentifier(value.sessionId)
    && Number.isSafeInteger(value.amount)
    && value.amount > 0
    && isHighEntropyActionId(value.actionId)
    && Number.isSafeInteger(value.expectedGeneration)
    && value.expectedGeneration >= 0
}

function validOrdinaryPartyMemberCreatePendingRequest(value, sessionId) {
  const hasMeta = Object.prototype.hasOwnProperty.call(value ?? {}, 'meta')
  const descriptors = closedPlainDataRecord(
    value,
    hasMeta ? ORDINARY_PARTY_MEMBER_CREATE_PENDING_KEYS_WITH_META : ORDINARY_PARTY_MEMBER_CREATE_PENDING_KEYS,
  )
  if (!descriptors) return false
  const meta = hasMeta ? normalizePartyMemberMeta(descriptors.meta.value) : null
  return descriptors.version.value === ORDINARY_PENDING_VERSION
    && descriptors.kind.value === ORDINARY_PARTY_MEMBER_CREATE_PENDING_KIND
    && descriptors.sessionId.value === sessionId
    && isSafeCompiledIdentifier(descriptors.sessionId.value)
    && validPartyMemberText(descriptors.name.value, 128)
    && validPartyMemberText(descriptors.archetype.value, 128)
    && (!hasMeta || meta !== null && Object.keys(meta).length > 0)
    && isHighEntropyActionId(descriptors.actionId.value)
    && Number.isSafeInteger(descriptors.expectedGeneration.value)
    && descriptors.expectedGeneration.value >= 0
}

function validOrdinaryCharacterPatchPendingRequest(value, sessionId) {
  const descriptors = closedPlainDataRecord(value, ORDINARY_CHARACTER_PATCH_PENDING_KEYS)
  if (!descriptors) return false
  const patch = normalizeOrdinaryCharacterPatch(descriptors.patch.value)
  return patch !== null
    && descriptors.version.value === ORDINARY_PENDING_VERSION
    && descriptors.kind.value === ORDINARY_CHARACTER_PATCH_PENDING_KIND
    && descriptors.sessionId.value === sessionId
    && isSafeCompiledIdentifier(descriptors.sessionId.value)
    && isHighEntropyActionId(descriptors.actionId.value)
    && Number.isSafeInteger(descriptors.expectedGeneration.value)
    && descriptors.expectedGeneration.value >= 0
}

function validOrdinaryKpText(value, maximum) {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && Array.from(value).length <= maximum
}

/**
 * The public wire field is deliberately named `message`; retry storage calls
 * it `content` so the immutable host operation has one unambiguous semantic
 * value. This is the sole message/content conversion point.
 */
function normalizeOrdinaryKpMessageInput(value) {
  const descriptors = closedPlainDataRecord(value, ['speaker', 'content', 'type'], ['content'])
  if (!descriptors) return null
  const speaker = Object.prototype.hasOwnProperty.call(descriptors, 'speaker')
    ? descriptors.speaker.value
    : ORDINARY_KP_DEFAULT_SPEAKER
  const content = descriptors.content.value
  const type = Object.prototype.hasOwnProperty.call(descriptors, 'type')
    ? descriptors.type.value
    : 'system'
  if (typeof speaker !== 'string' || typeof content !== 'string' || typeof type !== 'string') return null
  const normalized = { speaker: speaker.trim(), content: content.trim(), type: type.trim() }
  return validOrdinaryKpText(normalized.speaker, 128)
    && validOrdinaryKpText(normalized.content, 8_000)
    && ORDINARY_KP_MESSAGE_TYPES.has(normalized.type)
    ? normalized
    : null
}

function validOrdinaryKpMessagePendingRequest(value, sessionId) {
  const descriptors = closedPlainDataRecord(value, ORDINARY_KP_MESSAGE_PENDING_KEYS)
  if (!descriptors) return false
  return descriptors.version.value === ORDINARY_PENDING_VERSION
    && descriptors.kind.value === ORDINARY_KP_MESSAGE_PENDING_KIND
    && descriptors.sessionId.value === sessionId
    && isSafeCompiledIdentifier(descriptors.sessionId.value)
    && validOrdinaryKpText(descriptors.speaker.value, 128)
    && validOrdinaryKpText(descriptors.content.value, 8_000)
    && typeof descriptors.type.value === 'string'
    && ORDINARY_KP_MESSAGE_TYPES.has(descriptors.type.value)
    && isHighEntropyActionId(descriptors.actionId.value)
    && Number.isSafeInteger(descriptors.expectedGeneration.value)
    && descriptors.expectedGeneration.value >= 0
}

/**
 * v1 text records deliberately retain their original no-discriminator shape.
 * The new structured record has an explicit kind, so corrupt storage is never
 * guessed into an endpoint and existing browser records remain replayable.
 */
function validOrdinaryPendingRequest(value, sessionId) {
  return validOrdinaryTextPendingRequest(value, sessionId)
    || validOrdinaryLuckSpendPendingRequest(value, sessionId)
    || validOrdinaryPartyMemberCreatePendingRequest(value, sessionId)
    || validOrdinaryCharacterPatchPendingRequest(value, sessionId)
    || validOrdinaryKpMessagePendingRequest(value, sessionId)
}

function ordinaryPendingKind(request) {
  return Object.prototype.hasOwnProperty.call(request, 'kind')
    ? request.kind
    : 'text_action'
}

function sameOrdinaryPendingRequest(left, right) {
  const kind = ordinaryPendingKind(left)
  if (kind !== ordinaryPendingKind(right)) return false
  if (kind === ORDINARY_LUCK_SPEND_PENDING_KIND) {
    return left.version === right.version
      && left.kind === right.kind
      && left.sessionId === right.sessionId
      && left.amount === right.amount
      && left.actionId === right.actionId
      && left.expectedGeneration === right.expectedGeneration
  }
  if (kind === ORDINARY_PARTY_MEMBER_CREATE_PENDING_KIND) {
    const leftMeta = Object.prototype.hasOwnProperty.call(left, 'meta') ? left.meta : null
    const rightMeta = Object.prototype.hasOwnProperty.call(right, 'meta') ? right.meta : null
    return left.version === right.version
      && left.kind === right.kind
      && left.sessionId === right.sessionId
      && left.name === right.name
      && left.archetype === right.archetype
      && JSON.stringify(leftMeta) === JSON.stringify(rightMeta)
      && left.actionId === right.actionId
      && left.expectedGeneration === right.expectedGeneration
  }
  if (kind === ORDINARY_CHARACTER_PATCH_PENDING_KIND) {
    return left.version === right.version
      && left.kind === right.kind
      && left.sessionId === right.sessionId
      && JSON.stringify(left.patch) === JSON.stringify(right.patch)
      && left.actionId === right.actionId
      && left.expectedGeneration === right.expectedGeneration
  }
  if (kind === ORDINARY_KP_MESSAGE_PENDING_KIND) {
    return left.version === right.version
      && left.kind === right.kind
      && left.sessionId === right.sessionId
      && left.speaker === right.speaker
      && left.content === right.content
      && left.type === right.type
      && left.actionId === right.actionId
      && left.expectedGeneration === right.expectedGeneration
  }
  return left.version === right.version
    && left.sessionId === right.sessionId
    && left.input === right.input
    && left.actionId === right.actionId
    && left.expectedGeneration === right.expectedGeneration
    && Object.prototype.hasOwnProperty.call(left, 'pcId') === Object.prototype.hasOwnProperty.call(right, 'pcId')
    && left.pcId === right.pcId
}

function removeExactOrdinaryPending(storage, request) {
  const key = ordinaryActionPendingStorageKey(request.sessionId)
  try {
    const raw = storage.getItem(key)
    if (raw === null) return
    const current = JSON.parse(raw)
    if (validOrdinaryPendingRequest(current, request.sessionId) && sameOrdinaryPendingRequest(current, request)) {
      storage.removeItem(key)
    }
  } catch {
    // Cleanup is deliberately best effort. Leaving an exact idempotency key
    // behind can only cause its server receipt to be replayed, never a new
    // logical action.
  }
}

function readOrdinaryPending(sessionId, storage) {
  const key = ordinaryActionPendingStorageKey(sessionId)
  let raw
  try {
    raw = storage.getItem(key)
  } catch {
    throw new Error('ordinary action retry storage is unreadable')
  }
  if (raw === null) return null
  try {
    const request = JSON.parse(raw)
    if (validOrdinaryPendingRequest(request, sessionId)) return request
  } catch {
    // An opaque local record is never authority to execute an action.
  }
  removePending(storage, key)
  return null
}

function saveOrdinaryPending(request, storage) {
  if (!validOrdinaryPendingRequest(request, request.sessionId)) throw new Error('ordinary action retry request is invalid')
  try {
    storage.setItem(ordinaryActionPendingStorageKey(request.sessionId), JSON.stringify(request))
  } catch {
    // No durable browser record means no POST. This is the boundary that
    // makes a lost acknowledgement safe to replay after a reload.
    throw new Error('ordinary action retry request could not be persisted')
  }
}

function ordinaryRequestBody(request) {
  if (ordinaryPendingKind(request) !== 'text_action') throw new Error('ordinary text retry request is invalid')
  return {
    input: request.input,
    ...(Object.prototype.hasOwnProperty.call(request, 'pcId') ? { pcId: request.pcId } : {}),
    actionId: request.actionId,
    expectedGeneration: request.expectedGeneration,
  }
}

function ordinaryLuckSpendRequestBody(request) {
  if (ordinaryPendingKind(request) !== ORDINARY_LUCK_SPEND_PENDING_KIND) throw new Error('ordinary Luck retry request is invalid')
  return {
    amount: request.amount,
    actionId: request.actionId,
    expectedGeneration: request.expectedGeneration,
  }
}

function ordinaryPartyMemberCreateRequestBody(request) {
  if (ordinaryPendingKind(request) !== ORDINARY_PARTY_MEMBER_CREATE_PENDING_KIND) throw new Error('ordinary party retry request is invalid')
  return {
    name: request.name,
    archetype: request.archetype,
    ...(request.meta ?? {}),
    actionId: request.actionId,
    expectedGeneration: request.expectedGeneration,
  }
}

function ordinaryCharacterPatchRequestBody(request) {
  if (ordinaryPendingKind(request) !== ORDINARY_CHARACTER_PATCH_PENDING_KIND) throw new Error('ordinary character retry request is invalid')
  return {
    ...request.patch,
    actionId: request.actionId,
    expectedGeneration: request.expectedGeneration,
  }
}

function ordinaryKpMessageRequestBody(request) {
  if (ordinaryPendingKind(request) !== ORDINARY_KP_MESSAGE_PENDING_KIND) throw new Error('ordinary KP message retry request is invalid')
  return {
    actionId: request.actionId,
    expectedGeneration: request.expectedGeneration,
    message: request.content,
    speaker: request.speaker,
    type: request.type,
  }
}

function explicitOrdinaryPreCommitRefusal(error, request) {
  if (error?.responseReadFailed || ![400, 409].includes(error?.status)) return false
  // These are the only responses the ordinary server guarantees were emitted
  // before this request could commit. Every other error is indeterminate and
  // keeps the exact durable request for reconciliation/retry.
  const codes = ordinaryPendingKind(request) === ORDINARY_LUCK_SPEND_PENDING_KIND
    ? [
      'ordinary_luck_spend_contract_required',
      'ordinary_luck_spend_rejected',
    ]
    : ordinaryPendingKind(request) === ORDINARY_PARTY_MEMBER_CREATE_PENDING_KIND
      ? [
        'ordinary_party_contract_required',
        'ordinary_party_member_rejected',
      ]
      : ordinaryPendingKind(request) === ORDINARY_CHARACTER_PATCH_PENDING_KIND
        ? [
          'ordinary_character_contract_required',
          'ordinary_character_patch_rejected',
        ]
        : ordinaryPendingKind(request) === ORDINARY_KP_MESSAGE_PENDING_KIND
          ? [
            'ordinary_kp_message_contract_required',
            'ordinary_kp_message_rejected',
          ]
        : ['ordinary_action_contract_required']
  return [...codes,
    'ordinary_action_id_conflict',
    'ordinary_generation_conflict',
    'ordinary_live_state_stale',
  ].includes(error?.data?.code)
}

export function isAuthoritativeOrdinaryCharacter(payload, sessionId, minimumGeneration) {
  if (!isRecord(payload) || payload.sessionKind !== 'ordinary'
    || !isSafeCompiledIdentifier(payload.pcId)
    || ordinarySessionGeneration(payload, 'ordinary') === null
    || minimumGeneration !== undefined && ordinarySessionGeneration(payload, 'ordinary') < minimumGeneration) return false
  const summary = payload.summary
  const character = payload.character
  const sanity = payload.sanity
  if (!isRecord(summary) || summary.id !== sessionId || !isRecord(character) || !isRecord(sanity)
    || typeof character.name !== 'string' || typeof character.archetype !== 'string') return false
  // Build through the same strict patch normalizer the POST uses. This proves
  // the editor never accepts a response with executable/prototype data as its
  // durable confirmation and gives every editable value a bounded shape.
  return normalizeOrdinaryCharacterPatch({
    hp: character.hp,
    maxHp: character.maxHp,
    luck: character.luck,
    creditRating: character.creditRating,
    skills: character.skills,
    attributes: character.attributes,
    inventory: payload.inventory,
    weapons: payload.weapons,
  }) !== null
    && Number.isSafeInteger(sanity.currentSAN)
    && Number.isSafeInteger(sanity.maxSAN)
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((item, index) => item === right[index])
}

/**
 * A 200 character response is still only transport data until it proves it is
 * this request's immediate successor. The authoritative GET may be newer,
 * but an unrelated/malformed 200 must never retire an idempotency record.
 */
function validOrdinaryCharacterPostReceipt(receipt, request) {
  if (ordinaryPendingKind(request) !== ORDINARY_CHARACTER_PATCH_PENDING_KIND) return false
  const root = closedPlainDataRecord(receipt,
    ['pcId', 'character', 'inventory', 'weapons', 'summary', 'sessionKind', 'ordinaryGeneration'])
  if (!root || root.sessionKind.value !== 'ordinary' || !isSafeCompiledIdentifier(root.pcId.value)
    || root.ordinaryGeneration.value !== request.expectedGeneration + 1) return false
  const summary = closedPlainDataRecord(root.summary.value,
    ['id', 'round', 'ruleset', 'scene', 'playerName', 'archetype', 'messageCount', 'npcCount', 'createdAt'])
  const character = plainDataTable(root.character.value, 256)
  if (!summary || summary.id.value !== request.sessionId || !character
    || typeof character.name?.value !== 'string'
    || !sameStringArray(root.inventory.value, normalizeOrdinaryCharacterPatch({ inventory: root.inventory.value })?.inventory)
    || !sameStringArray(root.weapons.value, normalizeOrdinaryCharacterPatch({ weapons: root.weapons.value })?.weapons)) return false
  const successor = normalizeOrdinaryCharacterPatch({
    hp: character.hp?.value,
    maxHp: character.maxHp?.value,
    luck: character.luck?.value,
    creditRating: character.creditRating?.value,
    skills: character.skillValues?.value,
    attributes: character.attributes?.value,
    inventory: root.inventory.value,
    weapons: root.weapons.value,
  })
  if (!successor) return false
  for (const key of ['hp', 'maxHp', 'luck', 'creditRating']) {
    if (Object.prototype.hasOwnProperty.call(request.patch, key) && successor[key] !== request.patch[key]) return false
  }
  for (const key of ['skills', 'attributes']) {
    if (!Object.prototype.hasOwnProperty.call(request.patch, key)) continue
    if (!Object.entries(request.patch[key]).every(([name, score]) => successor[key]?.[name] === score)) return false
  }
  return (!Object.prototype.hasOwnProperty.call(request.patch, 'inventory') || sameStringArray(successor.inventory, request.patch.inventory))
    && (!Object.prototype.hasOwnProperty.call(request.patch, 'weapons') || sameStringArray(successor.weapons, request.patch.weapons))
}

/** A KP 200 is not confirmation until it is closed, canonical, and bound to this exact durable request. */
function validOrdinaryKpMessagePostReceipt(receipt, request) {
  if (ordinaryPendingKind(request) !== ORDINARY_KP_MESSAGE_PENDING_KIND) return false
  const root = closedPlainDataRecord(receipt, ['message', 'summary', 'sessionKind', 'ordinaryGeneration'])
  if (!root || root.sessionKind.value !== 'ordinary' || root.ordinaryGeneration.value !== request.expectedGeneration + 1) return false
  const message = closedPlainDataRecord(root.message.value, ['speaker', 'content', 'type', 'timestamp'])
  const summary = closedPlainDataRecord(root.summary.value,
    ['id', 'round', 'ruleset', 'scene', 'playerName', 'archetype', 'messageCount', 'npcCount', 'createdAt'])
  if (!message || !summary || summary.id.value !== request.sessionId
    || message.speaker.value !== request.speaker
    || message.content.value !== request.content
    || message.type.value !== request.type
    || !Number.isSafeInteger(message.timestamp.value) || message.timestamp.value < 0) return false
  return validOrdinarySummaryDescriptors(summary, request.sessionId)
}

function validOrdinarySummaryDescriptors(summary, sessionId) {
  return summary.id.value === sessionId
    && Number.isSafeInteger(summary.round.value) && summary.round.value >= 0
    && typeof summary.ruleset.value === 'string'
    && typeof summary.scene.value === 'string'
    && typeof summary.playerName.value === 'string'
    // SessionSummary is intentionally nullable for a legacy/no-archetype
    // session; treating null as a malformed receipt would strand a durable
    // request forever even though it is the server's canonical value.
    && (typeof summary.archetype.value === 'string' || summary.archetype.value === null)
    && Number.isSafeInteger(summary.messageCount.value) && summary.messageCount.value >= 0
    && Number.isSafeInteger(summary.npcCount.value) && summary.npcCount.value >= 0
    && Number.isSafeInteger(summary.createdAt.value) && summary.createdAt.value >= 0
}

function validPlainDataArray(value, maximumLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length || value.length > maximumLength) return false
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !names.includes('length')) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (!Object.prototype.hasOwnProperty.call(descriptors, 'length')) return false
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false
  }
  return true
}

function validOrdinaryHistoryMessages(value, maximumLength) {
  if (!validPlainDataArray(value, maximumLength)) return false
  return value.every((entry) => {
    const descriptors = plainDataTable(entry, 32)
    return !!descriptors
      && Object.prototype.hasOwnProperty.call(descriptors, 'speaker')
      && Object.prototype.hasOwnProperty.call(descriptors, 'content')
      && Object.prototype.hasOwnProperty.call(descriptors, 'type')
      && typeof descriptors.speaker.value === 'string'
      && typeof descriptors.content.value === 'string'
      && ['dialogue', 'narration', 'system', 'action'].includes(descriptors.type.value)
  })
}

/** Verify the two owner GETs before a KP receipt may retire its exact retry key. */
function validOrdinaryKpMessageAuthority(session, history, request, receipt) {
  const sessionRoot = closedPlainDataRecord(session,
    ['summary', 'state', 'sanity', 'history', 'sessionKind', 'ordinaryGeneration', 'dead', 'terminal'])
  if (!sessionRoot || sessionRoot.sessionKind.value !== 'ordinary'
    || !Number.isSafeInteger(sessionRoot.ordinaryGeneration.value)
    || sessionRoot.ordinaryGeneration.value < 0
    || receipt && sessionRoot.ordinaryGeneration.value < receipt.ordinaryGeneration
    || typeof sessionRoot.dead.value !== 'boolean'
    || plainDataTable(sessionRoot.state.value, 256) === null
    || plainDataTable(sessionRoot.sanity.value, 64) === null
    || !validOrdinaryHistoryMessages(sessionRoot.history.value, 10)) return false
  const summary = closedPlainDataRecord(sessionRoot.summary.value,
    ['id', 'round', 'ruleset', 'scene', 'playerName', 'archetype', 'messageCount', 'npcCount', 'createdAt'])
  if (!summary || !validOrdinarySummaryDescriptors(summary, request.sessionId)) return false
  if (sessionRoot.terminal.value !== null && plainDataTable(sessionRoot.terminal.value, 16) === null) return false

  const historyRoot = closedPlainDataRecord(history, ['messages', 'total'])
  return !!historyRoot
    && validOrdinaryHistoryMessages(historyRoot.messages.value, 100)
    && Number.isSafeInteger(historyRoot.total.value)
    && historyRoot.total.value >= historyRoot.messages.value.length
}

async function reconcileOrdinaryCharacterPending(storage, request, receipt, { retire = true, minimumGeneration } = {}) {
  // A character POST receipt is intentionally not projected into UI state.
  // It may be malformed or describe a generation already superseded by
  // another owner tab. All fields rendered by CharacterEditor come from this
  // owner-authenticated, complete character GET plus the matching session and
  // history snapshots.
  const [character, session, history] = await Promise.all([
    getCharacter(request.sessionId),
    getSession(request.sessionId),
    getHistory(request.sessionId, 100),
  ])
  const characterGeneration = ordinarySessionGeneration(character, 'ordinary')
  const sessionGeneration = ordinarySessionGeneration(session, 'ordinary')
  if (!isAuthoritativeOrdinaryCharacter(character, request.sessionId, minimumGeneration)
    || characterGeneration === null || sessionGeneration === null || characterGeneration !== sessionGeneration) {
    throw new Error('ordinary character persistence could not be authoritatively confirmed')
  }
  // A later ordinary action may legitimately switch the active PC. The POST
  // receipt proves its own p1/g1 successor; only an equal-generation GET must
  // still name that PC. A newer same-session view is authoritative for UI.
  if (receipt && (characterGeneration < receipt.ordinaryGeneration
    || characterGeneration === receipt.ordinaryGeneration && character.pcId !== receipt.pcId)) {
    throw new Error('ordinary character receipt is not bound to the authoritative active sheet')
  }
  if (retire) removeExactOrdinaryPending(storage, request)
  return {
    kind: 'reconciled',
    pendingKind: ORDINARY_CHARACTER_PATCH_PENDING_KIND,
    character,
    session,
    history,
    ...(receipt ? { receipt } : {}),
    ...(receipt ? { committed: true, committedGeneration: receipt.ordinaryGeneration } : {}),
    ...(retire ? {} : { pendingRetained: true }),
  }
}

async function reconcileOrdinaryKpMessagePending(storage, request, receipt, { retire = true } = {}) {
  // The KP receipt names the intended successor, but it does not render
  // authority. Validate both owner reads before touching the exact retry key:
  // a wrong session/kind, stale generation, malformed history, or injected
  // accessor stays pending and is safe to replay verbatim.
  const [session, history] = await Promise.all([
    getSession(request.sessionId),
    getHistory(request.sessionId, 100),
  ])
  if (!validOrdinaryKpMessageAuthority(session, history, request, receipt)) {
    // This code is intentionally stable: the exact retry key must survive an
    // owner-read response that cannot prove the durable ordinary successor.
    throw new Error(ORDINARY_KP_MESSAGE_AUTHORITY_UNCONFIRMED)
  }
  if (retire) removeExactOrdinaryPending(storage, request)
  return {
    kind: 'reconciled',
    pendingKind: ORDINARY_KP_MESSAGE_PENDING_KIND,
    session,
    history,
    ...(receipt ? { receipt } : {}),
    ...(retire ? {} : { pendingRetained: true }),
  }
}

async function reconcileOrdinaryPending(storage, request, receipt, { retire = true, minimumGeneration } = {}) {
  if (ordinaryPendingKind(request) === ORDINARY_CHARACTER_PATCH_PENDING_KIND) {
    return reconcileOrdinaryCharacterPending(storage, request, receipt, { retire, minimumGeneration })
  }
  if (ordinaryPendingKind(request) === ORDINARY_KP_MESSAGE_PENDING_KIND) {
    return reconcileOrdinaryKpMessagePending(storage, request, receipt, { retire })
  }
  // Do not use an old receipt to render state: a different browser/client may
  // already have advanced the session. The GET state and history are the only
  // authority when recovering an unknown acknowledgement.
  const [session, history] = await Promise.all([
    getSession(request.sessionId),
    getHistory(request.sessionId, 100),
  ])
  if (retire) removeExactOrdinaryPending(storage, request)
  return {
    kind: 'reconciled',
    // The ordinary queue intentionally holds both legacy text and structured
    // Luck requests. Consumers need this stable discriminant before deciding
    // whether a recovered receipt means "Luck spent" or merely a prior text
    // action that must be acknowledged first.
    pendingKind: ordinaryPendingKind(request),
    session,
    history,
    ...(receipt ? { receipt } : {}),
    ...(retire ? {} : { pendingRetained: true }),
  }
}

async function postPendingOrdinaryAction(request, storage, { retried = false } = {}) {
  try {
    const data = await executeOrdinaryPendingRequest(request)
    if (ordinaryPendingKind(request) === ORDINARY_CHARACTER_PATCH_PENDING_KIND
      && !validOrdinaryCharacterPostReceipt(data, request)) {
      throw new Error('ordinary character POST receipt is malformed or does not match this patch')
    }
    if (ordinaryPendingKind(request) === ORDINARY_KP_MESSAGE_PENDING_KIND
      && !validOrdinaryKpMessagePostReceipt(data, request)) {
      throw new Error('ordinary KP message POST receipt is malformed or does not match this announcement')
    }
    if (retried || ordinaryPendingKind(request) === ORDINARY_PARTY_MEMBER_CREATE_PENDING_KIND
      || ordinaryPendingKind(request) === ORDINARY_CHARACTER_PATCH_PENDING_KIND
      || ordinaryPendingKind(request) === ORDINARY_KP_MESSAGE_PENDING_KIND) {
      return reconcileOrdinaryPending(storage, request, data, {
        minimumGeneration: ordinaryPendingKind(request) === ORDINARY_CHARACTER_PATCH_PENDING_KIND
          ? request.expectedGeneration + 1
          : undefined,
      })
    }
    // Only a successful JSON response from this exact POST is enough to
    // retire the request without a reconciliation read.
    removeExactOrdinaryPending(storage, request)
    return { kind: 'ordinary', data }
  } catch (error) {
    if ([400, 409].includes(error?.status) && !error?.responseReadFailed) {
      try {
        return await reconcileOrdinaryPending(storage, request, undefined, { retire: explicitOrdinaryPreCommitRefusal(error, request) })
      } catch {
        // Neither a deterministic pre-commit refusal nor an indeterminate
        // 400/409 is safe to forget until the app has an authoritative view.
      }
    }
    throw error
  }
}

/** Replay the stored ordinary request verbatim, then replace UI state from GET. */
export async function retryPendingOrdinaryAction(sessionId, { storage } = {}) {
  const durableStorage = ordinaryRetryStorage(storage)
  const request = readOrdinaryPending(sessionId, durableStorage)
  if (!request) return null
  return postPendingOrdinaryAction(request, durableStorage, { retried: true })
}

/** Read the one ordinary queue's endpoint discriminant without creating work. */
export function pendingOrdinaryActionKind(sessionId, { storage } = {}) {
  const durableStorage = ordinaryRetryStorage(storage)
  const request = readOrdinaryPending(sessionId, durableStorage)
  return request ? ordinaryPendingKind(request) : null
}

export async function createSession({ ruleset = 'cosmic-horror', archetype, characterName } = {}) {
  const body = { ruleset }
  if (archetype) body.archetype = archetype
  if (characterName) body.characterName = characterName
  const res = await ownerFetch(`${BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('创建失败')
  }
  if (res.ok) return data
  // Generation zero may already be durable even when the initial create
  // acknowledgement is indeterminate. A locator is not permission to create
  // another session: reconcile that exact locator once instead.
  if (data?.sessionKind === 'ordinary'
    && ordinarySessionGeneration(data, 'ordinary') === 0
    && isSafeCompiledIdentifier(data?.sessionId)) {
    const current = await getSession(data.sessionId)
    return { ...data, ...current, sessionId: data.sessionId, sessionKind: 'ordinary' }
  }
  const nestedError = isRecord(data?.error)
    ? (typeof data.error.message === 'string' ? data.error.message : data.error.code)
    : data?.error
  throw new Error(typeof nestedError === 'string' ? nestedError : '创建失败')
}

export async function getArchetypes(ruleset = 'cosmic-horror') {
  const res = await fetch(`${BASE}/archetypes?ruleset=${ruleset}`)
  return res.json()
}

export async function sendAction(sessionId, input) {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  })
  if (!res.ok) throw new Error((await res.json()).error || '请求失败')
  return res.json()
}

/** The ordinary endpoint's durable four-field HTTP contract. */
export async function executeOrdinaryAction(sessionId, request) {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ordinaryRequestBody(request)),
  })
  return jsonOrThrow(res, 'ordinary action failed')
}

async function executeOrdinaryLuckSpend(sessionId, request) {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}/luck-spend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ordinaryLuckSpendRequestBody(request)),
  })
  return jsonOrThrow(res, 'ordinary Luck spend failed')
}

async function executeOrdinaryPartyMemberCreate(sessionId, request) {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}/party`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ordinaryPartyMemberCreateRequestBody(request)),
  })
  return jsonOrThrow(res, 'ordinary party member create failed')
}

async function executeOrdinaryCharacterPatch(sessionId, request) {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}/character`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ordinaryCharacterPatchRequestBody(request)),
  })
  return jsonOrThrow(res, 'ordinary character patch failed')
}

async function executeOrdinaryKpMessage(sessionId, request) {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}/kp/send-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ordinaryKpMessageRequestBody(request)),
  })
  return jsonOrThrow(res, 'ordinary KP message failed')
}

/** The ordinary durable queue is one endpoint-aware dispatcher, never two queues. */
async function executeOrdinaryPendingRequest(request) {
  if (ordinaryPendingKind(request) === 'text_action') return executeOrdinaryAction(request.sessionId, request)
  if (ordinaryPendingKind(request) === ORDINARY_LUCK_SPEND_PENDING_KIND) return executeOrdinaryLuckSpend(request.sessionId, request)
  if (ordinaryPendingKind(request) === ORDINARY_PARTY_MEMBER_CREATE_PENDING_KIND) return executeOrdinaryPartyMemberCreate(request.sessionId, request)
  if (ordinaryPendingKind(request) === ORDINARY_CHARACTER_PATCH_PENDING_KIND) return executeOrdinaryCharacterPatch(request.sessionId, request)
  if (ordinaryPendingKind(request) === ORDINARY_KP_MESSAGE_PENDING_KIND) return executeOrdinaryKpMessage(request.sessionId, request)
  throw new Error('ordinary retry request kind is invalid')
}

/**
 * Send one ordinary text action with a durable idempotency record. A pending
 * request always wins over new input so a reload cannot generate a new action
 * ID for an action whose server acknowledgement was lost.
 */
export async function sendOrdinaryAction(sessionId, input, {
  pcId,
  expectedGeneration,
  actionId,
  createActionId = secureActionId,
  storage,
} = {}) {
  const durableStorage = ordinaryRetryStorage(storage)
  const recovered = await retryPendingOrdinaryAction(sessionId, { storage: durableStorage })
  if (recovered) return recovered
  const id = actionId ?? createActionId()
  if (!isHighEntropyActionId(id)) throw new Error('ordinary action requires a high-entropy actionId')
  const request = {
    version: ORDINARY_PENDING_VERSION,
    sessionId,
    input,
    ...(pcId === undefined ? {} : { pcId }),
    actionId: id,
    expectedGeneration,
  }
  saveOrdinaryPending(request, durableStorage)
  return postPendingOrdinaryAction(request, durableStorage)
}

/**
 * Add one ordinary party member through the same single durable queue as text
 * and Luck. Existing pending work wins before this input is even validated,
 * so a page reload cannot replace an indeterminate action with a new party
 * member or a stale generation.
 */
export async function partyMemberCreate(sessionId, input, {
  expectedGeneration,
  actionId,
  createActionId = secureActionId,
  storage,
} = {}) {
  const durableStorage = ordinaryRetryStorage(storage)
  const recovered = await retryPendingOrdinaryAction(sessionId, { storage: durableStorage })
  if (recovered) return recovered
  const normalized = normalizePartyMemberCreateInput(input)
  if (!normalized) throw new Error('ordinary party member create input is invalid')
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('ordinary party member create generation is invalid')
  const id = actionId ?? createActionId()
  if (!isHighEntropyActionId(id)) throw new Error('ordinary party member create requires a high-entropy actionId')
  const request = {
    version: ORDINARY_PENDING_VERSION,
    kind: ORDINARY_PARTY_MEMBER_CREATE_PENDING_KIND,
    sessionId,
    name: normalized.name,
    archetype: normalized.archetype,
    ...(normalized.meta ? { meta: normalized.meta } : {}),
    actionId: id,
    expectedGeneration,
  }
  // The immutable record is saved before the first POST; no record means no
  // request, preserving retry safety through browser crashes and reloads.
  saveOrdinaryPending(request, durableStorage)
  return postPendingOrdinaryAction(request, durableStorage)
}

/**
 * Persist and replay an ordinary active-PC character patch through the same
 * single browser slot as text, Luck, and party operations. The return value
 * is always a reconciled authority view; a successful POST alone never
 * confirms an editable sheet.
 */
export async function characterPatch(sessionId, input, {
  expectedGeneration,
  actionId,
  createActionId = secureActionId,
  storage,
} = {}) {
  const durableStorage = ordinaryRetryStorage(storage)
  const recovered = await retryPendingOrdinaryAction(sessionId, { storage: durableStorage })
  if (recovered) return recovered
  const patch = normalizeOrdinaryCharacterPatch(input)
  if (!patch) throw new Error('ordinary character patch input is invalid')
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('ordinary character patch generation is invalid')
  const id = actionId ?? createActionId()
  if (!isHighEntropyActionId(id)) throw new Error('ordinary character patch requires a high-entropy actionId')
  const request = {
    version: ORDINARY_PENDING_VERSION,
    kind: ORDINARY_CHARACTER_PATCH_PENDING_KIND,
    sessionId,
    patch,
    actionId: id,
    expectedGeneration,
  }
  // Exactly as text/Luck/party, local persistence precedes the very first
  // POST. A quota/storage error is fail-closed rather than an unsafe send.
  saveOrdinaryPending(request, durableStorage)
  return postPendingOrdinaryAction(request, durableStorage)
}

/**
 * Publish the one ordinary host announcement only through the shared durable
 * browser slot. A previous text/Luck/party/character/KP request always wins;
 * this call never overwrites it or generates another idempotency key.
 */
export async function ordinaryKpMessage(sessionId, input, {
  expectedGeneration,
  actionId,
  createActionId = secureActionId,
  storage,
} = {}) {
  const durableStorage = ordinaryRetryStorage(storage)
  const recovered = await retryPendingOrdinaryAction(sessionId, { storage: durableStorage })
  if (recovered) return recovered
  const normalized = normalizeOrdinaryKpMessageInput(input)
  if (!normalized) throw new Error('ordinary KP message input is invalid')
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('ordinary KP message generation is invalid')
  const id = actionId ?? createActionId()
  if (!isHighEntropyActionId(id)) throw new Error('ordinary KP message requires a high-entropy actionId')
  const request = {
    version: ORDINARY_PENDING_VERSION,
    kind: ORDINARY_KP_MESSAGE_PENDING_KIND,
    sessionId,
    speaker: normalized.speaker,
    content: normalized.content,
    type: normalized.type,
    actionId: id,
    expectedGeneration,
  }
  saveOrdinaryPending(request, durableStorage)
  return postPendingOrdinaryAction(request, durableStorage)
}

/** Read-only model classification for a compiled session's current action catalog. */
export async function resolveCompiledIntent(sessionId, { input, pcId, expectedGeneration }) {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}/compiled/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, pcId, expectedGeneration }),
  })
  return jsonOrThrow(res, '编译动作意图解析失败')
}

/** The only frontend path that asks the server to durably execute a compiled mechanism. */
export async function executeCompiledAction(sessionId, { mechanismId, pcId, actionId, expectedGeneration }) {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}/compiled/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mechanismId, pcId, actionId, expectedGeneration }),
  })
  return jsonOrThrow(res, '执行编译动作失败')
}

/**
 * Natural language goes through the read-only classifier first. Only its exact
 * selected mechanism can enter the generation-checked durable transaction.
 */
export async function sendCompiledAction(sessionId, input, {
  pcId = 'p1',
  expectedGeneration,
  actionId,
  createActionId = secureActionId,
  storage,
} = {}) {
  const recovered = await retryPendingCompiledAction(sessionId, { pcId, storage })
  if (recovered) return recovered
  const resolution = await resolveCompiledIntent(sessionId, { input, pcId, expectedGeneration })
  if (resolution?.status !== 'selected' || typeof resolution.mechanismId !== 'string' || !resolution.mechanismId) {
    return { kind: 'unresolved', resolution }
  }
  const id = actionId ?? createActionId()
  if (!isHighEntropyActionId(id)) throw new Error('编译动作缺少高熵幂等 actionId')
  const request = {
    version: COMPILED_PENDING_VERSION,
    sessionId,
    mechanismId: resolution.mechanismId,
    pcId,
    actionId: id,
    expectedGeneration,
  }
  const durableStorage = retryStorage(storage)
  // This must occur after trusted selection but before the first transaction
  // POST. Subsequent attempts reuse this complete immutable request.
  savePending(request, durableStorage)
  return postPendingCompiledAction(request, durableStorage, false)
}

/**
 * One frontend dispatch seam. Explicit session kind is authoritative: ordinary
 * never enters compiled intent/action APIs just because its generation is zero.
 * The `compiledGeneration` branch remains solely for pre-sessionKind callers.
 */
export async function sendSessionAction(sessionId, input, {
  sessionKind,
  ordinaryGeneration,
  compiledGeneration = null,
  pcId = 'p1',
  actionId,
  createActionId,
  storage,
} = {}) {
  if (sessionKind === 'ordinary') {
    return sendOrdinaryAction(sessionId, input, {
      pcId,
      expectedGeneration: ordinaryGeneration,
      actionId,
      ...(createActionId ? { createActionId } : {}),
      ...(storage !== undefined ? { storage } : {}),
    })
  }
  if (sessionKind === 'compiled' || (sessionKind === undefined && Number.isSafeInteger(compiledGeneration) && compiledGeneration >= 0)) {
    return sendCompiledAction(sessionId, input, {
      pcId,
      expectedGeneration: compiledGeneration,
      actionId,
      ...(createActionId ? { createActionId } : {}),
      ...(storage !== undefined ? { storage } : {}),
    })
  }
  return { kind: 'ordinary', data: await sendAction(sessionId, input) }
}

export async function getSession(sessionId) {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}`)
  return jsonOrThrow(res, '会话不存在')
}

export async function getCompiledActions(sessionId, pcId = 'p1') {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}/compiled/actions?pcId=${encodeURIComponent(pcId)}`)
  return jsonOrThrow(res, '获取编译动作失败')
}

export async function listSessions() {
  const res = await ownerFetch(`${BASE}/sessions`)
  const data = await jsonOrThrow(res, 'Unable to load owner sessions')
  return data.sessions ?? []
}

export async function getHistory(sessionId, limit = 50) {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}/history?limit=${limit}`)
  return jsonOrThrow(res, 'Unable to load owner session history')
}

export async function getCharacter(sessionId) {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}/character`)
  return jsonOrThrow(res, 'Unable to load owner character')
}

export async function getSuggestions(sessionId) {
  const res = await ownerFetch(`${BASE}/sessions/${sessionId}/suggestions`)
  const data = await jsonOrThrow(res, 'Unable to load owner suggestions')
  return data.suggestions ?? []
}

// The player delivery UI is intentionally a separate client contract. It
// never imports a compiled mechanism, pc ID, invite, or cookie into durable
// action retry state.
const PLAYER_FACADE_PENDING_VERSION = 1
const PLAYER_FACADE_PENDING_PREFIX = `aitrpg.player-facade.pending.v${PLAYER_FACADE_PENDING_VERSION}:`
const PLAYER_FACADE_PENDING_KEYS = ['version', 'sessionId', 'choiceId', 'actionId', 'expectedGeneration']
const PLAYER_FACADE_CHOICE_ID = /^choice_[A-Za-z0-9_-]{43}$/

function playerFacadeStorage(storage) {
  if (storage === undefined) {
    const browserStorage = defaultStorage()
    if (!browserStorage && typeof globalThis.window !== 'undefined') throw new Error('player action retry storage is unavailable')
    return browserStorage
  }
  if (!isStorageLike(storage)) throw new Error('player action retry storage is unavailable')
  return storage
}

export function playerFacadePendingStorageKey(sessionId) {
  if (!isSafeCompiledIdentifier(sessionId)) throw new Error('player session ID is invalid')
  return `${PLAYER_FACADE_PENDING_PREFIX}${encodeURIComponent(sessionId)}`
}

/** Public locators are validated before they are interpolated into player URLs. */
export function isSafePlayerFacadeSessionId(value) {
  return isSafeCompiledIdentifier(value)
}

function validPlayerFacadePending(value, sessionId) {
  return isRecord(value)
    && Object.keys(value).length === PLAYER_FACADE_PENDING_KEYS.length
    && PLAYER_FACADE_PENDING_KEYS.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && value.version === PLAYER_FACADE_PENDING_VERSION
    && value.sessionId === sessionId
    && isSafeCompiledIdentifier(value.sessionId)
    && typeof value.choiceId === 'string' && PLAYER_FACADE_CHOICE_ID.test(value.choiceId)
    && isHighEntropyActionId(value.actionId)
    && Number.isSafeInteger(value.expectedGeneration) && value.expectedGeneration >= 0
}

function readPlayerFacadePending(sessionId, storage) {
  if (!storage) return null
  const key = playerFacadePendingStorageKey(sessionId)
  let raw
  try { raw = storage.getItem(key) } catch { throw new Error('player action retry storage is unreadable') }
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw)
    if (validPlayerFacadePending(parsed, sessionId)) return parsed
  } catch { /* discard malformed opaque state */ }
  removePending(storage, key)
  return null
}

function savePlayerFacadePending(request, storage) {
  if (!storage) return
  if (!validPlayerFacadePending(request, request.sessionId)) throw new Error('player action retry request is invalid')
  try { storage.setItem(playerFacadePendingStorageKey(request.sessionId), JSON.stringify(request)) }
  catch { throw new Error('player action retry request could not be persisted') }
}

export async function getPlayerFacadeView(sessionId, { signal } = {}) {
  if (!isSafePlayerFacadeSessionId(sessionId)) throw new Error('player session ID is invalid')
  const res = await fetch(`${BASE}/sessions/${sessionId}/player-view`, {
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
  })
  return jsonOrThrow(res, 'player view is unavailable')
}

export async function claimPlayerInvitation(sessionId, { invite, claimId }) {
  if (!isSafePlayerFacadeSessionId(sessionId)) throw new Error('player session ID is invalid')
  const res = await fetch(`${BASE}/sessions/${sessionId}/player-invitations/claim`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite, claimId }),
  })
  if (res.status === 204) return
  await jsonOrThrow(res, 'player invitation claim failed')
}

/** A claim ID is a 256-bit WebCrypto nonce, not a session ID or role hint. */
export function securePlayerClaimId() {
  if (typeof globalThis.crypto?.getRandomValues !== 'function' || typeof globalThis.btoa !== 'function') {
    throw new Error('browser does not support secure player invitation claims')
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function postPlayerFacadeAction(request) {
  try {
    const res = await fetch(`${BASE}/sessions/${request.sessionId}/player-actions`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choiceId: request.choiceId, actionId: request.actionId, expectedGeneration: request.expectedGeneration }),
    })
    return await jsonOrThrow(res, 'player action failed')
  } catch (error) {
    if (error?.status !== undefined || error?.responseReadFailed) throw error
    throw new Error('player action failed')
  }
}

async function postPendingPlayerFacadeAction(request, storage, retried, signal) {
  try {
    const data = await postPlayerFacadeAction(request)
    if (storage) removePending(storage, playerFacadePendingStorageKey(request.sessionId))
    return { kind: 'executed', data, ...(retried ? { retried: true } : {}) }
  } catch (error) {
    if (error?.status === 409) {
      // A stale choice is never remapped locally. The authoritative narrow
      // view owns the next choice catalog, while this exact action ID retires.
      if (storage) removePending(storage, playerFacadePendingStorageKey(request.sessionId))
      return { kind: 'conflict', view: await getPlayerFacadeView(request.sessionId, { signal }) }
    }
    throw error
  }
}

export async function retryPendingPlayerFacadeAction(sessionId, { storage, signal } = {}) {
  const durableStorage = playerFacadeStorage(storage)
  const request = readPlayerFacadePending(sessionId, durableStorage)
  if (!request) return null
  return postPendingPlayerFacadeAction(request, durableStorage, true, signal)
}

export async function sendPlayerFacadeAction(sessionId, {
  choiceId,
  expectedGeneration,
  actionId,
  createActionId = secureActionId,
  storage,
} = {}) {
  const durableStorage = playerFacadeStorage(storage)
  const pending = readPlayerFacadePending(sessionId, durableStorage)
  if (pending) return postPendingPlayerFacadeAction(pending, durableStorage, true)
  const request = {
    version: PLAYER_FACADE_PENDING_VERSION,
    sessionId,
    choiceId,
    actionId: actionId ?? createActionId(),
    expectedGeneration,
  }
  savePlayerFacadePending(request, durableStorage)
  return postPendingPlayerFacadeAction(request, durableStorage, false)
}

export async function luckSpend(sessionId, amount, {
  expectedGeneration,
  actionId,
  createActionId = secureActionId,
  storage,
} = {}) {
  const durableStorage = ordinaryRetryStorage(storage)
  // A text or Luck request already persisted for this session always wins.
  // This serializes ordinary operations across endpoint shapes and prevents a
  // later Luck spend from being issued with a stale generation.
  const recovered = await retryPendingOrdinaryAction(sessionId, { storage: durableStorage })
  if (recovered) return recovered
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('ordinary Luck spend amount is invalid')
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('ordinary Luck spend generation is invalid')
  const id = actionId ?? createActionId()
  if (!isHighEntropyActionId(id)) throw new Error('ordinary Luck spend requires a high-entropy actionId')
  const request = {
    version: ORDINARY_PENDING_VERSION,
    kind: ORDINARY_LUCK_SPEND_PENDING_KIND,
    sessionId,
    amount,
    actionId: id,
    expectedGeneration,
  }
  // Storage precedes the first POST; save failure is a fail-closed no-send.
  saveOrdinaryPending(request, durableStorage)
  const result = await postPendingOrdinaryAction(request, durableStorage)
  return result.kind === 'ordinary' ? result.data : result
}
