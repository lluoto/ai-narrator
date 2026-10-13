// The sealed browser-player transport. This module intentionally has no
// dependency on the owner/Keeper API surface; `/play` loads only this file.
const BASE = '/api'
const PENDING_STORAGE_VERSION = 1
const PENDING_PREFIX = `aitrpg.player-facade.pending.v${PENDING_STORAGE_VERSION}:`
const FOLLOWUP_PENDING_PREFIX = `aitrpg.player-facade.followup-pending.v${PENDING_STORAGE_VERSION}:`
const PENDING_V1_VERSION = 1
const PENDING_V2_VERSION = 2
const PENDING_FOLLOWUP_VERSION = 3
const PENDING_FOLLOWUP_CONTEXT_VERSION = 4
const PENDING_V1_KEYS = ['version', 'sessionId', 'choiceId', 'actionId', 'expectedGeneration']
const PENDING_V2_KEYS = ['version', 'sessionId', 'choiceId', 'actionId', 'expectedGeneration', 'topicBound', 'requiresPlayerInput']
const PENDING_FOLLOWUP_KEYS = ['version', 'sessionId', 'contactToken', 'actionId', 'expectedGeneration', 'requiresPlayerInput']
const PENDING_FOLLOWUP_CONTEXT_KEYS = [...PENDING_FOLLOWUP_KEYS, 'previousActionId']
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const CHOICE_ID = /^choice_[A-Za-z0-9_-]{43}$/
const ACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOPIC_BOUND = /^[a-f0-9]{64}$/
const CONTACT_TOKEN = /^contact_[A-Za-z0-9_-]{43}$/

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function jsonMessage(data, fallback) {
  const nested = isRecord(data?.error)
    ? (typeof data.error.message === 'string' ? data.error.message : data.error.code)
    : data?.error
  if (typeof nested === 'string') return nested
  return typeof data?.code === 'string' ? data.code : fallback
}

async function jsonOrThrow(res, fallback) {
  let data
  try {
    data = await res.json()
  } catch {
    const error = new Error(fallback)
    error.status = res.status
    error.responseReadFailed = true
    throw error
  }
  if (res.ok) return data
  const error = new Error(jsonMessage(data, fallback))
  error.status = res.status
  error.data = data
  throw error
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
  throw new Error('browser does not support secure player action IDs')
}

function isStorageLike(value) {
  return !!value
    && typeof value.getItem === 'function'
    && typeof value.setItem === 'function'
    && typeof value.removeItem === 'function'
}

function playerStorage(storage) {
  if (storage !== undefined) {
    if (!isStorageLike(storage)) throw new Error('player action retry storage is unavailable')
    return storage
  }
  try {
    const browserStorage = globalThis.localStorage
    if (isStorageLike(browserStorage)) return browserStorage
  } catch { /* privacy mode may deny storage */ }
  if (typeof globalThis.window !== 'undefined') throw new Error('player action retry storage is unavailable')
  return null
}

function removePending(storage, key) {
  try { storage?.removeItem(key) } catch { /* safe to retain an already-completed idempotency request */ }
}

export function isSafePlayerFacadeSessionId(value) {
  return typeof value === 'string' && SAFE_SESSION_ID.test(value)
}

export function playerFacadePendingStorageKey(sessionId) {
  if (!isSafePlayerFacadeSessionId(sessionId)) throw new Error('player session ID is invalid')
  return `${PENDING_PREFIX}${encodeURIComponent(sessionId)}`
}

export function playerFollowupPendingStorageKey(sessionId) {
  if (!isSafePlayerFacadeSessionId(sessionId)) throw new Error('player session ID is invalid')
  return `${FOLLOWUP_PENDING_PREFIX}${encodeURIComponent(sessionId)}`
}

