<script setup>
import { reactive, ref, watch } from 'vue'

const props = defineProps({
  sessionId: String,
  character: Object,
  sanity: Object,
  busy: Boolean,
  pendingKind: String,
  status: String,
})
const emit = defineEmits(['close', 'save'])

const form = reactive({})
const skills = reactive({})
const attributes = reactive({})
const inventory = ref([])
const weapons = ref([])

function replaceRecord(target, source) {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, source ?? {})
}

watch(() => props.character, (character) => {
  if (!character) return
  Object.assign(form, {
    hp: character.hp ?? 10,
    maxHp: character.maxHp ?? 10,
    luck: character.luck ?? 60,
    creditRating: character.creditRating ?? 30,
  })
  replaceRecord(skills, character.skills)
  replaceRecord(attributes, character.attributes)
  inventory.value = [...(character.inventory ?? [])]
  weapons.value = [...(character.weapons ?? [])]
}, { immediate: true })

function addItem(target, label) {
  const item = prompt(label)
  if (item) target.push(item)
}
function removeItem(target, index) { target.splice(index, 1) }

function save() {
  if (props.busy || props.pendingKind) return
  // This component never posts directly. The owner App persists first and
  // confirms with an authoritative GET before it updates this visible sheet.
  emit('save', {
    hp: form.hp,
    maxHp: form.maxHp,
    luck: form.luck,
    creditRating: form.creditRating,
    skills: { ...skills },
    attributes: { ...attributes },
    inventory: [...inventory.value],
    weapons: [...weapons.value],
  })
}
</script>

<template>
  <Teleport to="body">
    <div class="ce-overlay" @click.self="emit('close')">
      <section class="ce-panel" @click.stop>
        <header class="ce-header">
          <div>
            <h2>Character editor - {{ props.character?.name ?? '-' }}</h2>
            <small>{{ props.character?.archetype ?? '' }}</small>
          </div>
          <button class="ce-btn" :disabled="props.busy" @click="emit('close')">Close</button>
        </header>
        <div class="ce-body" :aria-busy="props.busy">
          <p v-if="props.status || props.pendingKind" class="ce-msg">{{ props.status || 'A durable character update is awaiting confirmation.' }}</p>
          <fieldset :disabled="props.busy || !!props.pendingKind">
            <h4>Sheet</h4>
            <div class="ce-row">
              <label>HP <input v-model.number="form.hp" type="number" min="0" max="999"></label>
              <label>Max HP <input v-model.number="form.maxHp" type="number" min="1" max="999"></label>
              <label>Luck <input v-model.number="form.luck" type="number" min="0" max="99"></label>
              <label>Credit <input v-model.number="form.creditRating" type="number" min="0" max="99"></label>
            </div>
            <p>SAN {{ props.sanity?.currentSAN ?? '-' }} / {{ props.sanity?.maxSAN ?? '-' }}</p>
            <h4>Skills</h4>
            <div v-for="(value, name) in skills" :key="name" class="ce-row">
              <span>{{ name }}</span><input v-model.number="skills[name]" type="number" min="0" max="100">
            </div>
            <h4>Attributes</h4>
            <div v-for="(value, name) in attributes" :key="name" class="ce-row">
              <span>{{ name }}</span><input v-model.number="attributes[name]" type="number" min="1" max="100">
            </div>
            <h4>Inventory</h4>
            <div v-for="(item, index) in inventory" :key="`inventory-${index}`" class="ce-row">
              <span>{{ item }}</span><button class="ce-btn" @click="removeItem(inventory, index)">Remove</button>
            </div>
            <button class="ce-btn" @click="addItem(inventory, 'Inventory item')">Add item</button>
            <h4>Weapons</h4>
            <div v-for="(item, index) in weapons" :key="`weapon-${index}`" class="ce-row">
              <span>{{ item }}</span><button class="ce-btn" @click="removeItem(weapons, index)">Remove</button>
            </div>
            <button class="ce-btn" @click="addItem(weapons, 'Weapon')">Add weapon</button>
          </fieldset>
          <footer class="ce-actions">
            <button class="ce-btn" :disabled="props.busy" @click="emit('close')">Cancel</button>
            <button class="ce-btn ce-btn--primary" :disabled="props.busy || !!props.pendingKind" @click="save">{{ props.busy ? 'Confirming...' : 'Save durable patch' }}</button>
          </footer>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.ce-overlay { position: fixed; inset: 0; z-index: 9000; display: grid; place-items: center; padding: 16px; background: rgb(0 0 0 / 70%); }
.ce-panel { width: min(560px, 100%); max-height: 90vh; overflow: auto; border: 1px solid #3a3a5c; border-radius: 12px; background: #1a1a2e; color: #e0e0e0; }
.ce-header, .ce-actions, .ce-row { display: flex; gap: 8px; align-items: center; }
.ce-header { justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #3a3a5c; }
.ce-header h2, h4 { margin: 0; color: #c9a96e; }
.ce-body { padding: 16px; }
.ce-body fieldset { display: grid; gap: 8px; border: 0; padding: 0; margin: 0; }
.ce-row { flex-wrap: wrap; }
.ce-row label { display: grid; gap: 2px; color: #aaa; }
input { width: 72px; padding: 4px; border: 1px solid #3a3a5c; border-radius: 4px; background: #141428; color: inherit; }
.ce-btn { padding: 5px 9px; border: 1px solid #3a3a5c; border-radius: 5px; background: #2a2a4a; color: inherit; cursor: pointer; }
.ce-btn:disabled { cursor: wait; opacity: .6; }
.ce-btn--primary { border-color: #c9a96e; color: #c9a96e; }
.ce-actions { justify-content: end; margin-top: 16px; padding-top: 12px; border-top: 1px solid #3a3a5c; }
.ce-msg { color: #c9a96e; }
</style>
