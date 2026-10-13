// Browser-only lifecycle primitives for the sealed player façade. Keeping
// these small state machines outside the Vue component makes their abort and
// retry guarantees executable in ordinary unit tests.

function ignoredAbort(controller, error) {
  return controller.signal.aborted || error?.name === 'AbortError'
}

const CLAIM_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Every /play namespace URL is sealed to PlayerApp; malformed locators fail inside it. */
export function isPlayerNamespacePath(pathname) {
  return typeof pathname === 'string' && (pathname === '/play' || pathname.startsWith('/play/'))
}

export function createPlayerInvitationClaim({ sessionId, storage, createClaimId, claim }) {
  const storageKey = `aitrpg.player-claim.v1:${encodeURIComponent(sessionId)}`
  let inviteInMemory = ''
  let claimIdInMemory = ''

  function readStoredClaimId() {
    try {
      const value = storage?.getItem(storageKey) || ''
      if (!value || CLAIM_ID_PATTERN.test(value)) return value
      storage?.removeItem(storageKey)
      return ''
    } catch { return '' }
  }

  function persistClaimId(claimId) {
    try { storage?.setItem(storageKey, claimId) } catch { /* memory retry remains authoritative in this tab */ }
  }

  function clearConfirmedClaim() {
    inviteInMemory = ''
    claimIdInMemory = ''
    try { storage?.removeItem(storageKey) } catch { /* best effort after cookie delivery */ }
  }

  async function attempt(invite) {
    if (invite) inviteInMemory = invite
    if (!inviteInMemory) return false
    const generated = () => {
      const value = createClaimId()
      if (!CLAIM_ID_PATTERN.test(value)) throw new Error('browser generated an invalid player claim ID')
      return value
    }
    const claimId = CLAIM_ID_PATTERN.test(claimIdInMemory) ? claimIdInMemory : readStoredClaimId() || generated()
    // Retain this before touching the network. A denied sessionStorage write
    // must not cause an ambiguous response retry to mint a second nonce.
    claimIdInMemory = claimId
    persistClaimId(claimId)
    await claim({ invite: inviteInMemory, claimId })
    clearConfirmedClaim()
    return true
  }

  return {
    claimInvite: attempt,
    retry: () => attempt(''),
    hasRetry: () => !!inviteInMemory,
  }
}

export function createPlayerFacadePolling({
  readView,
  onView,
  onError,
  onUnauthorized,
  isHidden = () => document.hidden,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  createAbortController = () => new AbortController(),
}) {
  let active = false
  let authenticated = true
  let paused = false
  let running = false
  let failures = 0
  let timer = null
  let inFlight = null

  function clearScheduled() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  function cancelInFlight() {
    if (inFlight) inFlight.abort()
    inFlight = null
  }

  function schedule(delay) {
    clearScheduled()
    if (!active || !authenticated || paused || isHidden()) return
    timer = setTimer(() => { void refresh(true) }, delay)
  }

  async function refresh(fromPoll = false) {
    if (!active || !authenticated || paused || running || isHidden()) return null
    running = true
    const controller = createAbortController()
    inFlight = controller
    try {
      const next = await readView({ signal: controller.signal })
      if (!active || paused || controller.signal.aborted || isHidden()) return null
      failures = 0
      onView(next)
      return next
    } catch (error) {
      if (ignoredAbort(controller, error)) return null
      if (error?.status === 401) {
        authenticated = false
        onUnauthorized(error)
        return null
      }
      if (active && !paused && !isHidden()) {
        failures = Math.min(failures + 1, 5)
        onError(error)
      }
      return null
    } finally {
      if (inFlight === controller) inFlight = null
      running = false
      if (active && authenticated && !paused && !isHidden()) schedule(Math.min(12_000, 1_000 * (2 ** failures)))
    }
  }

  return {
    activate() { active = true; authenticated = true; paused = false },
    refresh,
    pause() { paused = true; clearScheduled(); cancelInFlight() },
    resume() { paused = false; if (active && authenticated) schedule(0) },
    stop() { active = false; paused = true; clearScheduled(); cancelInFlight() },
    isAuthenticated() { return authenticated },
  }
}