function validPending(value, sessionId) {
  if (!isRecord(value) || value.sessionId !== sessionId || !isSafePlayerFacadeSessionId(value.sessionId)
    || typeof value.choiceId !== 'string' || !CHOICE_ID.test(value.choiceId)
    || typeof value.actionId !== 'string' || !ACTION_ID.test(value.actionId)
    || !Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 0) return false
  if (value.version === PENDING_V1_VERSION) {
    return Object.keys(value).length === PENDING_V1_KEYS.length
      && PENDING_V1_KEYS.every(key => Object.prototype.hasOwnProperty.call(value, key))
  }
  return value.version === PENDING_V2_VERSION
    && Object.keys(value).length === PENDING_V2_KEYS.length
    && PENDING_V2_KEYS.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && typeof value.topicBound === 'string' && TOPIC_BOUND.test(value.topicBound)
    && value.requiresPlayerInput === true
}

function readPending(sessionId, storage) {
  if (!storage) return null
  const key = playerFacadePendingStorageKey(sessionId)
  let raw
  try { raw = storage.getItem(key) } catch { throw new Error('player action retry storage is unreadable') }
  if (raw === null) return null
  try {
    const value = JSON.parse(raw)
    if (validPending(value, sessionId)) return value
  } catch { /* discard malformed opaque state */ }
  removePending(storage, key)
  return null
}

function savePending(request, storage) {
  if (!storage) return
  if (!validPending(request, request.sessionId)) throw new Error('player action retry request is invalid')
  try { storage.setItem(playerFacadePendingStorageKey(request.sessionId), JSON.stringify(request)) }
  catch { throw new Error('player action retry request could not be persisted') }
}

function validFollowupPending(value, sessionId) {
  if (!isRecord(value) || value.sessionId !== sessionId || !isSafePlayerFacadeSessionId(value.sessionId)
    || typeof value.contactToken !== 'string' || !CONTACT_TOKEN.test(value.contactToken)
    || typeof value.actionId !== 'string' || !ACTION_ID.test(value.actionId)
    || !Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 0
    || value.requiresPlayerInput !== true) return false
  const keys = value.version === PENDING_FOLLOWUP_VERSION ? PENDING_FOLLOWUP_KEYS : PENDING_FOLLOWUP_CONTEXT_KEYS
  return Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && (value.version === PENDING_FOLLOWUP_VERSION
      || (value.version === PENDING_FOLLOWUP_CONTEXT_VERSION
        && typeof value.previousActionId === 'string' && ACTION_ID.test(value.previousActionId)
        && value.previousActionId !== value.actionId))
}

function readFollowupPending(sessionId, storage) {
  if (!storage) return null
  const key = playerFollowupPendingStorageKey(sessionId)
  let raw
  try { raw = storage.getItem(key) } catch { throw new Error('player followup retry storage is unreadable') }
  if (raw === null) return null
  try {
    const value = JSON.parse(raw)
    if (validFollowupPending(value, sessionId)) return value
  } catch { /* malformed opaque state is never request authority */ }
  removePending(storage, key)
  return null
}

function saveFollowupPending(request, storage) {
  if (!validFollowupPending(request, request.sessionId)) throw new Error('player followup retry request is invalid')
  if (!storage) return
  try { storage.setItem(playerFollowupPendingStorageKey(request.sessionId), JSON.stringify(request)) }
  catch { throw new Error('player followup retry request could not be persisted') }
}

export async function getPlayerFacadeView(sessionId, { signal } = {}) {
  if (!isSafePlayerFacadeSessionId(sessionId)) throw new Error('player session ID is invalid')
  const res = await fetch(`${BASE}/sessions/${sessionId}/player-view`, {
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
  })
  return jsonOrThrow(res, 'player view is unavailable')
}

/** Classification-only transport; any resulting opaque choice still uses player-actions. */
export async function resolvePlayerFacadeIntent(sessionId, { input, expectedGeneration, signal } = {}) {
  if (!isSafePlayerFacadeSessionId(sessionId)) throw new Error('player session ID is invalid')
  const res = await fetch(`${BASE}/sessions/${sessionId}/player-intents`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, expectedGeneration }),
    ...(signal ? { signal } : {}),
  })
  return jsonOrThrow(res, 'player intent is unavailable')
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

