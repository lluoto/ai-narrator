<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  claimPlayerInvitation,
  getPlayerFacadeView,
  isSafePlayerFacadeSessionId,
  resolvePlayerFacadeIntent,
  retryPendingPlayerFacadeAction,
  securePlayerClaimId,
  sendPlayerFacadeAction,
  sendPlayerFollowup,
  retryPendingPlayerFollowup,
} from './player-api.js'
import { createPlayerFacadePolling, createPlayerInvitationClaim } from './player-lifecycle.js'

const view = ref(null)
const error = ref('')
const loading = ref(true)
const actionPending = ref(false)
const intentInput = ref('')
const intentChoices = ref([])
// Raw player prose is intentionally in-memory only. It accompanies the first
// v2 action request and is never included in localStorage retry state.
const intentTopic = ref(null)
const followupInput = ref('')
const followupContact = ref(null)
// One confirmed exchange supplies only an opaque locator to the next request.
// Its visible reply stays in this component, never in browser retry storage.
const followupTurn = ref(null)

function routeSessionId() {
  const match = /^\/play\/([^/]+)$/.exec(window.location.pathname)
  if (!match) return ''
  try {
    const decoded = decodeURIComponent(match[1])
    return isSafePlayerFacadeSessionId(decoded) ? decoded : ''
  } catch { return '' }
}

const sessionId = routeSessionId()
const claimRetryAvailable = ref(false)
let componentActive = false

function sameFollowupScope(turn) {
  return !!turn && turn.sessionId === sessionId && turn.expectedGeneration === view.value?.generation
    && !view.value?.terminal && turn.contactToken === followupContact.value?.contactToken
    && !!view.value?.presentation?.contacts?.some(contact => contact.contactToken === turn.contactToken)
}

watch([view, followupContact], () => {
  if (followupTurn.value && !sameFollowupScope(followupTurn.value)) followupTurn.value = null
}, { flush: 'sync' })

function clearIntentChoices() {
  intentChoices.value = []
  intentTopic.value = null
}

watch([intentInput, () => view.value?.generation, () => view.value?.terminal], () => {
  const topic = intentTopic.value
  if (topic && (intentInput.value !== topic.playerInput || view.value?.generation !== topic.expectedGeneration || view.value?.terminal)) {
    clearIntentChoices()
  }
}, { flush: 'sync' })

function sessionStorageOrNull() {
  try { return window.sessionStorage } catch { return null }
}

const invitationClaim = createPlayerInvitationClaim({
  sessionId,
  storage: sessionStorageOrNull(),
  createClaimId: securePlayerClaimId,
  claim: ({ invite, claimId }) => claimPlayerInvitation(sessionId, { invite, claimId }),
})

const playerPoller = createPlayerFacadePolling({
  readView: ({ signal }) => getPlayerFacadeView(sessionId, { signal }),
  onView: (next) => {
    if (!componentActive) return
    view.value = next
    clearIntentChoices()
    if (followupContact.value && (next?.terminal || !next?.presentation?.contacts?.some(contact => contact.contactToken === followupContact.value.contactToken))) {
      followupContact.value = null
      followupInput.value = ''
    }
    error.value = ''
  },
  onError: (cause) => {
    if (componentActive) error.value = cause?.message || 'Unable to refresh the player view.'
  },
  onUnauthorized: (cause) => {
    if (componentActive) error.value = cause?.message || 'Open the invitation link to start playing.'
  },
})

async function claimFragmentInvite() {
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  const invite = fragment.get('invite') || ''
  if (!invite) return
  // Hash fragments never reach HTTP. Clear it before the first fetch so it
  // cannot leak through later navigation or referrer construction.
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  try {
    await invitationClaim.claimInvite(invite)
  } finally {
    claimRetryAvailable.value = invitationClaim.hasRetry()
  }
}

async function retryClaim() {
  if (!invitationClaim.hasRetry()) return
  loading.value = true
  try {
    await invitationClaim.retry()
    claimRetryAvailable.value = false
    await playerPoller.refresh()
  } catch (cause) {
    error.value = cause?.message || 'Invitation claim failed.'
    claimRetryAvailable.value = invitationClaim.hasRetry()
  } finally {
    if (componentActive) loading.value = false
  }
}

