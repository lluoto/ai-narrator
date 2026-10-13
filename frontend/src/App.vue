<script setup>
import { ref, reactive, computed, watch, nextTick } from 'vue'
import { createSession, sendSessionAction, retryPendingCompiledAction, retryPendingOrdinaryAction, pendingOrdinaryActionKind, compiledSessionGeneration, ordinarySessionGeneration, isAuthoritativeOrdinaryCharacter, getArchetypes, getSuggestions, getCompiledActions, getHistory, listSessions, getSession, getCharacter, luckSpend, partyMemberCreate, characterPatch, ordinaryKpMessage } from './api.js'
import { ordinaryLuckFromAuthoritativeState, ordinaryLuckFromCreateResponse, ordinaryLuckSpendOutcome, ordinaryLuckSpendRequest, ordinaryLuckSpendVisible, submitOrdinaryLuckSpend } from './ordinary-luck-spend-controller.js'
import { ordinaryPartyMemberCreateOutcome, ordinaryPartyMemberCreateRequest, ordinaryPartyMemberCreateVisible, ordinaryPendingKindFromDurableStorage, submitOrdinaryPartyMemberCreate } from './ordinary-party-member-create-controller.js'
import { ordinaryCharacterEditorVisible, ordinaryCharacterPatchOutcome, ordinaryCharacterPatchRequest, submitOrdinaryCharacterPatch } from './ordinary-character-patch-controller.js'
import { clearOwnerBearer, ownerFetch, setOwnerBearer } from './owner-auth.js'
import KPDashboard from './KPDashboard.vue'
import CombatGrid from './CombatGrid.vue'
import ModuleEditor from './ModuleEditor.vue'
import CharacterEditor from './CharacterEditor.vue'
import SceneOverview from './SceneOverview.vue'
import SettingsPanel from './SettingsPanel.vue'

// State
const screen = ref('start')
const loading = ref(false)
const error = ref(null)
const ownerCredential = ref('')
const ownerAuthenticated = ref(false)
const ownerAuthPending = ref(false)
const ownerAuthError = ref('')
const loadingSessions = ref(false)
const savedSessions = ref([])
const characterName = ref('')
const archetypes = ref([])
const selectedArchetype = ref('')
const archetypeLoading = ref(false)
const selectedRuleset = ref('cosmic-horror')
const rulesetName = computed(() => selectedRuleset.value === 'cosmic-horror' ? '宇宙恐怖（百分位）' : selectedRuleset.value === 'dnd5e' ? '龙与地下城 5 版' : selectedRuleset.value)

const session = reactive({
  id: '', round: 0, scene: '', playerName: '', archetype: '',
  ruleset: '', hp: 0, maxHp: 0, san: 0, maxSAN: 0,
  tempInsanity: false, indefInsanity: false, dead: false, terminal: null,
  luck: null, creditRating: 0, skills: {}, inventory: [], weapons: [], attributes: {},
  bgm: '', sessionKind: '', ordinaryGeneration: null, compiledGeneration: null,
})
// session.archetype 存的是职业 id（investigator），状态栏要显示中文名。
// 职业表没加载到（例如直接恢复旧会话）时退回显示 id，而不是显示空白。
const archetypeLabel = computed(() => {
  const found = archetypes.value.find(a => a.id === session.archetype)
  return found?.label || session.archetype
})
// 世界状态在还没有激活场景时返回哨兵字符串 "unknown"。
// 它是后端内部用来判断"未定场景"的值，不该原样显示给玩家，
// 而 ?? 兜底对非空字符串不生效，所以这里显式处理。
const SCENE_UNSET = 'unknown'
const sceneLabel = computed(() => (!session.scene || session.scene === SCENE_UNSET ? '序幕' : session.scene))

// ── 环境音 ────────────────────────────────────────────────────────
// 后端给的是空间性质标识（town / dread 之类），不是每个房间一首曲子。
// 三条硬性约束：音频缺失要静默、浏览器拦截自动播放要静默、音量压在叙事之下。
// 环境音任何情况下都不该挡住或打断叙事流程。
const BGM_VOLUME = 0.35
const bgmMuted = ref(true) // 默认关：未经用户交互的自动播放会被浏览器拒绝
let bgmEl = null
let bgmTimer = null
let bgmId = ''  // 当前已装载的床标识，换床判断以它为准而不是比对 src 字符串
let bgmExt = ''

function fadeTo(el, target, done) {
  clearInterval(bgmTimer)
  bgmTimer = setInterval(() => {
    const step = target > el.volume ? 0.05 : -0.05
    const next = el.volume + step
    if ((step > 0 && next >= target) || (step < 0 && next <= target)) {
      el.volume = target
      clearInterval(bgmTimer)
      if (done) done()
    } else {
      el.volume = Math.max(0, Math.min(1, next))
    }
  }, 50)
}

// 先 mp3 后 wav：正式素材一般是 mp3，scripts/gen-bgm.ts 产出的占位母版是 wav。
// 两种都取不到才当作该场景没有环境音。
function loadBgm(id, ext) {
  bgmId = id
  bgmExt = ext
  bgmEl.src = `/bgm/${id}.${ext}`
  bgmEl.play().then(() => fadeTo(bgmEl, BGM_VOLUME)).catch(() => {})
}

function applyBgm(id) {
  if (!bgmEl) {
    bgmEl = new Audio()
    bgmEl.loop = true
    bgmEl.volume = 0
    // 没有对应音频文件时不报错、不提示，视作该场景无环境音
    bgmEl.addEventListener('error', () => {
      clearInterval(bgmTimer)
      if (bgmId && bgmExt === 'mp3') loadBgm(bgmId, 'wav')
    })
  }
  if (bgmMuted.value || !id) {
    fadeTo(bgmEl, 0, () => bgmEl.pause())
    return
  }
  if (bgmId === id) {
    if (bgmEl.paused) bgmEl.play().catch(() => {})
    fadeTo(bgmEl, BGM_VOLUME)
    return
  }
  // 换床：先淡出旧的再切源，避免硬切造成的爆音
  fadeTo(bgmEl, 0, () => loadBgm(id, 'mp3'))
}

watch(() => session.bgm, (id) => applyBgm(id))
watch(bgmMuted, () => applyBgm(session.bgm))

// ── 预制语音 ──────────────────────────────────────────────────
// 只放已离线合成好的模组原文，也就是后端给了 voiceKey 的那些消息。
// KP 的即兴叙述属于实时层，还没做，这里不碰。
//
// 与环境音同样的三条约束：文件缺失静默、被浏览器拦下静默、不打断叙事。
// 额外一条：语音播放期间把环境音压低，按"垫在人声之下"的标准混音。
const VOICE_VOLUME = 0.9
const BGM_DUCKED = 0.12
const voiceMuted = ref(true) // 默认关，同样是因为自动播放会被拒绝
let voiceEl = null
let voicePlaying = false
const voiceQueue = []

function restoreBgm() {
  voicePlaying = false
  if (!bgmMuted.value && bgmEl && !bgmEl.paused) fadeTo(bgmEl, BGM_VOLUME)
}

function playNextVoice() {
  const key = voiceQueue.shift()
  if (!key) { restoreBgm(); return }
  voicePlaying = true
  if (!bgmMuted.value && bgmEl && !bgmEl.paused) fadeTo(bgmEl, BGM_DUCKED)
  voiceEl.src = `/voice/${key}.wav`
  // 被拦下时停在这里，不继续消费队列：说明用户还没交互过，后面几条同样会失败
  voiceEl.play().catch(() => restoreBgm())
}

function enqueueVoice(key) {
  if (!key || voiceMuted.value) return
  if (!voiceEl) {
    voiceEl = new Audio()
    voiceEl.volume = VOICE_VOLUME
    voiceEl.addEventListener('ended', playNextVoice)
    // 没有对应预制文件就跳过这一条，不能卡住后面的
    voiceEl.addEventListener('error', playNextVoice)
  }
  voiceQueue.push(key)
  if (!voicePlaying) playNextVoice()
}

watch(voiceMuted, (muted) => {
  if (!muted) return
  voiceQueue.length = 0
  if (voiceEl) voiceEl.pause()
  restoreBgm()
})
const activeThemeRuleset = computed(() => {
  const ruleset = screen.value === 'game' ? session.ruleset : selectedRuleset.value
  return String(ruleset).toLowerCase().includes('dnd') ? 'dnd5e' : 'cosmic-horror'
})
// ── 剧本杀 ──────────────────────────────────────────────────
// 与自由跑团各走各的：那边是 KP 即兴生成，这边是写定的线索门禁与结局。
// 引擎在岔口挂起等提交，所以这里是「轮询取增量播报 + 有岔口就渲染选项」。
const scriptedLoading = ref(false)
const scriptedId = ref('')
const scriptedLines = ref([])
const scriptedPending = ref(null)
const scriptedFinished = ref(false)
const scriptedError = ref('')
let scriptedTimer = null

