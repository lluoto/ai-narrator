<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ownerFetch } from './owner-auth.js'

const emit = defineEmits(['close'])
const modules = ref([])
const loading = ref(false)
const editing = ref(null)
const saving = ref(false)
const msg = ref('')

const BASE = '/api'

async function loadModules() {
  loading.value = true
  try {
    const res = await ownerFetch(`${BASE}/modules`)
    if (!res.ok) throw new Error('Unable to load modules')
    modules.value = (await res.json()).modules || []
  } catch {
    modules.value = []
    msg.value = '✗ Unable to load modules'
  } finally { loading.value = false }
}

onMounted(loadModules)

function newModule() {
  editing.value = reactive({
    id: '', name: '', version: '1.0', description: '',
    difficulty: 'medium', source: '',
    activation: { type: 'manual', condition: '' },
    scenes: [], characters: [], clues: [], items: [], spells: [], creatures: [],
  })
}

async function editModule(mod) {
  msg.value = ''
  try {
    const res = await ownerFetch(`${BASE}/modules/${mod.id}`)
    if (!res.ok) throw new Error('Unable to load module')
    const data = await res.json()
    editing.value = reactive(data.module)
  } catch {
    msg.value = '✗ Unable to load module'
  }
}

async function saveModule() {
  saving.value = true; msg.value = ''
  try {
    const res = await ownerFetch(`${BASE}/modules`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editing.value),
    })
    if (!res.ok) throw new Error('Unable to save module')
    msg.value = '✓ 保存成功'
    editing.value = null
    loadModules()
  } catch { msg.value = '✗ Unable to save module' }
  finally { saving.value = false }
}

function addScene() {
  if (!editing.value.scenes) editing.value.scenes = []
  editing.value.scenes.push({ id: `scene_${Date.now()}`, name: '', description: '', lighting: 'normal', dangers: [], exits: [] })
}
function removeScene(i) { editing.value.scenes.splice(i, 1) }

function addClue() {
  if (!editing.value.clues) editing.value.clues = []
  editing.value.clues.push({ id: `clue_${Date.now()}`, description: '', scene: '', san_cost: 0 })
}
function removeClue(i) { editing.value.clues.splice(i, 1) }

