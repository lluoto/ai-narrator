import { createApp } from 'vue'
import { isPlayerNamespacePath } from './player-lifecycle.js'

// /play is a sealed player façade, never a visual fallback to the owner/KP
// client (which imports generic session, compiler, and management APIs).
const playerNamespace = isPlayerNamespacePath(window.location.pathname)
async function mount() {
  const Component = playerNamespace
    ? (await import('./PlayerApp.vue')).default
    : (await import('./App.vue')).default
  createApp(Component).mount('#app')
}
void mount()