/** A claim ID is a 256-bit WebCrypto nonce, not a session locator. */
export function securePlayerClaimId() {
  if (typeof globalThis.crypto?.getRandomValues !== 'function' || typeof globalThis.btoa !== 'function') {
    throw new Error('browser does not support secure player invitation claims')
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function v2Pending(request) {
  return request.version === PENDING_V2_VERSION
}

function sameV2Action(request, { choiceId, expectedGeneration, topicBound }) {
  return v2Pending(request)
    && request.choiceId === choiceId
    && request.expectedGeneration === expectedGeneration
    && request.topicBound === topicBound
}

async function postAction(request, playerInput) {
  const body = v2Pending(request)
    ? {
        choiceId: request.choiceId,
        actionId: request.actionId,
        expectedGeneration: request.expectedGeneration,
        topicBound: request.topicBound,
        ...(typeof playerInput === 'string' && playerInput ? { playerInput } : {}),
      }
    : { choiceId: request.choiceId, actionId: request.actionId, expectedGeneration: request.expectedGeneration }
  try {
    const res = await fetch(`${BASE}/sessions/${request.sessionId}/player-actions`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await jsonOrThrow(res, 'player action failed')
  } catch (error) {
    if (error?.status !== undefined || error?.responseReadFailed) throw error
    throw new Error('player action failed')
  }
}

async function postFollowup(request, playerInput) {
  try {
    const res = await fetch(`${BASE}/sessions/${request.sessionId}/player-followups`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactToken: request.contactToken,
        actionId: request.actionId,
        expectedGeneration: request.expectedGeneration,
        playerInput,
        ...(request.previousActionId !== undefined ? { previousActionId: request.previousActionId } : {}),
      }),
    })
    return await jsonOrThrow(res, 'player followup failed')
  } catch (error) {
    if (error?.status !== undefined || error?.responseReadFailed) throw error
    throw new Error('player followup failed')
  }
}

async function postPending(request, storage, retried, signal, playerInput) {
  try {
    const data = await postAction(request, playerInput)
    removePending(storage, playerFacadePendingStorageKey(request.sessionId))
    return { kind: 'executed', data, ...(retried ? { retried: true } : {}) }
  } catch (error) {
    if (error?.status === 409) {
      // A v2 retry after a page refresh contains no raw prose. The server may
      // read an exact receipt by token, but a prepared/missing candidate needs
      // the player to explicitly re-enter the request. Keep the opaque retry
      // record; it is neither a fresh intent nor authority to reclassify.
      if (v2Pending(request)) return { kind: 'topic-required' }
      removePending(storage, playerFacadePendingStorageKey(request.sessionId))
      return { kind: 'conflict', view: await getPlayerFacadeView(request.sessionId, { signal }) }
    }
    throw error
  }
}

export async function retryPendingPlayerFacadeAction(sessionId, { storage, signal } = {}) {
  const durableStorage = playerStorage(storage)
  const request = readPending(sessionId, durableStorage)
  if (!request) return null
  return postPending(request, durableStorage, true, signal)
}

export async function sendPlayerFacadeAction(sessionId, {
  choiceId,
  expectedGeneration,
  actionId,
  topicBound,
  playerInput,
  createActionId = secureActionId,
  storage,
} = {}) {
  const durableStorage = playerStorage(storage)
  // A caller that supplies either half of the raw-topic protocol is not
  // making a legacy request. Fail closed instead of silently dropping the
  // supplied context and posting an authority-bearing v1 action.
  const topicContextSupplied = topicBound !== undefined || playerInput !== undefined
  const validTopicContext = typeof topicBound === 'string' && TOPIC_BOUND.test(topicBound)
    && typeof playerInput === 'string' && !!playerInput
  if (topicContextSupplied && !validTopicContext) {
    throw new Error('player action topic context is invalid')
  }
  const pending = readPending(sessionId, durableStorage)
  if (pending) {
    if (v2Pending(pending)) {
      // Refresh recovery has a separate token-only API. A new send either
      // carries a fully bound raw topic for this exact pending action or does
      // not dispatch at all; it must never turn a stale/malformed context into
      // a token-only provider attempt.
      if (!topicContextSupplied) return { kind: 'topic-required' }
      if (!sameV2Action(pending, { choiceId, expectedGeneration, topicBound })) {
        throw new Error('player action topic context does not match pending action')
      }
      return postPending(pending, durableStorage, true, undefined, playerInput)
    }
    return postPending(pending, durableStorage, true)
  }
  const v2 = topicContextSupplied
  const request = {
    version: v2 ? PENDING_V2_VERSION : PENDING_V1_VERSION,
    sessionId,
    choiceId,
    actionId: actionId ?? createActionId(),
    expectedGeneration,
    ...(v2 ? { topicBound, requiresPlayerInput: true } : {}),
  }
  savePending(request, durableStorage)
  return postPending(request, durableStorage, false, undefined, v2 ? playerInput : undefined)
}