async function choose(action, expectedGeneration = view.value?.generation, topic) {
  if (actionPending.value || !view.value) return
  actionPending.value = true
  error.value = ''
  clearIntentChoices()
  // An already-issued GET may contain the prior generation. Abort it before
  // the durable POST so a late response cannot overwrite the committed view.
  playerPoller.pause()
  try {
    const result = await sendPlayerFacadeAction(sessionId, {
      choiceId: action.choiceId,
      expectedGeneration,
      ...(topic ? { topicBound: topic.topicBound, playerInput: topic.playerInput } : {}),
    })
    if (result.kind === 'topic-required') {
      error.value = 'Please enter your action again before retrying this request.'
      return
    }
    if (componentActive) view.value = result.kind === 'conflict' ? result.view : result.data.view
  } catch (cause) {
    error.value = cause?.message || 'Action request failed; the same action will be retried.'
  } finally {
    actionPending.value = false
    playerPoller.resume()
  }
}

async function chooseIntent(action) {
  if (actionPending.value || !view.value) return
  const topic = intentTopic.value
  if (!topic || view.value.terminal || topic.expectedGeneration !== view.value.generation
    || topic.playerInput !== intentInput.value || !intentChoices.value.some(candidate => candidate.choiceId === action.choiceId)) {
    clearIntentChoices()
    error.value = 'The matching actions changed. Please interpret your action again.'
    return
  }
  await choose(action, topic.expectedGeneration, topic)
}

async function refreshAfterIntentConflict() {
  const next = await getPlayerFacadeView(sessionId)
  if (componentActive) view.value = next
}

async function submitIntent() {
  if (actionPending.value || !view.value || view.value.terminal || !intentInput.value.trim()) return
  actionPending.value = true
  error.value = ''
  clearIntentChoices()
  // Capture before any branch clears the field. This value is request-scoped
  // only; pending browser state keeps an opaque topic token instead.
  const capturedTopic = intentInput.value
  const expectedGeneration = view.value.generation
  playerPoller.pause()
  try {
    const result = await resolvePlayerFacadeIntent(sessionId, {
      input: capturedTopic,
      expectedGeneration,
    })
    if (result.status === 'selected') {
      intentInput.value = ''
      actionPending.value = false
      playerPoller.resume()
      await choose(result.action, result.generation, { topicBound: result.topicBound, playerInput: capturedTopic })
      return
    }
    if (result.status === 'ambiguous') {
      if (!componentActive || view.value?.terminal || view.value?.generation !== expectedGeneration
        || result.generation !== expectedGeneration || intentInput.value !== capturedTopic) {
        error.value = 'The matching actions changed. Please interpret your action again.'
        return
      }
      intentTopic.value = { playerInput: capturedTopic, topicBound: result.topicBound, expectedGeneration: result.generation }
      intentChoices.value = result.actions
      error.value = 'Please choose one of the matching actions.'
      return
    }
    error.value = 'I could not match that request to an available action. Please choose an option.'
  } catch (cause) {
    if (cause?.status === 409) {
      error.value = 'The available actions changed. Refreshing the current view.'
      try {
        await refreshAfterIntentConflict()
      } catch {
        error.value = 'The available actions changed. Please refresh and try again.'
      }
    } else if (cause?.status === 503) {
      error.value = 'Intent understanding is unavailable right now. Please choose an action.'
    } else if (cause?.status === 422) {
      error.value = 'I could not understand that request safely. Please choose an action.'
    } else {
      error.value = cause?.message || 'Intent request failed. Please choose an action.'
    }
  } finally {
    if (actionPending.value) {
      actionPending.value = false
      playerPoller.resume()
    }
  }
}

