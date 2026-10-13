<script setup>
import { computed } from 'vue'

const props = defineProps({
  scene: { type: String, default: '' },
  npcs: { type: Array, default: () => [] },
  monsters: { type: Array, default: () => [] },
  companions: { type: Array, default: () => [] },
  combatActive: { type: Boolean, default: false },
})

const emit = defineEmits(['inspect'])

const interactiveNpcs = computed(() => props.npcs.filter(n => n.hp > 0).map(n => ({ ...n, _type: 'npc' })))
const interactiveMonsters = computed(() => props.monsters.filter(m => m.hp > 0).map(m => ({ ...m, _type: 'monster' })))
const allies = computed(() => props.companions.filter(c => c.hp > 0).map(c => ({ ...c, _type: 'companion' })))
const empty = computed(() => interactiveNpcs.value.length === 0 && interactiveMonsters.value.length === 0 && allies.value.length === 0)
</script>

<template>
  <div class="so-panel" v-if="scene">
    <div class="so-header">
      <span class="so-scene-label">{{ scene }}</span>
      <span v-if="combatActive" class="so-badge so-badge--combat">⚔️ 战斗中</span>
    </div>
    <div v-if="empty" class="so-empty"><p>当前场景没有可交互的元素。</p></div>
    <div v-if="interactiveNpcs.length > 0" class="so-section">
      <h4 class="so-section-title">👤 NPC ({{ interactiveNpcs.length }})</h4>
      <div v-for="n in interactiveNpcs" :key="n.name" class="so-entity so-entity--static">
        <span class="so-entity-name">{{ n.name }}</span>
        <span class="so-entity-hp" :style="{ color: n.hp / n.maxHp <= 0.25 ? '#ff4757' : '#2ed573' }">{{ n.hp }}/{{ n.maxHp }}</span>
      </div>
    </div>
    <div v-if="interactiveMonsters.length > 0" class="so-section">
      <h4 class="so-section-title so-section-title--enemy">👹 敌人 ({{ interactiveMonsters.length }})</h4>
      <div v-for="m in interactiveMonsters" :key="m.name" class="so-entity so-entity--enemy">
        <span class="so-entity-name">{{ m.name }}</span>
        <span class="so-entity-hp" style="color:#ff4757">{{ m.hp }}/{{ m.maxHp }}</span>
      </div>
    </div>
    <div v-if="allies.length > 0" class="so-section">
      <h4 class="so-section-title">👥 友方 ({{ allies.length }})</h4>
      <div v-for="c in allies" :key="c.id" class="so-entity" @click="emit('inspect', c)">
        <span class="so-entity-name">{{ c.name }}</span>
        <span class="so-entity-hp" :style="{ color: c.hp / c.maxHp <= 0.25 ? '#ff4757' : '#2ed573' }">{{ c.hp }}/{{ c.maxHp }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.so-panel { background: #1e1e3a; border: 1px solid #2a2a4a; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; font-size: 12px; }
.so-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.so-scene-label { color: #c9a96e; font-weight: 600; font-size: 13px; }
.so-badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; }
.so-badge--combat { background: #3a1010; color: #ff6b6b; }
.so-empty { color: #555; text-align: center; padding: 8px 0; font-size: 11px; }
.so-section { margin-bottom: 6px; }
.so-section-title { font-size: 11px; color: #888; margin: 0 0 4px; }
.so-section-title--enemy { color: #ff6b6b; }
.so-entity { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 4px; cursor: pointer; transition: background 0.15s; }
.so-entity--static { cursor: default; }
.so-entity:hover { background: rgba(255,255,255,0.05); }
.so-entity--enemy { cursor: default; }
.so-entity-name { flex: 1; color: #ccc; }
.so-entity-hp { font-size: 11px; min-width: 40px; text-align: right; }
@media (max-width: 480px) { .so-panel { font-size: 11px; } .so-entity { flex-wrap: wrap; } }
</style>