async function startScripted() {
  scriptedLoading.value = true
  scriptedError.value = ''
  try {
    const r = await ownerFetch('/api/scripted', { method: 'POST' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    scriptedId.value = data.id
    scriptedLines.value = []
    scriptedPending.value = null
    scriptedFinished.value = false
    screen.value = 'scripted'
    pollScripted()
  } catch (e) {
    scriptedError.value = '开局失败：' + (e?.message || e)
  } finally {
    scriptedLoading.value = false
  }
}

async function pollScripted() {
  clearTimeout(scriptedTimer)
  if (!scriptedId.value || scriptedFinished.value) return
  try {
    const r = await ownerFetch(`/api/scripted/${scriptedId.value}`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const snap = await r.json()
    // 服务端只回增量，直接追加即可，不必去重
    if (snap.lines?.length) scriptedLines.value.push(...snap.lines)
    // voiceKeys 与 lines 逐项对应：有键的那几行有离线合成好的音频，其余是 null
    // （经过 LLM 或属机制文本）。enqueueVoice 自己会挡掉 null 与静音状态。
    snap.voiceKeys?.forEach((k) => enqueueVoice(k))
    scriptedPending.value = snap.pending || null
    scriptedFinished.value = !!snap.finished
    if (snap.error) scriptedError.value = snap.error
    scrollScriptedLog()
  } catch (e) {
    scriptedError.value = '拉取失败：' + (e?.message || e)
  }
  // 停在岔口时不必频繁轮询——推进只会由玩家提交触发
  if (!scriptedFinished.value) {
    scriptedTimer = setTimeout(pollScripted, scriptedPending.value ? 2000 : 500)
  }
}

async function chooseScripted(option) {
  if (!scriptedPending.value) return
  const pending = scriptedPending.value
  scriptedPending.value = null // 先收起选项，避免重复点击提交两次
  try {
    const r = await ownerFetch(`/api/scripted/${scriptedId.value}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ option }),
    })
    if (!r.ok) {
      scriptedPending.value = pending // 提交失败要把选项放回去，否则这局就卡住了
      const body = await r.json().catch(() => ({}))
      scriptedError.value = body.error || `提交失败 HTTP ${r.status}`
      return
    }
    pollScripted()
  } catch (e) {
    scriptedPending.value = pending
    scriptedError.value = '提交失败：' + (e?.message || e)
  }
}

function exitScripted() {
  clearTimeout(scriptedTimer)
  scriptedId.value = ''
  scriptedLines.value = []
  scriptedPending.value = null
  scriptedFinished.value = false
  scriptedError.value = ''
  screen.value = 'start'
}

function clearOwnerAccess() {
  clearOwnerBearer()
  ownerCredential.value = ''
  ownerAuthenticated.value = false
  ownerAuthError.value = ''
  savedSessions.value = []
  exitScripted()
  screen.value = 'start'
}

const scriptedLogEl = ref(null)
function scrollScriptedLog() {
  nextTick(() => {
    const el = scriptedLogEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

const messages = ref([])
const companions = ref([])
const npcs = ref([])
const monsters = ref([])
const companionsExpanded = ref(true)
const selectedCompanion = ref(null)
const kpVisible = ref(false)
const moduleEditorVisible = ref(false)
const settingsVisible = ref(false)
const charEditorVisible = ref(false)
const charEditorOpening = ref(false)
const charEditorCharacter = ref(null)
const charEditorSanity = ref(null)
const charEditorStatus = ref('')
const pcList = ref([])
const activePc = ref(0)
const suggestions = ref([])
const logFilter = ref('all')
const filteredMessages = computed(() => logFilter.value === 'all' ? messages.value : messages.value.filter(m => m.type === logFilter.value))
const inputValue = ref('')
const luckSpendAmount = ref('')
const partyMemberName = ref('')
const partyMemberArchetype = ref('')
// This is only a browser-side recovery indicator. The durable record itself
// remains in api.js/localStorage and is always replayed before a new request.
const ordinaryPendingKind = ref(null)
const history = ref([])
const historyIndex = ref(-1)
const logEl = ref(null)
const inputRef = ref(null)

const hpPercent = computed(() => session.maxHp > 0 ? Math.max(0, Math.round((session.hp / session.maxHp) * 100)) : 100)
const sanPercent = computed(() => session.maxSAN > 0 ? Math.max(0, Math.round((session.san / session.maxSAN) * 100)) : 100)
const hpColor = computed(() => hpPercent.value <= 25 ? '#ff4757' : hpPercent.value <= 50 ? '#ffa502' : '#2ed573')
const sanColor = computed(() => sanPercent.value <= 25 ? '#ff4757' : sanPercent.value <= 50 ? '#ffa502' : '#2ed573')
const hasInsanity = computed(() => session.tempInsanity || session.indefInsanity)
const sessionTerminal = computed(() => session.dead || session.terminal !== null)
const ordinaryLuckSpendVisibleForSession = computed(() => ordinaryLuckSpendVisible({
  sessionKind: session.sessionKind,
  ruleset: session.ruleset,
  ordinaryGeneration: session.ordinaryGeneration,
  luck: session.luck,
}))
const ordinaryLuckSpendDisabled = computed(() => ordinaryLuckSpendRequest({
  sessionKind: session.sessionKind,
  ruleset: session.ruleset,
  ordinaryGeneration: session.ordinaryGeneration,
  luck: session.luck,
  loading: loading.value,
  terminal: sessionTerminal.value ? session.terminal ?? { kind: 'legacy_unknown' } : null,
  pendingKind: ordinaryPendingKind.value,
  amount: luckSpendAmount.value,
}) === null)
const ordinaryPartyMemberCreateVisibleForSession = computed(() => ordinaryPartyMemberCreateVisible({
  sessionKind: session.sessionKind,
  ordinaryGeneration: session.ordinaryGeneration,
}))
const ordinaryPartyMemberCreateDisabled = computed(() => ordinaryPartyMemberCreateRequest({
  sessionKind: session.sessionKind,
  ordinaryGeneration: session.ordinaryGeneration,
  loading: loading.value,
  terminal: sessionTerminal.value ? session.terminal ?? { kind: 'legacy_unknown' } : null,
  pendingKind: ordinaryPendingKind.value,
  name: partyMemberName.value,
  archetype: partyMemberArchetype.value,
}) === null)
const ordinaryCharacterEditorVisibleForSession = computed(() => ordinaryCharacterEditorVisible({
  sessionKind: session.sessionKind,
  ordinaryGeneration: session.ordinaryGeneration,
}))
// Opening has no form patch yet. Keep that admission separate from save so
// the first click can perform the mandatory authoritative GET.
const ordinaryCharacterEditorDisabled = computed(() => !ordinaryCharacterEditorVisibleForSession.value
  || loading.value || charEditorOpening.value || sessionTerminal.value || !!ordinaryPendingKind.value)
const ordinaryPendingLabel = computed(() => ({
  text_action: '先前的文本行动正在确认',
  luck_spend: '先前的幸运花费正在确认',
  party_member_create: '新增队友正在确认',
  character_patch: '角色编辑正在确认',
  kp_message: 'KP 公告正在确认',
}[ordinaryPendingKind.value] ?? ''))
const terminalTitle = computed(() => {
  if (session.terminal?.kind === 'module_departure') return '调查结束'
  if (session.terminal?.kind === 'legacy_unknown') return '会话已结束'
  return '你已死亡'
})
const terminalDescription = computed(() => {
  if (session.terminal?.kind === 'module_departure') return `结局：${session.terminal.endingName}`
  if (session.terminal?.kind === 'legacy_unknown') return '该会话来自旧版本记录，无法安全判定结束原因。'
  return '调查在此终止。'
})
const showCharCard = computed(() => selectedCompanion.value !== null)

async function scrollToBottom() { await nextTick(); if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight }
watch(() => messages.value.length, () => scrollToBottom())

async function loadArchetypes(rs) {
  const ruleset = rs || selectedRuleset.value
  archetypeLoading.value = true
  try {
    const data = await getArchetypes(ruleset)
    archetypes.value = data.archetypes || []
    if (archetypes.value.length > 0) selectedArchetype.value = archetypes.value[0].id
  } catch {
    archetypes.value = selectedRuleset.value === 'dnd5e'
      ? [{ id: 'fighter', label: '战士', description: '精通所有武器和护甲的战斗专家' }, { id: 'rogue', label: '游荡者', description: '潜行、巧手、寻找并解除陷阱' }, { id: 'wizard', label: '法师', description: '研习奥术，掌握强大的法术' }, { id: 'cleric', label: '牧师', description: '侍奉神祇，治愈队友，驱散亡灵' }, { id: 'barbarian', label: '野蛮人', description: '狂怒之力，以血肉之躯冲垮敌人' }]
      : [{ id: 'investigator', label: '调查员', description: '追查真相的专业人士' }, { id: 'antiquarian', label: '古物学者', description: '研究古代文物和历史的专家' }]
    if (archetypes.value.length > 0) selectedArchetype.value = archetypes.value[0].id
  } finally { archetypeLoading.value = false }
}

async function authenticateOwner() {
  if (ownerAuthPending.value) return
  ownerAuthPending.value = true
  ownerAuthError.value = ''
  try {
    setOwnerBearer(ownerCredential.value)
    ownerCredential.value = ''
    loadingSessions.value = true
    const data = await listSessions()
    savedSessions.value = data.filter(s => s.id)
    ownerAuthenticated.value = true
    await loadArchetypes()
  } catch {
    clearOwnerBearer()
    ownerCredential.value = ''
    ownerAuthenticated.value = false
    savedSessions.value = []
    ownerAuthError.value = 'Owner credential could not be verified.'
  } finally {
    loadingSessions.value = false
    ownerAuthPending.value = false
  }
}

watch(selectedRuleset, (rs) => loadArchetypes(rs))
watch(archetypes, (entries) => {
  if (!entries.some(entry => entry?.id === partyMemberArchetype.value)) {
    partyMemberArchetype.value = entries[0]?.id || ''
  }
})

async function startGame() {
  loading.value = true; error.value = null
  // The browser queue is keyed by session ID. A visible indicator from the
  // game just left cannot govern this allocation; after its ID is known,
  // coordinateOrdinaryPending() installs only this session's slot.
  ordinaryPendingKind.value = null
  clearCharacterEditorState()
  try {
    const name = characterName.value.trim() || '调查员'
    const archetype = selectedArchetype.value || 'investigator'
    const data = await createSession({ ruleset: selectedRuleset.value, archetype, characterName: name })
    session.id = data.sessionId; session.round = data.summary?.round ?? 1; session.scene = data.summary?.scene ?? '序幕'
    session.sessionKind = data.sessionKind === 'ordinary' || data.sessionKind === 'compiled' ? data.sessionKind : ''
    session.ordinaryGeneration = ordinarySessionGeneration(data, session.sessionKind)
    session.compiledGeneration = compiledSessionGeneration(data, session.sessionKind)
    session.playerName = data.characterName ?? name; session.archetype = data.summary?.archetype ?? ''
    session.ruleset = data.summary?.ruleset ?? '宇宙恐怖（百分位）'
    // Creation has no authoritative state projection yet; its canonical
    // character summary is the sole permitted initial Luck source.
    session.luck = session.sessionKind === 'ordinary' && session.ruleset === 'cosmic-horror'
      ? ordinaryLuckFromCreateResponse(data)
      : null
    luckSpendAmount.value = ''
    if (data.character) { session.hp = data.character.hp ?? 10; session.maxHp = data.character.maxHp ?? 10; session.san = data.character.attributes?.power ?? 50; session.maxSAN = data.character.attributes?.power ?? 50 }
    else { session.hp = 10; session.maxHp = 10; session.san = 55; session.maxSAN = 55 }
    pcList.value = [{ id: 'p1', name: data.characterName ?? name }]
    if (data.state?.companions) companions.value = data.state.companions
    if (data.state?.npcs) npcs.value = data.state.npcs
    if (data.state?.monsters) monsters.value = data.state.monsters
    session.bgm = data.state?.bgm ?? ''
    messages.value = [{ id: Date.now(), type: 'narration', speaker: '守秘人', content: data.opening || '夜幕降临，故事由此开始……' }]
    screen.value = 'game'
    if (session.sessionKind === 'ordinary') {
      try {
        // A collision/recovery edge can leave this freshly selected session
        // with its own browser-durable request. Replay/reconcile that exact
        // slot rather than inheriting an indicator from the previous session.
        await coordinateOrdinaryPending()
      } catch (pendingError) {
        resyncOrdinaryPendingAfterFailure()
        error.value = pendingError?.message || '普通操作恢复失败'
      }
    }
  } catch (e) { error.value = e.message || '创建游戏失败' }
  finally { loading.value = false }
}

function applyAuthoritativeSessionSnapshot(current, fallback = {}) {
  const summary = current?.summary || fallback
  session.id = summary.id || fallback.id || ''
  session.round = current?.state?.round ?? summary.round ?? session.round
  session.scene = current?.state?.scene ?? summary.scene ?? session.scene
  session.playerName = summary.playerName ?? session.playerName ?? '调查员'
  session.archetype = summary.archetype ?? session.archetype
  session.ruleset = summary.ruleset ?? fallback?.ruleset ?? fallback?.summary?.ruleset ?? ''
  const declaredKind = current?.sessionKind ?? current?.summary?.sessionKind
  session.sessionKind = declaredKind === 'ordinary' || declaredKind === 'compiled' ? declaredKind : ''
  if (session.sessionKind === 'ordinary') {
    // A GET/reconciliation payload, rather than an earlier list entry or a
    // previous session, owns the generation and Luck visible to this screen.
    session.ordinaryGeneration = ordinarySessionGeneration(current, 'ordinary')
    session.compiledGeneration = null
  } else if (session.sessionKind === 'compiled') {
    session.compiledGeneration = compiledSessionGeneration(current, 'compiled')
    session.ordinaryGeneration = null
  } else {
    session.ordinaryGeneration = null
    session.compiledGeneration = null
  }
  session.luck = session.sessionKind === 'ordinary' && session.ruleset === 'cosmic-horror'
    ? ordinaryLuckFromAuthoritativeState(current)
    : null
  if (current?.state) {
    session.bgm = current.state.bgm ?? session.bgm
    if (current.state.player) {
      session.hp = current.state.player.hp ?? session.hp
      session.maxHp = current.state.player.maxHp ?? session.maxHp
    }
    if (current.state.companions) companions.value = current.state.companions
    if (current.state.npcs) npcs.value = current.state.npcs
    if (current.state.monsters) monsters.value = current.state.monsters
  }
  if (current?.sanity) {
    session.san = current.sanity.currentSAN ?? session.san
    session.maxSAN = current.sanity.maxSAN ?? session.maxSAN
    session.tempInsanity = current.sanity.temporaryInsanity ?? false
    session.indefInsanity = current.sanity.indefiniteInsanity ?? false
  }
  applyTerminalState(current, declaredKind)
  if (Array.isArray(current?.history)) {
    messages.value = current.history.map((m) => ({ id: Date.now() + Math.random(), type: m.type || 'system', speaker: m.speaker || '', content: m.content || '', verbatim: m.verbatim === true }))
  }
  // Party membership is rendered only from the authoritative GET/replay
  // projection. A successful /party receipt never mutates this list itself.
  const authoritativeParty = Array.isArray(current?.state?.party)
    ? current.state.party.filter(member => member && typeof member.pcId === 'string' && typeof member.name === 'string')
      .map(member => ({ id: member.pcId, name: member.name }))
    : []
  pcList.value = authoritativeParty.length ? authoritativeParty : [{ id: 'p1', name: session.playerName }]
}

function applyTerminalState(data, sessionKind = session.sessionKind) {
  if (data?.terminal !== undefined) session.terminal = data.terminal
  else if (sessionKind === 'compiled') session.terminal = null
  if (data?.dead !== undefined) session.dead = data.dead === true
  if (session.terminal?.kind === 'death' || (session.dead && session.terminal === null)) session.hp = 0
}

function applyAuthoritativeHistory(data) {
  if (!Array.isArray(data?.messages)) return
  messages.value = data.messages.map((m) => ({ id: Date.now() + Math.random(), type: m.type || 'system', speaker: m.speaker || '', content: m.content || '', verbatim: m.verbatim === true }))
}

function clearCharacterEditorState() {
  charEditorVisible.value = false
  charEditorOpening.value = false
  charEditorCharacter.value = null
  charEditorSanity.value = null
  charEditorStatus.value = ''
}

/** Project only a complete owner GET `/character`; never synthesize a sheet from summary. */
function applyAuthoritativeCharacterProjection(authority) {
  const generation = ordinarySessionGeneration(authority, 'ordinary')
  const character = authority?.character
  if (!isAuthoritativeOrdinaryCharacter(authority, session.id) || generation === null || !character
    || authority?.summary?.id !== session.id || typeof character.name !== 'string'
    || !Array.isArray(authority.inventory) || !Array.isArray(authority.weapons)) return false
  const complete = {
    ...character,
    skills: { ...(character.skills ?? {}) },
    attributes: { ...(character.attributes ?? {}) },
    inventory: [...authority.inventory],
    weapons: [...authority.weapons],
  }
  charEditorCharacter.value = complete
  charEditorSanity.value = authority.sanity ? { ...authority.sanity } : null
  session.ordinaryGeneration = generation
  session.compiledGeneration = null
  session.sessionKind = 'ordinary'
  session.playerName = authority.summary?.playerName ?? character.name
  session.archetype = authority.summary?.archetype ?? character.archetype
  session.ruleset = authority.summary?.ruleset ?? session.ruleset
  session.hp = character.hp
  session.maxHp = character.maxHp
  session.luck = character.luck
  session.creditRating = character.creditRating
  session.skills = { ...complete.skills }
  session.attributes = { ...complete.attributes }
  session.inventory = [...complete.inventory]
  session.weapons = [...complete.weapons]
  if (authority.sanity) {
    session.san = authority.sanity.currentSAN ?? session.san
    session.maxSAN = authority.sanity.maxSAN ?? session.maxSAN
    session.tempInsanity = authority.sanity.temporaryInsanity ?? false
    session.indefInsanity = authority.sanity.indefiniteInsanity ?? false
  }
  return true
}

function applyOrdinaryErrorGeneration(data) {
  const generation = ordinarySessionGeneration(data, 'ordinary')
  if (generation === null) return
  const previousGeneration = session.ordinaryGeneration
  session.ordinaryGeneration = generation
  // An error can name a newer generation but never its Luck. Keeping the old
  // value paired with that newer generation would authorize an unsafe spend.
  if (previousGeneration !== generation) session.luck = null
}

function applyRecoveredOrdinaryPending(recovered) {
  if (recovered?.kind !== 'reconciled') return false
  // Replayed ordinary work, including /party, is rendered only from these
  // authoritative reads; never append a locally invented party member.
  applyAuthoritativeSessionSnapshot(recovered.session)
  applyAuthoritativeHistory(recovered.history)
  if (recovered.character) applyAuthoritativeCharacterProjection(recovered.character)
  ordinaryPendingKind.value = recovered.pendingRetained ? recovered.pendingKind : null
  return true
}

function resyncOrdinaryPendingKind() {
  if (session.sessionKind !== 'ordinary' || !session.id) {
    ordinaryPendingKind.value = null
    return null
  }
  const durableKind = ordinaryPendingKindFromDurableStorage(
    () => pendingOrdinaryActionKind(session.id),
  )
  ordinaryPendingKind.value = durableKind
  return durableKind
}

function resyncOrdinaryPendingAfterFailure() {
  try {
    return resyncOrdinaryPendingKind()
  } catch {
    // If the slot itself is unreadable we cannot prove a pre-persist failure.
    // Retain the conservative indicator instead of blindly enabling writes.
    return ordinaryPendingKind.value
  }
}

async function coordinateOrdinaryPending() {
  if (session.sessionKind !== 'ordinary' || !session.id) {
    ordinaryPendingKind.value = null
    return null
  }
  resyncOrdinaryPendingKind()
  const recovered = await retryPendingOrdinaryAction(session.id)
  if (!recovered) ordinaryPendingKind.value = null
  applyRecoveredOrdinaryPending(recovered)
  return recovered
}

/**
 * KPDashboard has no queue of its own. It first coordinates the shared
 * browser-durable slot, then lets api.js persist/post/reconcile the one
 * host announcement. A result for another kind is deliberately not reported
 * as this form having sent anything.
 */
async function submitOrdinaryKpMessage(input) {
  if (loading.value || session.sessionKind !== 'ordinary' || !session.id || sessionTerminal.value || ordinaryPendingKind.value) {
    return { kind: 'not-submitted' }
  }
  const sessionId = session.id
  loading.value = true
  error.value = null
  try {
    const coordinated = await coordinateOrdinaryPending()
    if (coordinated) return { kind: 'other-coordinated', pendingKind: coordinated.pendingKind }
    // The local indicator is conservative. api.js only keeps it after a
    // successful storage write; failure resync below removes it again.
    ordinaryPendingKind.value = 'kp_message'
    const result = await ordinaryKpMessage(sessionId, input, {
      expectedGeneration: session.ordinaryGeneration,
    })
    if (session.id !== sessionId) return { kind: 'session-changed' }
    if (result?.kind === 'reconciled') applyRecoveredOrdinaryPending(result)
    if (result?.kind === 'reconciled'
      && result.pendingKind === 'kp_message'
      && !result.pendingRetained
      && result.receipt) {
      // The receipt was strictly bound by api.js and the preceding helper has
      // already replaced the UI with owner GET session/history authority.
      // KPDashboard observes the generation prop and refreshes its read view.
      return { kind: 'sent' }
    }
    return { kind: 'not-confirmed', pendingKind: result?.pendingKind }
  } catch (e) {
    if (session.id === sessionId) {
      resyncOrdinaryPendingAfterFailure()
      applyOrdinaryErrorGeneration(e?.data)
      error.value = e?.message || 'KP announcement was not confirmed.'
    }
    return { kind: 'failed' }
  } finally {
    if (session.id === sessionId) loading.value = false
  }
}

async function openOrdinaryCharacterEditor() {
  if (ordinaryCharacterEditorDisabled.value) return
  const sessionId = session.id
  charEditorOpening.value = true
  charEditorStatus.value = 'Loading the authoritative character sheet...'
  try {
    // Opening cannot reuse summary/session fields: the editor needs the
    // complete active-PC view, including inventory, weapons, and attributes.
    const authority = await getCharacter(sessionId)
    if (session.id !== sessionId || session.sessionKind !== 'ordinary') return
    if (!applyAuthoritativeCharacterProjection(authority)) throw new Error('authoritative character response is invalid')
    charEditorStatus.value = ''
    charEditorVisible.value = true
  } catch (e) {
    if (session.id === sessionId) {
      charEditorVisible.value = false
      charEditorStatus.value = ''
      error.value = e?.message || 'Unable to load authoritative character'
    }
  } finally {
    if (session.id === sessionId) charEditorOpening.value = false
  }
}

async function saveOrdinaryCharacterPatch(patch) {
  if (ordinaryCharacterEditorDisabled.value || loading.value) return
  const sessionId = session.id
  loading.value = true
  error.value = null
  charEditorStatus.value = 'Persisting durable character patch...'
  try {
    const dispatched = await submitOrdinaryCharacterPatch({
      sessionKind: session.sessionKind,
      ordinaryGeneration: session.ordinaryGeneration,
      loading: false,
      terminal: sessionTerminal.value ? session.terminal ?? { kind: 'legacy_unknown' } : null,
      pendingKind: ordinaryPendingKind.value,
      patch,
    }, ({ patch: requestPatch, expectedGeneration }) => {
      ordinaryPendingKind.value = 'character_patch'
      return characterPatch(sessionId, requestPatch, { expectedGeneration })
    })
    if (dispatched.kind === 'not-submitted') return
    if (session.id !== sessionId) return
    const result = dispatched.result
    if (result?.kind === 'reconciled') applyRecoveredOrdinaryPending(result)
    const outcome = ordinaryCharacterPatchOutcome(result)
    if (outcome.kind === 'character-confirmed') {
      // `result.character` is the completed GET view used by the API's
      // reconciliation, not the POST body or locally edited form state.
      if (!applyAuthoritativeCharacterProjection(outcome.character)) throw new Error('authoritative character projection is invalid')
      charEditorStatus.value = 'Saved and confirmed from the durable character view.'
      return
    }
    if (outcome.kind === 'character-pending') {
      charEditorStatus.value = 'The request is persisted but still awaiting confirmation.'
      return
    }
    if (outcome.kind === 'character-not-committed') {
      charEditorStatus.value = 'The patch was rejected; the displayed sheet was refreshed but not saved.'
      return
    }
    if (outcome.kind === 'other-pending' || outcome.kind === 'other-reconciled') {
      charEditorStatus.value = 'A prior ordinary request was coordinated first; this sheet was not saved.'
      return
    }
    charEditorStatus.value = 'The response was not an authoritative character confirmation.'
  } catch (e) {
    if (session.id === sessionId) {
      resyncOrdinaryPendingAfterFailure()
      applyOrdinaryErrorGeneration(e?.data)
      charEditorStatus.value = `Not confirmed: ${e?.message || 'character save failed'}`
    }
  } finally {
    if (session.id === sessionId) loading.value = false
  }
}

async function submitLuckSpend() {
  if (loading.value) return
  loading.value = true
  error.value = null
  try {
    const dispatched = await submitOrdinaryLuckSpend({
      sessionKind: session.sessionKind,
      ruleset: session.ruleset,
      ordinaryGeneration: session.ordinaryGeneration,
      luck: session.luck,
      loading: false,
      terminal: sessionTerminal.value ? session.terminal ?? { kind: 'legacy_unknown' } : null,
      pendingKind: ordinaryPendingKind.value,
      amount: luckSpendAmount.value,
    }, ({ amount, expectedGeneration }) => {
      ordinaryPendingKind.value = 'luck_spend'
      return luckSpend(session.id, amount, { expectedGeneration })
    })
    if (dispatched.kind === 'not-submitted') return

    const result = dispatched.result
    if (result?.kind === 'reconciled') {
      // Reconciliation state/history outranks any historical receipt.
      applyRecoveredOrdinaryPending(result)
    }
    else ordinaryPendingKind.value = null
    const outcome = ordinaryLuckSpendOutcome(result)
    if (outcome.kind === 'text-reconciled') {
      messages.value.push({ id: Date.now(), type: 'system', speaker: '系统', content: '已同步先前已提交的文本行动；请确认新状态后再花费幸运。' })
      return
    }
    if (outcome.kind === 'text-pending') {
      messages.value.push({ id: Date.now(), type: 'system', speaker: '系统', content: '先前文本行动仍待确认；尚未花费幸运。' })
      return
    }
    if (outcome.kind === 'luck-pending') {
      messages.value.push({ id: Date.now(), type: 'system', speaker: '系统', content: '幸运花费仍待确认；尚未报告花费成功。' })
      return
    }
    if (outcome.kind === 'luck-not-confirmed') {
      messages.value.push({ id: Date.now(), type: 'system', speaker: '系统', content: '先前幸运花费未获确认；尚未报告花费成功。' })
      return
    }
    if (outcome.kind === 'luck-receipt' || outcome.kind === 'luck-reconciled') {
      // This assignment occurs only after an accepted receipt/reconciled GET,
      // never on click or while its durable request is pending.
      session.ordinaryGeneration = outcome.ordinaryGeneration
      session.luck = outcome.luck
      luckSpendAmount.value = ''
      messages.value.push({ id: Date.now(), type: 'system', speaker: '系统', content: outcome.kind === 'luck-receipt' ? '已确认花费幸运。' : '已同步已确认的幸运花费。' })
      return
    }
    // A malformed success body carries neither an authoritative state nor a
    // usable receipt, so hide the control instead of retaining stale Luck.
    session.luck = null
    messages.value.push({ id: Date.now(), type: 'system', speaker: '系统', content: '幸运花费响应无法验证；请刷新会话后重试。' })
  } catch (e) {
    resyncOrdinaryPendingAfterFailure()
    applyOrdinaryErrorGeneration(e?.data)
    messages.value.push({ id: Date.now(), type: 'system', speaker: '系统', content: '错误：' + (e.message || '幸运花费失败') })
  } finally {
    loading.value = false
    refreshSuggestions().catch(() => {})
  }
}

async function submitPartyMemberCreate() {
  if (loading.value) return
  loading.value = true
  error.value = null
  try {
    const dispatched = await submitOrdinaryPartyMemberCreate({
      sessionKind: session.sessionKind,
      ordinaryGeneration: session.ordinaryGeneration,
      loading: false,
      terminal: sessionTerminal.value ? session.terminal ?? { kind: 'legacy_unknown' } : null,
      pendingKind: ordinaryPendingKind.value,
      name: partyMemberName.value,
      archetype: partyMemberArchetype.value,
    }, ({ name, archetype, meta, expectedGeneration }) => {
      ordinaryPendingKind.value = 'party_member_create'
      return partyMemberCreate(session.id, { name, archetype, ...(meta ? { meta } : {}) }, { expectedGeneration })
    })
    if (dispatched.kind === 'not-submitted') return

    const result = dispatched.result
    if (result?.kind === 'reconciled') applyRecoveredOrdinaryPending(result)
    const outcome = ordinaryPartyMemberCreateOutcome(result)
    if (outcome.kind === 'party-reconciled') {
      // The authoritative GET has already refreshed pcList/party state. Do
      // not add an optimistic local member or guess the server-assigned pcId.
      partyMemberName.value = ''
      messages.value.push({ id: Date.now(), type: 'system', speaker: '系统', content: '已同步新增队友。' })
      return
    }
    if (outcome.kind === 'party-pending' || outcome.kind === 'party-not-confirmed') {
      messages.value.push({ id: Date.now(), type: 'system', speaker: '系统', content: '新增队友仍待确认；尚未在本地加入队伍。' })
      return
    }
    if (outcome.kind === 'other-reconciled' || outcome.kind === 'other-pending') {
      messages.value.push({ id: Date.now(), type: 'system', speaker: '系统', content: `已优先协调${ordinaryPendingLabel.value || '先前的普通操作'}；尚未新增队友。` })
      return
    }
    messages.value.push({ id: Date.now(), type: 'system', speaker: '系统', content: '新增队友响应无法验证；请刷新会话后重试。' })
  } catch (e) {
    resyncOrdinaryPendingAfterFailure()
    applyOrdinaryErrorGeneration(e?.data)
    messages.value.push({ id: Date.now(), type: 'system', speaker: '系统', content: '错误：' + (e.message || '新增队友失败') })
  } finally {
    loading.value = false
    refreshSuggestions().catch(() => {})
  }
}

async function resumeSession(s) {
  loading.value = true
  // A saved-session switch must not carry a typed amount or Luck from the
  // previously viewed session while its authoritative GET is in flight.
  luckSpendAmount.value = ''
  session.luck = null
  ordinaryPendingKind.value = null
  clearCharacterEditorState()
  try {
    const current = await getSession(s.id)
    applyAuthoritativeSessionSnapshot(current, s)
    let recovered = null
    if (session.sessionKind === 'ordinary') {
      // A durable party request must be coordinated before this restored view
      // permits text or Luck. Its queue indicator remains set on an unknown
      // acknowledgement, which keeps every ordinary control disabled.
      try { recovered = await coordinateOrdinaryPending() }
      catch (e) {
        applyOrdinaryErrorGeneration(e?.data)
        error.value = e?.message || '普通操作恢复失败'
      }
    }
    if (!recovered) {
      try { const hist = await getHistory(s.id, 100); applyAuthoritativeHistory(hist) }
      catch { messages.value = [] }
    }
    screen.value = 'game'
    try { await refreshSuggestions() }
    catch (e) { error.value = e?.message || '建议刷新失败' }
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
}

async function refreshSuggestions() {
  if (!session.id) return
  if (sessionTerminal.value) { suggestions.value = []; return }
  if (session.sessionKind === 'ordinary') {
    await coordinateOrdinaryPending()
    suggestions.value = await getSuggestions(session.id)
    return
  }
  if (session.sessionKind === 'compiled') {
    let reconciledCatalog = null
    try {
      // Resume/refresh is a recovery point too. The API validates the live
      // catalog before replaying, and never asks the intent model while a
      // durable structured request is pending.
      const recovered = await retryPendingCompiledAction(session.id, { pcId: 'p1' })
      if (recovered?.kind === 'executed') applyRecoveredCompiledAction(recovered.data)
      if (recovered?.kind === 'reconciled') {
        applyAuthoritativeSessionSnapshot(recovered.session)
        reconciledCatalog = recovered.catalog
      }
    } catch (e) {
      const deterministic = e?.pendingDiscarded || e?.pendingCleared || (Number.isInteger(e?.status) && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429)
      if (!deterministic) throw e
      const generation = compiledSessionGeneration(e?.data, 'compiled')
      if (generation !== null) session.compiledGeneration = generation
    }
    const data = reconciledCatalog || await getCompiledActions(session.id, 'p1')
    const generation = compiledSessionGeneration(data, 'compiled')
    if (generation !== null) session.compiledGeneration = generation
    suggestions.value = (data.actions || []).map(action => action.label).filter(Boolean)
    return
  }
  suggestions.value = await getSuggestions(session.id)
}

function applyRecoveredCompiledAction(data) {
  session.luck = null
  const generation = compiledSessionGeneration(data, 'compiled')
  if (generation !== null) session.compiledGeneration = generation
  const narrative = (data?.narrative || '').trim()
  if (narrative) messages.value.push({ id: Date.now(), type: 'narration', speaker: '守秘人', content: narrative })
  for (const ev of data?.events || []) {
    if (narrative && (ev.content || '').trim() === narrative) continue
    messages.value.push({ id: Date.now() + Math.random(), type: ev.type || 'system', speaker: ev.speaker || '系统', content: ev.content || '', verbatim: ev.verbatim === true })
    enqueueVoice(ev.voiceKey)
  }
  if (data?.state) { session.round = data.state.round ?? session.round; session.scene = data.state.scene ?? session.scene; session.bgm = data.state.bgm ?? '' }
  if (data?.state?.player) { session.hp = data.state.player.hp ?? session.hp; session.maxHp = data.state.player.maxHp ?? session.maxHp }
  if (data?.state?.companions) companions.value = data.state.companions
  if (data?.state?.npcs) npcs.value = data.state.npcs
  if (data?.state?.monsters) monsters.value = data.state.monsters
  applyTerminalState(data)
  if (data?.sanity) { session.san = data.sanity.currentSAN ?? session.san; session.maxSAN = data.sanity.maxSAN ?? session.maxSAN; session.tempInsanity = data.sanity.temporaryInsanity ?? false; session.indefInsanity = data.sanity.indefiniteInsanity ?? false }
}

function compiledIntentMessage(resolution) {
  if (resolution?.status === 'ambiguous') return `这个行动可能对应：${(resolution.mechanismIds || []).join('、')}。请换一种更明确的说法。`
  if (resolution?.status === 'no_match') return '当前可执行动作中没有匹配项；请换一种说法。'
  return '无法确认当前可执行的编译动作。'
}

async function submitAction(inputText, actingPc) {
  const trimmed = inputText.trim(); if (!trimmed || loading.value || sessionTerminal.value || ordinaryPendingKind.value) return
  const speaker = (actingPc !== undefined ? pcList.value[actingPc]?.name : pcList.value[activePc.value]?.name) || session.playerName
  if (history.value.length === 0 || history.value[history.value.length - 1] !== trimmed) history.value.push(trimmed)
  historyIndex.value = -1; loading.value = true; error.value = null
  try {
    if (session.sessionKind === 'ordinary') ordinaryPendingKind.value = 'text_action'
    // The model sees only the current executable catalog. It has no write
    // authority: a compiled session submits a second, structured request only
    // for an exact selected mechanism at this same generation.
    const submitted = await sendSessionAction(session.id, trimmed, {
      sessionKind: session.sessionKind,
      ordinaryGeneration: session.ordinaryGeneration,
      ...(session.sessionKind === 'compiled' ? { compiledGeneration: session.compiledGeneration } : {}),
      pcId: 'p1',
    })
    if (submitted.kind === 'unresolved') {
      const generation = compiledSessionGeneration(submitted.resolution, 'compiled')
      if (generation !== null) session.compiledGeneration = generation
      messages.value.push({ id: Date.now() + 1, type: 'system', speaker: '系统', content: compiledIntentMessage(submitted.resolution) })
      return
    }
    if (submitted.kind === 'reconciled') {
      applyRecoveredOrdinaryPending(submitted)
      messages.value.push({ id: Date.now() + 1, type: 'system', speaker: '系统', content: '已同步先前已提交的动作；请确认新状态后再提交下一步。' })
      return
    }
    const data = submitted.data
    if (session.sessionKind === 'ordinary') {
      ordinaryPendingKind.value = null
      const generation = ordinarySessionGeneration(data, 'ordinary')
      session.ordinaryGeneration = generation
      session.luck = session.ruleset === 'cosmic-horror'
        ? ordinaryLuckFromAuthoritativeState(data)
        : null
    } else if (submitted.kind === 'executed' && session.sessionKind === 'compiled') {
      const generation = compiledSessionGeneration(data, 'compiled')
      if (generation !== null) session.compiledGeneration = generation
      session.luck = null
    }
    const narrative = (data.narrative || '').trim()
    if (narrative) messages.value.push({ id: Date.now() + 1, type: 'narration', speaker: '守秘人', content: data.narrative })
    if (data.events) {
      for (const ev of data.events) {
        // 服务端会把玩家这次输入也回显在 events 里，而上面已经乐观插入过一条，
        // 直接全量追加会让每个行动在日志中出现两次。
        if ((ev.speaker || '') === speaker && (ev.content || '') === trimmed) continue
        // 经 LLM 的回合里，narrative 与 events 中那条叙事是同一段文字，
        // 上面已经插过一次。本地回合（掷骰、加载模组）的 narrative 是简短摘要、
        // 不在 events 里，所以只能按内容比对，不能一概不插 narrative。
        if (narrative && (ev.content || '').trim() === narrative) continue
        messages.value.push({ id: Date.now() + Math.random(), type: ev.type || 'system', speaker: ev.speaker || '系统', content: ev.content || '', verbatim: ev.verbatim === true })
        // 有预制音频的消息按出现顺序入队；没有 voiceKey 的直接跳过
        enqueueVoice(ev.voiceKey)
      }
    }
    if (data.dice && data.dice.length > 0) { for (const d of data.dice) messages.value.push({ id: Date.now() + Math.random(), type: 'roll', speaker: '🎲', content: d.expr + ' = **' + d.total + '**' + (d.detail ? ' (' + d.detail + ')' : '') }) }
    if (data.rolls && data.rolls.length > 0) { for (const r of data.rolls) messages.value.push({ id: Date.now() + Math.random(), type: 'roll', speaker: '🎲', content: r.skill + ' d100=' + r.roll + ' (目标=' + r.target + '%) → ' + (r.success ? '成功' : '失败') }) }
    if (data.state) { session.round = data.state.round ?? session.round; session.scene = data.state.scene ?? session.scene; session.bgm = data.state.bgm ?? '' }
    if (data.state?.player) { session.hp = data.state.player.hp ?? session.hp; session.maxHp = data.state.player.maxHp ?? session.maxHp }
    if (data.state?.companions) companions.value = data.state.companions
    if (data.state?.npcs) npcs.value = data.state.npcs
    if (data.state?.monsters) monsters.value = data.state.monsters
    applyTerminalState(data)
    if (data.sanity) { session.san = data.sanity.currentSAN ?? session.san; session.maxSAN = data.sanity.maxSAN ?? session.maxSAN; session.tempInsanity = data.sanity.temporaryInsanity ?? false; session.indefInsanity = data.sanity.indefiniteInsanity ?? false }
  } catch (e) {
    if (session.sessionKind === 'ordinary') {
      resyncOrdinaryPendingAfterFailure()
      applyOrdinaryErrorGeneration(e?.data)
    } else if (session.sessionKind === 'compiled') {
      const generation = compiledSessionGeneration(e?.data, 'compiled')
      if (generation !== null) session.compiledGeneration = generation
    }
    messages.value.push({ id: Date.now() + 2, type: 'system', speaker: '系统', content: '错误：' + (e.message || '请求失败') })
  }
  finally { loading.value = false; refreshSuggestions().catch(() => {}) }
}

function newGame() {
  // This is only a view indicator. The old session's durable request remains
  // keyed in storage, while a subsequent startGame() re-syncs the new ID.
  ordinaryPendingKind.value = null
  Object.assign(session, { id: '', round: 0, scene: '', playerName: '', archetype: '', ruleset: '', hp: 0, maxHp: 0, san: 0, maxSAN: 0, tempInsanity: false, indefInsanity: false, dead: false, terminal: null, luck: null, sessionKind: '', ordinaryGeneration: null, compiledGeneration: null })
  messages.value = []; companions.value = []; npcs.value = []; monsters.value = []; history.value = []; historyIndex.value = -1
  error.value = null; screen.value = 'start'; kpVisible.value = false; moduleEditorVisible.value = false; settingsVisible.value = false; savedSessions.value = []; suggestions.value = []; pcList.value = []; activePc.value = 0; clearCharacterEditorState(); luckSpendAmount.value = ''
}

function toggleControl(companion) { if (!companion || loading.value) return; submitAction(companion.control === 'auto' ? '控制 ' + companion.name : '自动 ' + companion.name) }
function openCharCard(c) { selectedCompanion.value = c }
function closeCharCard() { selectedCompanion.value = null }
function focusInput() { nextTick(() => inputRef.value?.focus()) }

const traitNames = { courage: '勇气', aggression: '攻击性', caution: '谨慎', loyalty: '忠诚', cruelty: '残忍' }
const skillNames = { fight: '格斗', dodge: '闪避', heal: '治疗', stealth: '潜行', arcana: '奥术', perception: '察觉', survival: '生存', persuasion: '说服', intimidate: '威吓' }

function positionLabel(pos) { const map = { melee_range: '近战位', ranged: '远程位', far: '后排' }; return map[pos] || pos || '未知' }
function behaviorLabel(beh) { const map = { aggressive: '攻击', defensive: '防御', support: '支援' }; return map[beh] || beh || '未知' }
function resolveStateLabel(state) { return { steadfast: '坚定', afflicted: '恐慌', berserk: '疯狂' }[state] || state }
function resolveStateColor(state) { return { steadfast: '#8fbc8f', afflicted: '#dda0dd', berserk: '#ff6b6b' }[state] || '#ccc' }
function traitColor(val) { const strength = Math.round(Math.max(20, Math.min(100, val * 10))); return `color-mix(in srgb, var(--accent-primary) ${strength}%, transparent)` }

function onInputKeydown(e) {
  if (e.key === 'ArrowUp') { e.preventDefault(); if (history.value.length === 0) return; const newIdx = historyIndex.value === -1 ? history.value.length - 1 : Math.max(0, historyIndex.value - 1); historyIndex.value = newIdx; inputValue.value = history.value[newIdx] }
  else if (e.key === 'ArrowDown') { e.preventDefault(); if (historyIndex.value === -1) return; const newIdx = historyIndex.value + 1; if (newIdx >= history.value.length) { historyIndex.value = -1; inputValue.value = '' } else { historyIndex.value = newIdx; inputValue.value = history.value[newIdx] } }
}
</script>

<template>
  <div v-if="!ownerAuthenticated" class="owner-auth-gate">
    <form class="owner-auth-gate__form" @submit.prevent="authenticateOwner">
      <h1>Keeper access</h1>
      <p>Enter the deployment bearer to open the owner console.</p>
      <input v-model="ownerCredential" type="password" autocomplete="new-password" class="owner-auth-gate__input" :disabled="ownerAuthPending" aria-label="Owner bearer" />
      <button class="btn btn--primary" type="submit" :disabled="ownerAuthPending || !ownerCredential">
        {{ ownerAuthPending ? 'Verifying…' : 'Open owner console' }}
      </button>
      <p v-if="ownerAuthError" class="owner-auth-gate__error">{{ ownerAuthError }}</p>
    </form>
  </div>

  <div v-else class="trpg-app" :class="{ 'screen--game': screen === 'game' }" :data-ruleset="activeThemeRuleset">
    <div v-if="screen === 'start'" class="start-screen">
      <div class="start-screen__inner">
        <button class="owner-auth-gate__clear" @click="clearOwnerAccess">Clear owner access</button>
        <div class="start-screen__ornament top"></div>
        <h1 class="start-screen__title">AI Narrator</h1>
        <p class="start-screen__subtitle">人工智能桌面角色扮演游戏</p>
        <p class="start-screen__desc">选择你的规则集，创建角色，开始冒险。<br/>宇宙恐怖适合洛夫克拉夫特式恐怖，D&D 适合奇幻冒险。</p>
        <div class="char-creation">
          <div class="char-creation__field">
            <label class="char-creation__label">角色姓名</label>
            <input v-model="characterName" class="char-creation__input" placeholder="输入你的名字..." maxlength="20" @keyup.enter="startGame"/>
          </div>
          <div class="char-creation__field">
            <label class="char-creation__label">规则</label>
            <select v-model="selectedRuleset" class="char-creation__select">
              <option value="cosmic-horror">宇宙恐怖（百分位）</option>
              <option value="dnd5e">龙与地下城 5 版</option>
            </select>
          </div>
          <div class="char-creation__field">
            <label class="char-creation__label">职业</label>
            <select v-model="selectedArchetype" class="char-creation__select" :disabled="archetypeLoading">
              <option v-for="a in archetypes" :key="a.id" :value="a.id">{{ a.label }}</option>
            </select>
            <p class="char-creation__hint" v-if="selectedArchetype">{{ archetypes.find(a => a.id === selectedArchetype)?.description || '' }}</p>
          </div>
          <div v-if="selectedArchetype" class="stat-preview">
            <h4 class="stat-preview__title">基础属性 ({{ rulesetName }})</h4>
            <div v-if="selectedRuleset === 'cosmic-horror'" class="stat-preview__grid">
              <div class="stat-preview__item"><span class="stat-preview__label">STR</span><span class="stat-preview__val">50</span></div>
              <div class="stat-preview__item"><span class="stat-preview__label">CON</span><span class="stat-preview__val">50</span></div>
              <div class="stat-preview__item"><span class="stat-preview__label">SIZ</span><span class="stat-preview__val">50</span></div>
              <div class="stat-preview__item"><span class="stat-preview__label">DEX</span><span class="stat-preview__val">50</span></div>
              <div class="stat-preview__item"><span class="stat-preview__label">APP</span><span class="stat-preview__val">50</span></div>
              <div class="stat-preview__item"><span class="stat-preview__label">INT</span><span class="stat-preview__val">50</span></div>
              <div class="stat-preview__item"><span class="stat-preview__label">POW</span><span class="stat-preview__val">50</span></div>
              <div class="stat-preview__item"><span class="stat-preview__label">EDU</span><span class="stat-preview__val">50</span></div>
            </div>
            <div v-else class="stat-preview__grid stat-preview__grid--dnd">
              <div class="stat-preview__item"><span class="stat-preview__label">STR</span><span class="stat-preview__val">10</span></div>
              <div class="stat-preview__item"><span class="stat-preview__label">DEX</span><span class="stat-preview__val">10</span></div>
              <div class="stat-preview__item"><span class="stat-preview__label">CON</span><span class="stat-preview__val">10</span></div>
              <div class="stat-preview__item"><span class="stat-preview__label">INT</span><span class="stat-preview__val">10</span></div>
              <div class="stat-preview__item"><span class="stat-preview__label">WIS</span><span class="stat-preview__val">10</span></div>
              <div class="stat-preview__item"><span class="stat-preview__label">CHA</span><span class="stat-preview__val">10</span></div>
            </div>
          </div>
          <div v-if="savedSessions.length > 0" class="saved-sessions">
            <h4 class="saved-sessions__title">继续游戏</h4>
            <div v-if="loadingSessions" class="saved-sessions__loading">加载中…</div>
            <div v-for="s in savedSessions.slice(0, 5)" :key="s.id" class="saved-sessions__item" @click="resumeSession(s)">
              <span class="saved-sessions__name">{{ s.playerName || '调查员' }}</span>
              <span class="saved-sessions__meta">{{ s.ruleset }} · {{ s.scene }} · 回合{{ s.round }}</span>
            </div>
          </div>
        </div>
        <button class="btn btn--primary" :disabled="loading || archetypeLoading" @click="startGame"><span v-if="loading" class="btn__spinner"></span><span v-else>开始新游戏</span></button>
        <!-- 剧本杀是另一条完整路径：线索门禁 + 多结局，不与自由跑团共享会话 -->
        <button class="btn btn--ghost" :disabled="scriptedLoading" @click="startScripted"><span v-if="scriptedLoading" class="btn__spinner"></span><span v-else>剧本杀《普瑞米尔的谷仓》</span></button>
        <p class="start-screen__mode-hint">自由跑团由守秘人即兴推进；剧本杀按写定的线索与结局走。</p>
        <p v-if="error" class="start-screen__error">{{ error }}</p>
      </div>
    </div>

    <div v-if="screen === 'scripted'" class="scripted-screen">
      <header class="scripted-bar">
        <span class="scripted-bar__title">《普瑞米尔的谷仓》</span>
        <span class="scripted-bar__meta">{{ scriptedLines.length }} 行 · {{ scriptedFinished ? '已结束' : (scriptedPending ? '等待抉择' : '推进中…') }}</span>
        <button class="bgm-toggle" :class="{ 'bgm-toggle--on': !voiceMuted }" @click="voiceMuted = !voiceMuted">{{ voiceMuted ? '语音 关' : '语音 开' }}</button>
        <button class="scripted-bar__exit" @click="exitScripted">退出</button>
        <button class="scripted-bar__exit" @click="clearOwnerAccess">Clear access</button>
      </header>

      <main class="scripted-log" ref="scriptedLogEl">
        <p v-for="(line, i) in scriptedLines" :key="i" class="scripted-line" :class="{ 'scripted-line--mech': line.includes('[检定]') }">{{ line }}</p>
        <p v-if="!scriptedLines.length" class="scripted-line scripted-line--dim">正在生成调查员…</p>
      </main>

      <footer class="scripted-choices">
        <p v-if="scriptedError" class="scripted-error">{{ scriptedError }}</p>
        <template v-if="scriptedPending">
          <p class="scripted-choices__hint">接下来去哪？</p>
          <button v-for="opt in scriptedPending.options" :key="opt" class="btn btn--ghost scripted-choice" @click="chooseScripted(opt)">{{ opt }}</button>
        </template>
        <p v-else-if="scriptedFinished" class="scripted-choices__hint">这一局结束了。</p>
        <p v-else class="scripted-choices__hint scripted-choices__hint--dim">守秘人正在推进…</p>
      </footer>
    </div>

    <div v-if="screen === 'game'" class="game-screen">
      <header class="status-bar">
        <div class="status-bar__row">
          <div class="status-bar__info"><span class="status-bar__label">会话</span><span class="status-bar__value status-bar__value--mono">{{ session.id.slice(-6) || '—' }}</span></div>
          <div class="status-bar__info"><span class="status-bar__label">{{ session.ruleset === 'dnd5e' ? '回合' : '轮' }}</span><span class="status-bar__value">{{ session.round || '—' }}</span></div>
          <div class="status-bar__info"><span class="status-bar__label">场景</span><span class="status-bar__value">{{ sceneLabel }}</span><button v-if="session.bgm" class="bgm-toggle" :class="{ 'bgm-toggle--on': !bgmMuted }" @click="bgmMuted = !bgmMuted">{{ bgmMuted ? '环境音 关' : '环境音 开' }}</button><button class="bgm-toggle" :class="{ 'bgm-toggle--on': !voiceMuted }" @click="voiceMuted = !voiceMuted">{{ voiceMuted ? '语音 关' : '语音 开' }}</button></div>
          <div class="status-bar__info" v-if="session.archetype"><span class="status-bar__label">职业</span><span class="status-bar__value">{{ archetypeLabel }}</span></div>
        </div>
        <div class="status-bar__stats">
          <div class="stat"><span class="stat__label">HP</span><div class="stat__track"><div class="stat__fill" :style="{ width: hpPercent + '%', background: hpColor }"></div></div><span class="stat__num">{{ session.hp }}/{{ session.maxHp }}</span></div>
          <div class="stat"><span class="stat__label">SAN</span><div class="stat__track"><div class="stat__fill" :style="{ width: sanPercent + '%', background: sanColor }"></div></div><span class="stat__num">{{ session.san }}/{{ session.maxSAN }}</span></div>
          <span class="insanity-badge" :class="{ 'insanity-badge--active': hasInsanity }">{{ session.indefInsanity ? '不定疯狂' : session.tempInsanity ? '临时疯狂' : '清醒' }}</span>
          <button v-if="ordinaryCharacterEditorVisibleForSession" class="kp-toggle-btn" :disabled="ordinaryCharacterEditorDisabled" @click="openOrdinaryCharacterEditor" title="编辑角色">📝</button>
          <button v-if="session.sessionKind === 'ordinary'" class="kp-toggle-btn" @click="kpVisible = !kpVisible" :class="{ 'kp-toggle-btn--active': kpVisible }" title="KP 控制台">📋</button>
          <button class="kp-toggle-btn" @click="moduleEditorVisible = !moduleEditorVisible" :class="{ 'kp-toggle-btn--active': moduleEditorVisible }" title="模组编辑器">📦</button>
          <button class="kp-toggle-btn" @click="settingsVisible = !settingsVisible" :class="{ 'kp-toggle-btn--active': settingsVisible }" title="设置">⚙️</button>
          <button class="kp-toggle-btn" @click="clearOwnerAccess" title="Clear owner access">↪</button>
        </div>
      </header>

      <SceneOverview v-if="session.scene" :scene="sceneLabel" :npcs="npcs" :monsters="monsters" :companions="companions" @inspect="(c) => { if (c._type === 'companion') openCharCard(c) }" />
      <div v-if="session.id" class="suggestion-bar"><span class="suggestion-bar__hint">💡 你可以：</span><button v-for="s in suggestions" :key="s" class="suggestion-bar__chip" :disabled="loading || sessionTerminal || ordinaryPendingKind" @click="submitAction(s)">{{ s }}</button></div>
      <CombatGrid v-if="companions.length > 0 || npcs.length > 0 || monsters.length > 0" :player="session" :companions="companions" :npcs="npcs" :monsters="monsters" @inspect="(e) => { if (e._type === 'companion') { const found = companions.find(c => c.id === e._id); if (found) openCharCard(found) } }" />

      <section class="companion-panel" :class="{ 'companion-panel--collapsed': !companionsExpanded }">
        <header class="companion-panel__header" @click="companionsExpanded = !companionsExpanded"><h2 class="companion-panel__title">同伴</h2><span class="companion-panel__count" v-if="companions.length">{{ companions.length }}</span><span class="companion-panel__toggle">{{ companionsExpanded ? '▾' : '▸' }}</span></header>
        <div v-if="companionsExpanded" class="companion-panel__body">
          <div v-if="companions.length === 0" class="companion-panel__empty"><p class="companion-panel__empty-text">当前没有同伴。</p><p class="companion-panel__empty-hint">输入「邀请 希尔妲」来招募。</p></div>
          <div v-for="c in companions" :key="c.id" class="companion-card" @click="openCharCard(c)">
            <div class="companion-card__header"><span class="companion-card__name">{{ c.name }}</span><span class="companion-card__badges"><span v-if="c.resolveState && c.resolveState !== 'normal'" class="companion-card__badge" :class="'companion-card__badge--' + c.resolveState">{{ c.resolveState === 'steadfast' ? '✦ 坚定' : c.resolveState === 'afflicted' ? '☠ 恐慌' : '🔥 疯狂' }}</span><span class="companion-card__badge" :class="c.control === 'auto' ? 'companion-card__badge--ai' : 'companion-card__badge--player'">{{ c.control === 'auto' ? '🤖 AI' : '🎮 玩家' }}</span></span></div>
            <div class="companion-card__stat"><span class="companion-card__stat-label">HP</span><div class="companion-card__track companion-card__track--hp"><div class="companion-card__fill" :style="{ width: c.maxHp > 0 ? Math.max(0, Math.round((c.hp / c.maxHp) * 100)) + '%' : '0%', background: (c.maxHp > 0 && (c.hp / c.maxHp) <= 0.25) ? '#ff4757' : (c.maxHp > 0 && (c.hp / c.maxHp) <= 0.5) ? '#ffa502' : '#2ed573' }"></div></div><span class="companion-card__stat-num">{{ c.hp }}/{{ c.maxHp }}</span></div>
            <div class="companion-card__stat"><span class="companion-card__stat-label">士气</span><div class="companion-card__track companion-card__track--morale"><div class="companion-card__fill" :style="{ width: Math.max(0, Math.min(100, (c.morale / 10) * 100)) + '%', background: c.morale <= 2.5 ? '#ff4757' : c.morale <= 5 ? '#ffa502' : '#2ed573' }"></div></div><span class="companion-card__stat-num">{{ c.morale }}/10</span></div>
            <div class="companion-card__info-row"><span class="companion-card__info-tag">{{ positionLabel(c.position) }}</span><span class="companion-card__info-tag">{{ behaviorLabel(c.behavior) }}</span><span class="companion-card__info-tag companion-card__info-tag--weapon" v-if="c.inventory?.length">{{ c.inventory[0] }}</span></div>
            <div class="companion-card__actions"><button class="companion-card__control-btn" :class="c.control === 'auto' ? 'companion-card__control-btn--takeover' : 'companion-card__control-btn--auto'" :disabled="loading" @click="toggleControl(c)">{{ c.control === 'auto' ? '🎮 接管' : '🤖 自动' }}</button></div>
          </div>
        </div>
      </section>

      <main class="narrative-log" ref="logEl">
        <div class="log-filter"><button v-for="f in [{k:'all',l:'全部'},{k:'narration',l:'叙事'},{k:'action',l:'行动'},{k:'system',l:'系统'},{k:'roll',l:'骰子'}]" :key="f.k" class="log-filter__btn" :class="{ 'log-filter__btn--active': logFilter === f.k }" @click="logFilter = f.k">{{ f.l }}</button></div>
        <div class="narrative-log__inner">
          <div v-for="msg in filteredMessages" :key="msg.id" class="message" :class="['message--' + msg.type, { 'message--verbatim': msg.verbatim }]"><span v-if="msg.speaker" class="message__speaker">{{ msg.speaker }}<span v-if="msg.verbatim" class="message__tag">模组原文</span></span><p class="message__content">{{ msg.content }}</p></div>
          <div v-if="loading" class="message message--loading"><span class="message__dots"><span class="message__dot">·</span><span class="message__dot">·</span><span class="message__dot">·</span></span><p class="message__content">思考中…</p></div>
        </div>
      </main>

      <div v-if="sessionTerminal" class="death-overlay"><div class="death-overlay__inner"><p class="death-overlay__title">{{ terminalTitle }}</p><p class="death-overlay__desc">{{ terminalDescription }}</p><button class="btn btn--primary" @click="newGame">开始新游戏</button></div></div>

      <footer class="input-area" :class="{ 'input-area--dead': sessionTerminal }">
        <p v-if="ordinaryPendingLabel" class="ordinary-pending" role="status">{{ ordinaryPendingLabel }}；普通操作控件已暂停。</p>
        <form v-if="ordinaryPartyMemberCreateVisibleForSession" class="party-member-create" @submit.prevent="submitPartyMemberCreate">
          <label class="party-member-create__label" for="ordinary-party-member-name">新增队友</label>
          <input id="ordinary-party-member-name" v-model="partyMemberName" class="party-member-create__name" type="text" maxlength="128" :disabled="ordinaryPartyMemberCreateDisabled" aria-label="队友姓名" />
          <select id="ordinary-party-member-archetype" v-model="partyMemberArchetype" class="party-member-create__archetype" :disabled="ordinaryPartyMemberCreateDisabled" aria-label="队友职业">
            <option value="" disabled>选择职业</option>
            <option v-for="archetype in archetypes" :key="archetype.id" :value="archetype.id">{{ archetype.label || archetype.id }}</option>
          </select>
          <button type="submit" class="btn party-member-create__submit" :disabled="ordinaryPartyMemberCreateDisabled">新增队友</button>
        </form>
        <form v-if="ordinaryLuckSpendVisibleForSession" class="luck-spend" @submit.prevent="submitLuckSpend">
          <label class="luck-spend__label" for="ordinary-luck-spend">幸运 {{ session.luck }}</label>
          <input id="ordinary-luck-spend" v-model="luckSpendAmount" class="luck-spend__amount" type="number" min="1" :max="session.luck" step="1" inputmode="numeric" :disabled="loading || sessionTerminal || ordinaryPendingKind || session.luck === 0" aria-label="花费幸运点数" />
          <button type="submit" class="btn luck-spend__submit" :disabled="ordinaryLuckSpendDisabled">花费幸运</button>
        </form>
        <form class="input-area__form" @submit.prevent="() => { submitAction(inputValue); inputValue = ''; focusInput() }">
          <select v-if="pcList.length > 1" v-model.number="activePc" class="input-area__pc-select" :disabled="loading || sessionTerminal || ordinaryPendingKind"><option v-for="(pc, i) in pcList" :key="pc.id" :value="i">{{ pc.name }}</option></select>
          <input ref="inputRef" v-model="inputValue" type="text" class="input-area__field" :disabled="loading || sessionTerminal || ordinaryPendingKind" :placeholder="sessionTerminal ? '旅程已结束……' : (loading ? '守秘人正在思考……' : '输入你的行动……')" autocomplete="off" @keydown="onInputKeydown"/>
          <button type="submit" class="btn btn--send" :disabled="loading || !inputValue.trim() || sessionTerminal || ordinaryPendingKind">发送</button>
        </form>
        <button class="input-area__restart" @click="newGame" :disabled="loading">新游戏</button>
      </footer>

      <div v-if="showCharCard" class="char-card-overlay" @click.self="closeCharCard"><div class="char-card-modal" @click.stop><button class="char-card-modal__close" @click="closeCharCard">✕</button><h2 class="char-card-modal__name">{{ selectedCompanion?.name }}</h2></div></div>

      <KPDashboard v-if="kpVisible && session.sessionKind === 'ordinary'" :session-id="session.id" :session-kind="session.sessionKind" :ordinary-generation="session.ordinaryGeneration" :pending-kind="ordinaryPendingKind" :busy="loading" :terminal="sessionTerminal ? session.terminal ?? { kind: 'legacy_unknown' } : null" @ordinary-message="submitOrdinaryKpMessage" @close="kpVisible = false"/>
      <ModuleEditor v-if="moduleEditorVisible" @close="moduleEditorVisible = false"/>
      <SettingsPanel v-if="settingsVisible" @close="settingsVisible = false"/>
      <CharacterEditor v-if="charEditorVisible && session.id && ordinaryCharacterEditorVisibleForSession && charEditorCharacter" :session-id="session.id" :character="charEditorCharacter" :sanity="charEditorSanity" :busy="loading || charEditorOpening" :pending-kind="ordinaryPendingKind" :status="charEditorStatus" @close="charEditorVisible = false" @save="saveOrdinaryCharacterPatch"/>
    </div>
  </div>
</template>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0b1210; color: #d8e4dd; min-height: 100dvh; }
.owner-auth-gate { min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: #0b1210; }
.owner-auth-gate__form { width: min(420px, 100%); display: grid; gap: 12px; padding: 24px; border: 1px solid #294338; border-radius: 12px; background: #111b17; }
.owner-auth-gate__form h1 { color: #a6cfb8; font-size: 1.4rem; }
.owner-auth-gate__form p { color: #a8b8af; line-height: 1.5; }
.owner-auth-gate__input { width: 100%; border: 1px solid #294338; border-radius: 6px; padding: 10px; background: #0d1612; color: #d8e4dd; }
.owner-auth-gate__error { color: #ff8b8b; }
.owner-auth-gate__clear { margin-left: auto; display: block; border: 1px solid var(--border-default); border-radius: 4px; padding: 4px 8px; color: var(--text-secondary); background: transparent; cursor: pointer; }
.trpg-app[data-ruleset="cosmic-horror"] {
  --surface-page: #0b1210; --surface-panel: #111b17; --surface-sunken: #0d1612; --surface-elevated: #16231d;
  --text-primary: #d8e4dd; --text-secondary: #a8b8af; --text-muted: #84978d; --border-default: #294338;
  --accent-primary: #78a990; --accent-strong: #a6cfb8; --accent-contrast: #08100c; --accent-soft: rgba(120, 169, 144, 0.12);
  --track-background: #24312b;
}
.trpg-app[data-ruleset="dnd5e"] {
  --surface-page: #17130c; --surface-panel: #211a0f; --surface-sunken: #1b150c; --surface-elevated: #2a2112;
  --text-primary: #eadfca; --text-secondary: #c0b091; --text-muted: #a9997e; --border-default: #544225;
  --accent-primary: #b38a35; --accent-strong: #d4ad58; --accent-contrast: #161006; --accent-soft: rgba(179, 138, 53, 0.12);
  --track-background: #3a301e;
}
.trpg-app { max-width: 800px; margin: 0 auto; width: 100%; padding: 16px; min-height: 100dvh; display: flex; flex-direction: column; background: var(--surface-page); color: var(--text-primary); transition: background-color 0.2s ease, color 0.2s ease; }
.screen--game { padding: 0; }
.start-screen { display: flex; justify-content: center; align-items: center; min-height: calc(100dvh - 32px); padding: 24px; }
.start-screen__inner { max-width: 420px; width: 100%; text-align: center; }
.start-screen__title { font-size: 2.5rem; color: var(--accent-strong); margin-bottom: 8px; }
.start-screen__subtitle { color: var(--text-secondary); margin-bottom: 24px; }
.start-screen__desc { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 32px; line-height: 1.6; }
.char-creation { display: flex; flex-direction: column; gap: 16px; margin-bottom: 24px; }
.char-creation__field { text-align: left; }
.char-creation__label { display: block; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px; }
.char-creation__input, .char-creation__select { width: 100%; padding: 10px 12px; background: var(--surface-sunken); border: 1px solid var(--border-default); border-radius: 8px; color: var(--text-primary); font-size: 1rem; outline: none; }
.char-creation__input:focus, .char-creation__select:focus { border-color: var(--accent-strong); }
.char-creation__hint { font-size: 0.8rem; color: var(--text-muted); margin-top: 4px; }
.stat-preview { margin-top: 16px; padding: 16px; background: var(--surface-panel); border: 1px solid var(--border-default); border-radius: 8px; }
.stat-preview__title { font-size: 0.72rem; color: var(--accent-primary); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
.stat-preview__grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.stat-preview__grid--dnd { grid-template-columns: repeat(3, 1fr); }
.stat-preview__item { display: flex; flex-direction: column; align-items: center; padding: 4px 0; }
.stat-preview__label { font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; }
.stat-preview__val { font-size: 1rem; font-weight: 600; }
.saved-sessions { margin-top: 24px; padding: 16px; max-height: 168px; overflow-y: auto; background: var(--surface-panel); border: 1px solid var(--border-default); border-radius: 8px; }
.saved-sessions__title { font-size: 0.72rem; color: var(--accent-primary); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
.saved-sessions__item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-radius: 6px; cursor: pointer; transition: background 0.15s; }
.saved-sessions__item:hover { background: var(--accent-soft); }
.saved-sessions__name { font-size: 0.85rem; font-weight: 500; }
.saved-sessions__meta { font-size: 0.65rem; color: var(--text-muted); }
.btn { padding: 10px 24px; border: 1px solid var(--accent-primary); border-radius: 8px; background: var(--accent-soft); color: var(--accent-strong); font-size: 1rem; cursor: pointer; }
.btn:hover:not(:disabled) { border-color: var(--accent-strong); color: var(--text-primary); }
.btn:focus-visible, .kp-toggle-btn:focus-visible, .suggestion-bar__chip:focus-visible, .log-filter__btn:focus-visible, .input-area__field:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 2px; }
.btn:disabled { opacity: 0.4; cursor: default; }
.kp-toggle-btn { background: transparent; border: 1px solid var(--border-default); color: var(--text-muted); border-radius: 6px; padding: 4px 8px; cursor: pointer; font-size: 16px; margin-left: 4px; transition: color 0.15s, border-color 0.15s, background-color 0.15s; }
.kp-toggle-btn:hover { color: var(--text-primary); border-color: var(--accent-primary); }
.kp-toggle-btn--active { color: var(--accent-strong); border-color: var(--accent-primary); background: var(--accent-soft); }
.suggestion-bar { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 0; }
.suggestion-bar__hint { font-size: 0.72rem; color: var(--text-muted); align-self: center; }
.suggestion-bar__chip { padding: 4px 10px; border: 1px solid var(--border-default); border-radius: 12px; background: transparent; color: var(--text-secondary); font-size: 0.72rem; cursor: pointer; transition: color 0.15s, border-color 0.15s, background-color 0.15s; }
.suggestion-bar__chip:hover { color: var(--accent-strong); border-color: var(--accent-primary); background: var(--accent-soft); }
.companion-panel { flex-shrink: 0; background: var(--surface-panel); border: 1px solid var(--border-default); border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
.companion-panel__header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; }
.companion-panel__title { font-size: 0.8rem; color: var(--accent-primary); }
.companion-panel__count { font-size: 0.7rem; color: var(--text-muted); }
.companion-panel__toggle { margin-left: auto; color: var(--text-muted); }
.companion-panel__body { display: flex; gap: 8px; padding: 0 12px 8px; overflow-x: auto; }
.companion-card { flex: 0 0 180px; padding: 8px 10px; background: var(--surface-sunken); border: 1px solid var(--border-default); border-radius: 8px; cursor: pointer; }
.companion-card__header { display: flex; justify-content: space-between; margin-bottom: 6px; }
.companion-card__name { font-weight: 600; font-size: 0.8rem; }
.companion-card__badges { display: flex; gap: 4px; }
.companion-card__badge { font-size: 0.6rem; padding: 1px 5px; border-radius: 4px; }
.companion-card__badge--steadfast { background: rgba(143, 188, 143, 0.2); color: #8fbc8f; }
.companion-card__badge--afflicted { background: rgba(221, 160, 221, 0.2); color: #dda0dd; }
.companion-card__badge--berserk { background: rgba(255, 107, 107, 0.2); color: #ff6b6b; }
.companion-card__badge--ai { background: rgba(100, 149, 237, 0.2); color: #6495ed; }
.companion-card__badge--player { background: var(--accent-soft); color: var(--accent-strong); }
.companion-card__stat { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; font-size: 0.72rem; }
.companion-card__stat-label { color: var(--text-muted); min-width: 24px; }
.companion-card__track { flex: 1; height: 6px; background: var(--track-background); border-radius: 3px; overflow: hidden; }
.companion-card__fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
.companion-card__stat-num { min-width: 32px; text-align: right; color: var(--text-secondary); font-size: 0.7rem; }
.companion-card__info-row { display: flex; gap: 4px; flex-wrap: wrap; margin: 4px 0; }
.companion-card__info-tag { font-size: 0.6rem; padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,0.05); }
.companion-card__actions { display: flex; gap: 4px; width: 100%; }
.companion-card__action-btn { padding: 5px 8px; border: 1px solid var(--border-default); border-radius: 6px; background: var(--surface-elevated); color: var(--text-muted); font-size: 14px; cursor: pointer; }
.companion-card__action-btn:hover { background: rgba(255,255,255,0.1); }
.companion-card__control-btn { flex: 1; padding: 5px 8px; border: 1px solid var(--border-default); border-radius: 6px; background: var(--surface-elevated); color: var(--text-muted); font-size: 0.72rem; cursor: pointer; }
.companion-card__control-btn--takeover { background: var(--accent-soft); border-color: var(--accent-primary); color: var(--accent-strong); }
.companion-card__control-btn--auto { background: rgba(255,255,255,0.04); }
.narrative-log { flex: 1; overflow-y: auto; padding: 8px 0; min-height: 0; }
.log-filter { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; }
.log-filter__btn { padding: 3px 10px; border: 1px solid var(--border-default); border-radius: 12px; background: transparent; color: var(--text-muted); font-size: 0.72rem; cursor: pointer; }
.log-filter__btn:hover { color: var(--text-primary); }
.log-filter__btn--active { background: var(--accent-primary); color: var(--accent-contrast); font-weight: 600; }
.narrative-log__inner { display: flex; flex-direction: column; gap: 8px; padding: 0 12px; }
.message { padding: 6px 10px; border-radius: 6px; }
.message--narration { background: transparent; border-bottom: 1px solid var(--border-default); border-radius: 0; }
.message--action { border-left: 3px solid var(--accent-primary); background: var(--accent-soft); }
.message--system { border-left: 3px solid #e05555; background: rgba(224, 85, 85, 0.05); }
.message--roll { border-left: 3px solid var(--accent-primary); background: var(--accent-soft); }
.message--roll .message__speaker { color: var(--accent-strong); font-size: 1.1rem; }
.message--roll .message__content { color: var(--text-secondary); font-family: monospace; }
.message__speaker { font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 2px; }
.bgm-toggle { margin-left: 8px; padding: 1px 6px; background: none; border: 1px solid var(--text-muted); border-radius: 2px; color: var(--text-muted); font-size: 0.65rem; cursor: pointer; }
.bgm-toggle--on { border-color: var(--accent-strong); color: var(--accent-strong); }
/* 模组原文逐字朗读 —— 与 KP 即兴叙述区分开，沿用跑团「框文」的视觉惯例 */
.message--verbatim { border-left: 2px solid var(--accent-strong); padding-left: 10px; }
.message--verbatim .message__content { font-style: italic; color: var(--text-secondary); }

/* ── 剧本杀 ── */
.start-screen__mode-hint { margin: 6px 0 0; font-size: 0.72rem; color: var(--text-muted); line-height: 1.5; }
.scripted-screen { display: flex; flex-direction: column; height: 100vh; }
.scripted-bar { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
.scripted-bar__title { font-weight: 600; }
.scripted-bar__meta { color: var(--text-muted); font-size: 0.75rem; }
.scripted-bar__exit { margin-left: auto; padding: 2px 8px; background: none; border: 1px solid var(--text-muted); border-radius: 2px; color: var(--text-muted); font-size: 0.7rem; cursor: pointer; }
.scripted-log { flex: 1; overflow-y: auto; padding: 16px 20px; }
/* 播报本身带缩进和分隔线，等宽字体才不会把排版拆散 */
.scripted-line { margin: 0; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.82rem; line-height: 1.7; white-space: pre-wrap; }
.scripted-line--mech { color: var(--text-muted); }
.scripted-line--dim { color: var(--text-muted); font-style: italic; }
.scripted-choices { padding: 12px 20px; border-top: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.scripted-choices__hint { width: 100%; margin: 0 0 4px; font-size: 0.78rem; color: var(--text-secondary); }
.scripted-choices__hint--dim { color: var(--text-muted); }
.scripted-choice { font-size: 0.8rem; }
.scripted-error { width: 100%; margin: 0 0 6px; color: var(--danger, #c0392b); font-size: 0.78rem; }
.message__tag { margin-left: 6px; padding: 0 4px; border: 1px solid var(--text-muted); border-radius: 2px; font-size: 0.65rem; letter-spacing: 0.02em; }
.message__content { line-height: 1.5; font-size: 0.95rem; }
.message--loading { text-align: center; color: var(--text-muted); }
.death-overlay { position: fixed; inset: 0; z-index: 8000; background: rgba(0,0,0,0.8); display: flex; justify-content: center; align-items: center; }
.death-overlay__title { font-size: 2rem; color: #ff6b6b; margin-bottom: 16px; }
.death-overlay__desc { color: var(--text-muted); margin-bottom: 24px; }
.input-area { display: flex; gap: 8px; align-items: center; padding: 8px 0; }
.input-area__form { display: flex; gap: 8px; align-items: center; flex: 1; }
.luck-spend { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.luck-spend__label { color: var(--accent-strong); font-size: 0.75rem; white-space: nowrap; }
.luck-spend__amount { width: 5.5rem; padding: 6px 8px; border: 1px solid var(--border-default); border-radius: 6px; background: var(--surface-sunken); color: var(--text-primary); }
.luck-spend__amount:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 2px; }
.luck-spend__submit { padding: 6px 10px; font-size: 0.75rem; }
.party-member-create { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.party-member-create__label { color: var(--accent-strong); font-size: 0.75rem; white-space: nowrap; }
.party-member-create__name, .party-member-create__archetype { max-width: 9rem; padding: 6px 8px; border: 1px solid var(--border-default); border-radius: 6px; background: var(--surface-sunken); color: var(--text-primary); }
.party-member-create__submit { padding: 6px 10px; font-size: 0.75rem; }
.ordinary-pending { width: 100%; margin: 0; color: var(--accent-strong); font-size: 0.75rem; }
.input-area__pc-select { padding: 4px 8px; border: 1px solid var(--border-default); border-radius: 6px; background: var(--surface-sunken); color: var(--text-primary); font-size: 0.8rem; cursor: pointer; }
.input-area__field { flex: 1; padding: 8px 12px; background: var(--surface-sunken); border: 1px solid var(--border-default); border-radius: 8px; color: var(--text-primary); font-size: 1rem; outline: none; }
.input-area__field:focus { border-color: var(--accent-strong); }
.btn--send { padding: 8px 16px; }
.input-area__restart { background: none; border: none; color: var(--text-muted); font-size: 0.72rem; cursor: pointer; }
.status-bar { flex-shrink: 0; border-bottom: 1px solid var(--border-default); margin-bottom: 8px; padding-bottom: 8px; }
.status-bar__row { display: flex; gap: 16px; font-size: 0.75rem; margin-bottom: 8px; }
.status-bar__info { display: flex; gap: 4px; }
.status-bar__label { color: var(--text-muted); }
.status-bar__value { color: var(--accent-strong); }
.status-bar__stats { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.stat { display: flex; align-items: center; gap: 4px; font-size: 0.75rem; }
.stat__label { color: var(--text-muted); min-width: 28px; }
.stat__track { width: 60px; height: 6px; background: var(--track-background); border-radius: 3px; overflow: hidden; }
.stat__fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
.stat__num { color: var(--text-secondary); font-size: 0.7rem; min-width: 40px; }
.insanity-badge { font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; background: var(--surface-elevated); color: var(--text-muted); }
.insanity-badge--active { background: rgba(255, 107, 107, 0.15); color: #ff6b6b; }
@media (min-width: 781px) { .game-screen { border-left: 1px solid var(--border-default); border-right: 1px solid var(--border-default); } }
@media (max-width: 480px) {
  .trpg-app { padding: 12px; }
  .start-screen { align-items: flex-start; min-height: calc(100dvh - 24px); padding: 12px 8px; }
  .start-screen__title { font-size: 2rem; margin-bottom: 4px; }
  .start-screen__subtitle { margin-bottom: 12px; }
  .start-screen__desc { margin-bottom: 16px; line-height: 1.45; }
  .char-creation { gap: 12px; margin-bottom: 12px; }
  .stat-preview { margin-top: 8px; padding: 12px; }
  .saved-sessions { margin-top: 12px; padding: 12px; max-height: 124px; }
}
</style>