async function submitFollowup() {
  if (actionPending.value || !view.value || view.value.terminal || !followupContact.value || !followupInput.value.trim()) return
  actionPending.value = true
  error.value = ''
  playerPoller.pause()
  const input = followupInput.value
  const contact = followupContact.value
  const expectedGeneration = view.value.generation
  try {
    const result = await sendPlayerFollowup(sessionId, {
      contactToken: contact.contactToken,
      expectedGeneration,
      playerInput: input,
      ...(sameFollowupScope(followupTurn.value) ? { previousActionId: followupTurn.value.actionId } : {}),
    })
    if (result.kind === 'input-required') {
      error.value = 'Please re-enter your question before retrying this contact.'
      return
    }
    if (!componentActive) return
    view.value = result.kind === 'conflict' ? result.view : result.data.view
    if (result.kind === 'conflict') followupContact.value = null
    else {
      followupInput.value = ''
      const confirmed = { sessionId, expectedGeneration, contactToken: contact.contactToken, actionId: result.actionId, name: contact.name, text: result.data.followup.text }
      if (sameFollowupScope(confirmed)) followupTurn.value = confirmed
    }
  } catch (cause) {
    error.value = cause?.message || 'Contact follow-up is unavailable.'
  } finally {
    actionPending.value = false
    playerPoller.resume()
  }
}

function visibilityChanged() {
  if (document.hidden) playerPoller.pause()
  else playerPoller.resume()
}

onMounted(async () => {
  componentActive = true
  if (!sessionId) {
    error.value = 'Player session link is invalid.'
    loading.value = false
    return
  }
  playerPoller.activate()
  document.addEventListener('visibilitychange', visibilityChanged)
  try {
    await claimFragmentInvite()
    if (!componentActive) return
    const recovered = await retryPendingPlayerFacadeAction(sessionId)
    if (!componentActive) return
    if (recovered?.kind === 'topic-required') {
      error.value = 'Please enter your action again before retrying this request.'
    } else if (recovered) {
      view.value = recovered.kind === 'conflict' ? recovered.view : recovered.data.view
    }
    const recoveredFollowup = await retryPendingPlayerFollowup(sessionId)
    if (!componentActive) return
    if (recoveredFollowup?.kind === 'input-required') {
      error.value = 'Please re-enter your question before retrying this contact.'
    } else if (recoveredFollowup?.kind === 'conflict') {
      view.value = recoveredFollowup.view
      followupContact.value = null
    }
    await playerPoller.refresh()
  } catch (cause) {
    if (componentActive) error.value = cause?.message || 'Open the invitation link to start playing.'
  } finally {
    if (componentActive) loading.value = false
  }
})