/**
 * Follow-up pending data has its own slot so a stale dialogue retry cannot
 * block an ordinary action. The player prose remains memory-only; a refresh
 * must explicitly re-enter it, never downgrade this request into a fresh
 * mechanical action.
 */
export async function sendPlayerFollowup(sessionId, {
  contactToken,
  expectedGeneration,
  playerInput,
  actionId,
  previousActionId,
  createActionId = secureActionId,
  storage,
} = {}) {
  if (!isSafePlayerFacadeSessionId(sessionId) || typeof contactToken !== 'string' || !CONTACT_TOKEN.test(contactToken)
    || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0
    || typeof playerInput !== 'string' || !playerInput
    || (previousActionId !== undefined && (typeof previousActionId !== 'string' || !ACTION_ID.test(previousActionId)))) throw new Error('player followup request is invalid')
  const durableStorage = playerStorage(storage)
  const pending = readFollowupPending(sessionId, durableStorage)
  if (pending && (pending.contactToken !== contactToken || pending.expectedGeneration !== expectedGeneration)) {
    throw new Error('player followup does not match pending request')
  }
  // Retry the complete original binding, including an absent legacy context.
  // A newer UI head must never replace the pending request's previous action.
  const request = pending ?? {
    version: previousActionId === undefined ? PENDING_FOLLOWUP_VERSION : PENDING_FOLLOWUP_CONTEXT_VERSION,
    sessionId,
    contactToken,
    actionId: actionId ?? createActionId(),
    expectedGeneration,
    requiresPlayerInput: true,
    ...(previousActionId !== undefined ? { previousActionId } : {}),
  }
  saveFollowupPending(request, durableStorage)
  try {
    const data = await postFollowup(request, playerInput)
    if ((data?.status !== 'delivered' && data?.status !== 'replayed')
      || typeof data?.followup?.text !== 'string' || !data.followup.text.trim() || !isRecord(data.view)) {
      throw new Error('player followup response is invalid')
    }
    removePending(durableStorage, playerFollowupPendingStorageKey(sessionId))
    return { kind: 'delivered', data, actionId: request.actionId }
  } catch (error) {
    if (error?.status !== 409) throw error
    const view = await getPlayerFacadeView(sessionId)
    const stillCurrent = view?.generation === request.expectedGeneration
      && view?.presentation?.contacts?.some(contact => contact?.contactToken === request.contactToken)
    if (!stillCurrent) removePending(durableStorage, playerFollowupPendingStorageKey(sessionId))
    return stillCurrent ? { kind: 'input-required' } : { kind: 'conflict', view }
  }
}

/** Refresh cannot replay a raw follow-up. Reconcile only against the
 * authoritative view so stale same-generation tokens do not linger forever. */
export async function retryPendingPlayerFollowup(sessionId, { storage } = {}) {
  const durableStorage = playerStorage(storage)
  const pending = readFollowupPending(sessionId, durableStorage)
  if (!pending) return null
  const view = await getPlayerFacadeView(sessionId)
  const stillCurrent = view?.generation === pending.expectedGeneration
    && view?.presentation?.contacts?.some(contact => contact?.contactToken === pending.contactToken)
  if (!stillCurrent) {
    removePending(durableStorage, playerFollowupPendingStorageKey(sessionId))
    return { kind: 'conflict', view }
  }
  return { kind: 'input-required' }
}
