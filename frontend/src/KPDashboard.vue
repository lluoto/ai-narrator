<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  sessionId: { type: String, required: true },
  sessionKind: { type: String, default: '' },
  ordinaryGeneration: { type: Number, default: null },
  pendingKind: { type: String, default: null },
  busy: { type: Boolean, default: false },
  terminal: { type: [Object, Boolean], default: null },
})

const emit = defineEmits(['close', 'ordinary-message'])
const msgText = ref('')
const msgSpeaker = ref('守秘人')
const isOrdinary = computed(() => props.sessionKind === 'ordinary')
const ordinaryAnnouncementDisabled = computed(() => !isOrdinary.value
  || !props.sessionId
  || !Number.isSafeInteger(props.ordinaryGeneration)
  || props.ordinaryGeneration < 0
  || props.busy
  || !!props.pendingKind
  || props.terminal !== null)

function sendOrdinaryMessage() {
  if (ordinaryAnnouncementDisabled.value || !msgText.value.trim()) return
  // App owns persistence, retry, and authoritative owner-GET reconciliation.
  // This presentation component has no mutation transport of its own.
  emit('ordinary-message', { speaker: msgSpeaker.value, content: msgText.value, type: 'system' })
}
</script>

<template>
  <Teleport to="body">
    <div class="kp-overlay" @click.self="emit('close')">
      <div class="kp-panel" @click.stop>
        <header class="kp-panel__header">
          <h2 class="kp-panel__title">KP announcement</h2>
          <button class="kp-panel__close" @click="emit('close')" aria-label="Close">✕</button>
        </header>

        <section v-if="isOrdinary" class="ordinary-kp-announcement">
          <p class="ordinary-kp-announcement__hint">Publish a durable announcement to the current ordinary session.</p>
          <form class="kp-action-block" @submit.prevent="sendOrdinaryMessage">
            <label class="ordinary-kp-announcement__label" for="ordinary-kp-speaker">Speaker</label>
            <div class="kp-form-row">
              <input id="ordinary-kp-speaker" v-model="msgSpeaker" class="kp-input kp-input--sm" maxlength="128" :disabled="ordinaryAnnouncementDisabled" />
              <input id="ordinary-kp-content" v-model="msgText" class="kp-input kp-input--grow" maxlength="8000" :disabled="ordinaryAnnouncementDisabled" required />
              <button class="kp-btn" type="submit" :disabled="ordinaryAnnouncementDisabled || !msgText.trim()">Send announcement</button>
            </div>
          </form>
          <p v-if="pendingKind" class="ordinary-kp-announcement__pending" role="status">A durable ordinary operation is awaiting confirmation.</p>
        </section>

        <section v-else class="ordinary-kp-unavailable" role="status">
          KP announcements are available only for ordinary sessions.
        </section>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.kp-overlay { position: fixed; inset: 0; z-index: 9000; display: flex; justify-content: center; align-items: flex-start; padding-top: 4vh; background: rgba(0, 0, 0, 0.7); }
.kp-panel { width: min(680px, 95vw); overflow: hidden; border: 1px solid #3a3a5c; border-radius: 12px; background: #1a1a2e; color: #e0e0e0; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6); }
.kp-panel__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #2a2a4a; background: #141428; }
.kp-panel__title { margin: 0; color: #c9a96e; font-size: 15px; font-weight: 600; }
.kp-panel__close { border: 1px solid #3a3a5c; border-radius: 6px; padding: 4px 10px; background: transparent; color: #888; cursor: pointer; }
.ordinary-kp-announcement, .ordinary-kp-unavailable { padding: 16px; }
.ordinary-kp-announcement__hint, .ordinary-kp-unavailable, .ordinary-kp-announcement__pending { margin: 0 0 12px; color: #aaa; font-size: 12px; line-height: 1.5; }
.ordinary-kp-announcement__label { display: block; margin-bottom: 6px; color: #c9a96e; font-size: 12px; }
.kp-action-block { padding: 10px 12px; border: 1px solid #2a2a4a; border-radius: 8px; background: #1e1e3a; }
.kp-form-row { display: flex; align-items: center; gap: 6px; }
.kp-input { border: 1px solid #3a3a5c; border-radius: 6px; padding: 5px 8px; background: #141428; color: #e0e0e0; font-size: 12px; }
.kp-input--sm { width: 100px; }
.kp-input--grow { flex: 1; }
.kp-btn { border: 1px solid #3a3a5c; border-radius: 6px; padding: 5px 12px; background: #2a2a4a; color: #ccc; cursor: pointer; white-space: nowrap; }
.kp-btn:disabled, .kp-input:disabled { cursor: default; opacity: 0.45; }
@media (max-width: 480px) { .kp-panel { width: 100vw; border-radius: 0; } .kp-form-row { flex-wrap: wrap; } .kp-input--grow { min-width: 100%; } }
</style>