onBeforeUnmount(() => {
  componentActive = false
  clearIntentChoices()
  followupTurn.value = null
  playerPoller.stop()
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <main class="player-app">
    <section class="player-panel">
      <p class="eyebrow">Player session</p>
      <h1>{{ view?.character?.name || 'Your investigator' }}</h1>
      <p v-if="loading" class="muted">Connecting…</p>
      <p v-if="error" class="error">{{ error }}</p>
      <button v-if="claimRetryAvailable" class="retry" @click="retryClaim">Retry invitation claim</button>

      <template v-if="view">
        <div class="stats">
          <span>HP {{ view.character.hp }}/{{ view.character.maxHp }}</span>
          <span>SAN {{ view.sanity.currentSAN }}/{{ view.sanity.maxSAN }}</span>
          <span>Round {{ view.round }}</span>
        </div>
        <section v-if="view.presentation" class="presentation" aria-label="Current story">
          <h2>{{ view.presentation.scene.name }}</h2>
          <p>{{ view.presentation.scene.description }}</p>
          <section v-if="view.presentation.clues.length" class="clues" aria-label="Discovered clues">
            <h3>Discovered clues</h3>
            <dl>
              <div v-for="(clue, index) in view.presentation.clues" :key="`${clue.name}-${index}`">
                <dt>{{ clue.name }}</dt>
                <dd>{{ clue.revelation }}</dd>
              </div>
            </dl>
          </section>
          <section v-if="view.presentation.contacts?.length" class="contacts" aria-label="Available contacts">
            <h3>Contacts</h3>
            <ul>
              <li v-for="(contact, index) in view.presentation.contacts" :key="index">
                <button v-if="contact.contactToken" type="button" :disabled="actionPending || view.terminal" @click="followupContact = contact">{{ contact.name }}</button>
                <span v-else>{{ contact.name }}</span>
              </li>
            </ul>
            <form v-if="followupContact && !view.terminal" class="intent" @submit.prevent="submitFollowup">
              <label for="player-followup">Ask {{ followupContact.name }}</label>
              <div class="intent-row">
                <input id="player-followup" v-model="followupInput" :disabled="actionPending || view.terminal" maxlength="1000" autocomplete="off" placeholder="Ask about the discovered clue" />
                <button type="submit" :disabled="actionPending || view.terminal || !followupInput.trim()">Ask</button>
              </div>
            </form>
            <section v-if="followupTurn" class="turn" aria-label="Latest contact reply">
              <h3>{{ followupTurn.name }}</h3>
              <p>{{ followupTurn.text }}</p>
            </section>
          </section>
          <section v-if="view.presentation.ending" class="ending" aria-label="Selected ending">
            <h3>{{ view.presentation.ending.name }}</h3>
            <p>{{ view.presentation.ending.description }}</p>
          </section>
        </section>
        <section v-if="view.turn?.text" class="turn" aria-label="Latest turn">
          <h2>Latest turn</h2>
          <p>{{ view.turn.text }}</p>
        </section>
        <p v-if="view.terminal" class="muted">This session has ended.</p>
        <form class="intent" @submit.prevent="submitIntent">
          <label for="player-intent">What do you want to do?</label>
          <div class="intent-row">
            <input id="player-intent" v-model="intentInput" :disabled="actionPending || view.terminal" maxlength="1000" autocomplete="off" placeholder="Describe your action" />
            <button type="submit" :disabled="actionPending || view.terminal || !intentInput.trim()">Interpret</button>
          </div>
        </form>
        <div v-if="intentChoices.length" class="actions" aria-label="Matching actions">
          <p class="muted">Choose a matching action:</p>
          <button v-for="action in intentChoices" :key="action.choiceId" :disabled="actionPending || view.terminal" @click="chooseIntent(action)">
            {{ action.label }}<small v-if="action.check">{{ action.check.difficulty }} check</small>
          </button>
        </div>
        <div class="actions" aria-label="Available actions">
          <button v-for="action in view.actions" :key="action.choiceId" :disabled="actionPending || view.terminal" @click="choose(action)">
            {{ action.label }}<small v-if="action.check">{{ action.check.difficulty }} check</small>
          </button>
        </div>
      </template>
    </section>
  </main>
</template>

<style scoped>
.player-app { min-height: 100dvh; display: grid; place-items: center; padding: 20px; background: #0b1210; color: #d8e4dd; font-family: system-ui, sans-serif; }
.player-panel { width: min(100%, 540px); padding: 28px; border: 1px solid #294338; border-radius: 12px; background: #111b17; }
.eyebrow, .muted { color: #a8b8af; } .eyebrow { margin: 0 0 6px; text-transform: uppercase; font-size: .75rem; letter-spacing: .08em; }
h1 { margin: 0 0 16px; } .stats { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; color: #a6cfb8; }
.presentation, .turn { margin-top: 18px; padding: 14px; border: 1px solid #294338; border-radius: 8px; background: #0d1713; } .presentation h2, .turn h2, .presentation h3 { margin: 0 0 8px; } .presentation p, .turn p, .presentation dd { margin: 0; white-space: pre-wrap; } .clues, .contacts, .ending { margin-top: 14px; } .clues dl { display: grid; gap: 10px; margin: 0; } .clues dt { font-weight: 700; } .clues dd { margin: 3px 0 0; color: #c0d4c7; } .contacts ul { margin: 0; padding-left: 20px; }
.actions, .intent { display: grid; gap: 10px; margin-top: 14px; } .intent label { color: #a8b8af; font-size: .9rem; } .intent-row { display: flex; gap: 8px; } .intent input { min-width: 0; flex: 1; padding: 10px 12px; border: 1px solid #78a990; border-radius: 8px; background: #0b1210; color: #d8e4dd; } button { min-height: 44px; padding: 10px 14px; border: 1px solid #78a990; border-radius: 8px; background: #16231d; color: #d8e4dd; cursor: pointer; text-align: left; }
button:disabled { opacity: .5; cursor: default; } button small { display: block; color: #a8b8af; margin-top: 3px; }.error { color: #ff9b9b; }.retry { margin: 0 0 14px; }
</style>