async function deleteModule(id) {
  if (!confirm('确认删除？')) return
  try {
    const res = await ownerFetch(`${BASE}/modules/${id}`, { method: 'DELETE' })
    if (!res.ok) throw new Error('Unable to delete module')
    await loadModules()
  } catch {
    msg.value = '✗ Unable to delete module'
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="me-overlay" @click.self="emit('close')">
      <div class="me-panel" @click.stop>
        <div class="me-header">
          <h2>📦 模组编辑器</h2>
          <button class="me-close" @click="emit('close')">✕</button>
        </div>

        <div v-if="!editing" class="me-body">
          <button class="me-btn me-btn--primary" @click="newModule">+ 新建模组</button>
          <div v-if="loading" class="me-loading">加载中…</div>
          <div v-for="m in modules" :key="m.id" class="me-card">
            <div class="me-card__info"><strong>{{ m.name }}</strong><span class="me-tag">{{ m.difficulty }}</span><p class="me-desc">{{ m.description }}</p></div>
            <div class="me-card__actions">
              <button class="me-btn" @click="editModule(m)">编辑</button>
              <button class="me-btn me-btn--danger" @click="deleteModule(m.id)">删除</button>
            </div>
          </div>
          <div v-if="!loading && modules.length === 0" class="me-empty">暂无模组</div>
        </div>

        <div v-if="editing" class="me-body">
          <div class="me-field"><label>ID</label><input v-model="editing.id" class="me-input" placeholder="唯一标识" /></div>
          <div class="me-field"><label>名称</label><input v-model="editing.name" class="me-input" placeholder="模组名称" /></div>
          <div class="me-field"><label>描述</label><textarea v-model="editing.description" class="me-textarea" rows="2"></textarea></div>
          <div class="me-field me-field--row">
            <label>难度</label>
            <select v-model="editing.difficulty" class="me-select">
              <option value="easy">简单</option>
              <option value="medium">标准</option>
              <option value="hard">困难</option>
              <option value="nightmare">噩梦</option>
            </select>
            <label>版本</label>
            <input v-model="editing.version" class="me-input me-input--sm" />
          </div>

          <h4 class="me-subhead">场景 ({{ editing.scenes?.length ?? 0 }})</h4>
          <div v-for="(s, i) in editing.scenes" :key="i" class="me-sub-card">
            <input v-model="s.name" class="me-input me-input--grow" placeholder="场景名" />
            <button class="me-btn me-btn--sm me-btn--danger" @click="removeScene(i)">✕</button>
          </div>
          <button class="me-btn me-btn--sm" @click="addScene">+ 场景</button>

          <h4 class="me-subhead">线索 ({{ editing.clues?.length ?? 0 }})</h4>
          <div v-for="(c, i) in editing.clues" :key="i" class="me-sub-card">
            <input v-model="c.description" class="me-input me-input--grow" placeholder="线索描述" />
            <button class="me-btn me-btn--sm me-btn--danger" @click="removeClue(i)">✕</button>
          </div>
          <button class="me-btn me-btn--sm" @click="addClue">+ 线索</button>

          <div class="me-actions">
            <span v-if="msg" class="me-msg" :class="{ 'me-msg--ok': msg.startsWith('✓') }">{{ msg }}</span>
            <button class="me-btn" @click="editing = null">取消</button>
            <button class="me-btn me-btn--primary" :disabled="saving" @click="saveModule">保存</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.me-overlay { position: fixed; inset: 0; z-index: 9000; background: rgba(0,0,0,0.7); display: flex; justify-content: center; align-items: flex-start; padding-top: 4vh; }
.me-panel { width: min(640px, 95vw); max-height: 88vh; background: #1a1a2e; border: 1px solid #3a3a5c; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; color: #e0e0e0; font-size: 13px; }
.me-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #2a2a4a; background: #141428; }
.me-header h2 { font-size: 15px; font-weight: 600; color: #c9a96e; margin: 0; }
.me-close { background: transparent; border: 1px solid #3a3a5c; color: #888; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.me-close:hover { color: #fff; border-color: #666; }
.me-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
.me-loading, .me-empty { padding: 24px; text-align: center; color: #666; }
.me-card { display: flex; justify-content: space-between; align-items: flex-start; background: #1e1e3a; border: 1px solid #2a2a4a; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
.me-card__info { flex: 1; }
.me-card__info strong { color: #c9a96e; }
.me-tag { font-size: 10px; padding: 1px 6px; background: #2a2a4a; border-radius: 4px; margin-left: 6px; color: #aaa; }
.me-desc { font-size: 11px; color: #777; margin: 4px 0 0; }
.me-card__actions { display: flex; gap: 4px; margin-left: 8px; }
.me-field { margin-bottom: 8px; }
.me-field label { display: block; font-size: 11px; color: #888; margin-bottom: 2px; }
.me-field--row { display: flex; gap: 8px; align-items: center; }
.me-field--row label { margin-bottom: 0; white-space: nowrap; }
.me-input, .me-textarea, .me-select { width: 100%; padding: 6px 8px; border: 1px solid #3a3a5c; border-radius: 6px; background: #141428; color: #e0e0e0; font-size: 12px; outline: none; box-sizing: border-box; }
.me-input:focus { border-color: #c9a96e; }
.me-input--sm { width: 80px; }
.me-input--grow { flex: 1; }
.me-textarea { resize: vertical; }
.me-select { cursor: pointer; }
.me-btn { padding: 5px 12px; border: 1px solid #3a3a5c; border-radius: 6px; background: #2a2a4a; color: #ccc; font-size: 12px; cursor: pointer; margin-right: 4px; }
.me-btn:hover { background: #3a3a5c; color: #fff; }
.me-btn--primary { background: #3a3a20; border-color: #c9a96e; color: #c9a96e; }
.me-btn--danger:hover { background: #5a2020; border-color: #ff6b6b; color: #ff6b6b; }
.me-btn--sm { padding: 3px 8px; font-size: 11px; }
.me-subhead { font-size: 12px; color: #c9a96e; margin: 12px 0 6px; }
.me-sub-card { display: flex; gap: 4px; margin-bottom: 4px; }
.me-actions { display: flex; gap: 8px; align-items: center; margin-top: 16px; padding-top: 12px; border-top: 1px solid #2a2a4a; }
.me-msg { font-size: 12px; flex: 1; }
.me-msg--ok { color: #6bcf6b; }
.me-msg:not(.me-msg--ok) { color: #ff6b6b; }
@media (max-width: 480px) { .me-panel { width: 100vw; max-height: 100vh; border-radius: 0; } .me-body { padding: 8px 10px; } }
</style>
