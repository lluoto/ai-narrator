<script setup>
import { ref, onMounted } from 'vue'
import { ownerFetch } from './owner-auth.js'
const emit = defineEmits(['close'])
const config = ref(null)
const loading = ref(true)
const loadError = ref('')
onMounted(async () => {
  try {
    const res = await ownerFetch('/api/config')
    if (!res.ok) throw new Error('Unable to load server settings')
    config.value = await res.json()
  } catch {
    config.value = null
    loadError.value = 'Unable to load server settings.'
  }
  finally { loading.value = false }
})
</script>
<template>
  <Teleport to="body">
    <div class="sp-overlay" @click.self="emit('close')">
      <div class="sp-panel" @click.stop>
        <div class="sp-header">
          <h2>⚙️ 服务器设置</h2>
          <button class="sp-close" @click="emit('close')">✕</button>
        </div>
        <div class="sp-body">
          <div v-if="loading" class="sp-loading">加载中…</div>
          <div v-else-if="loadError" class="sp-loading">{{ loadError }}</div>
          <template v-if="config">
            <section class="sp-section">
              <h4>LLM 配置</h4>
              <div class="sp-row"><span>接口</span><span class="sp-mono">{{ config.llm.baseUrl }}</span></div>
              <div class="sp-row"><span>模型</span><span class="sp-mono">{{ config.llm.model }}</span></div>
              <div class="sp-row"><span>最大Token</span><span>{{ config.llm.maxTokens }}</span></div>
              <div class="sp-row"><span>温度</span><span>{{ config.llm.temperature }}</span></div>
              <div class="sp-row"><span>API Key</span><span :class="config.llm.hasKey ? 'sp-ok' : 'sp-err'">{{ config.llm.hasKey ? '已配置' : '未配置' }}</span></div>
            </section>
            <section class="sp-section">
              <h4>服务器</h4>
              <div class="sp-row"><span>端口</span><span>{{ config.server.port }}</span></div>
              <div class="sp-row"><span>环境</span><span>{{ config.server.env }}</span></div>
              <div class="sp-row"><span>Session超时</span><span>{{ config.server.sessionTimeoutMinutes }}分钟</span></div>
              <div class="sp-row"><span>活跃会话</span><span>{{ config.sessionCount }}</span></div>
            </section>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
<style scoped>
.sp-overlay { position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,0.7); display: flex; justify-content: center; align-items: flex-start; padding-top: 6vh; }
.sp-panel { width: min(440px, 92vw); max-height: 80vh; background: #1a1a2e; border: 1px solid #3a3a5c; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; color: #e0e0e0; font-size: 13px; }
.sp-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #2a2a4a; background: #141428; }
.sp-header h2 { font-size: 14px; color: #c9a96e; margin: 0; }
.sp-close { background: transparent; border: 1px solid #3a3a5c; color: #888; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.sp-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
.sp-loading { text-align: center; color: #888; padding: 24px; }
.sp-section { margin-bottom: 16px; }
.sp-section h4 { font-size: 12px; color: #c9a96e; margin: 0 0 8px; border-bottom: 1px solid #2a2a4a; padding-bottom: 4px; }
.sp-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }
.sp-row span:first-child { color: #888; }
.sp-mono { font-family: monospace; color: #aaa; font-size: 11px; }
.sp-ok { color: #6bcf6b; }
.sp-err { color: #ff6b6b; }
@media (max-width: 480px) { .sp-panel { width: 100vw; max-height: 100vh; border-radius: 0; } .sp-body { padding: 8px 10px; } }
</style>
