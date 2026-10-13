// The Keeper bearer deliberately lives only in this module's process memory.
// It is never normalized: a deployment credential either matches exactly or
// is rejected before it can become an Authorization header.
let ownerBearer = null

const MIN_BEARER_LENGTH = 32
const MAX_BEARER_LENGTH = 4096
const PRINTABLE_NON_WHITESPACE_ASCII = /^[\x21-\x7e]+$/

function validOwnerBearer(value) {
  return typeof value === 'string'
    && value.length >= MIN_BEARER_LENGTH
    && value.length <= MAX_BEARER_LENGTH
    && PRINTABLE_NON_WHITESPACE_ASCII.test(value)
    && !value.includes(',')
}

export function setOwnerBearer(value) {
  if (!validOwnerBearer(value)) throw new Error('Invalid owner credential')
  ownerBearer = value
}

export function clearOwnerBearer() {
  ownerBearer = null
}

function inputUrl(input) {
  if (typeof input === 'string') return input
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url
  throw new Error('owner request URL is invalid')
}

function browserOrigin() {
  const origin = globalThis.location?.origin
  return typeof origin === 'string' && origin !== 'null' ? origin : null
}

function ensureSameOrigin(input) {
  const rawUrl = inputUrl(input)
  const origin = browserOrigin()
  if (origin) {
    // URL parsing, rather than an ad-hoc prefix test, is the browser's actual
    // routing authority. It catches normalized forms such as `\\host` and
    // leading-whitespace protocol-relative URLs before a bearer can be sent.
    try {
      if (new URL(rawUrl, origin).origin === origin) return
    } catch {
      // Fall through to the stable rejection below.
    }
    throw new Error('owner request must stay on this origin')
  }
  // Bun/Node lacks a page origin. Support the root-relative URLs used by the
  // owner client, but fail closed for forms a browser could normalize cross-
  // origin (including `//host`, backslashes, and leading controls/whitespace).
  if (rawUrl.startsWith('/')
    && !rawUrl.startsWith('//')
    && !rawUrl.includes('\\')
    && !/[\u0000-\u0020]/.test(rawUrl)) return
  throw new Error('owner request must stay on this origin')
}

function mergedHeaders(input, init) {
  const headers = new Headers(typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
  if (init?.headers) {
    const supplied = new Headers(init.headers)
    supplied.forEach((value, name) => headers.set(name, value))
  }
  if (headers.has('authorization')) throw new Error('caller authorization is not allowed')
  if (ownerBearer !== null) headers.set('Authorization', `Bearer ${ownerBearer}`)
  return headers
}

/**
 * The only transport that may attach the in-memory Keeper bearer. It accepts
 * same-origin absolute URLs in browsers and ordinary relative URLs everywhere.
 */
export async function ownerFetch(input, init = {}) {
  ensureSameOrigin(input)
  const headers = mergedHeaders(input, init)
  return globalThis.fetch(input, {
    ...init,
    headers,
    credentials: 'same-origin',
    redirect: 'error',
  })
}
