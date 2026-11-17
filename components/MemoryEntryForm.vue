<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { LongTermFact, MemorySource, WorkingMemoryEntry } from '~/shared/memory'
import { useMemory } from '~/composables/useMemory'

const props = defineProps<{
  open: boolean
  layer: 'working' | 'long_term'
  projectId?: string
  source?: MemorySource
  initialText?: string
  entry?: WorkingMemoryEntry | LongTermFact
}>()

const emit = defineEmits<{
  saved: [entry: WorkingMemoryEntry | LongTermFact]
  cancel: []
}>()

const memory = useMemory()
const key = ref('')
const value = ref('')
const workingCategory = ref<WorkingMemoryEntry['category']>('note')
const longTermCategory = ref<LongTermFact['category']>('knowledge')
const enabled = ref(true)
const global = ref(false)
const projectIds = ref<string[]>([])
const saving = ref(false)
const error = ref<string | null>(null)
const isEditing = computed(() => Boolean(props.entry))
const activeLayer = ref(props.layer)

function reset(): void {
  const entry = props.entry
  activeLayer.value = props.layer
  key.value = entry?.key ?? ''
  value.value = entry?.value ?? props.initialText ?? ''
  enabled.value = entry?.enabled ?? true
  if (activeLayer.value === 'working') {
    workingCategory.value = (entry as WorkingMemoryEntry | undefined)?.category ?? 'note'
  } else {
    longTermCategory.value = (entry as LongTermFact | undefined)?.category ?? 'knowledge'
    global.value = (entry as LongTermFact | undefined)?.global ?? false
    projectIds.value = [...((entry as LongTermFact | undefined)?.projectIds ?? [])]
  }
  error.value = null
}

watch(() => [props.open, props.layer], ([open]) => { if (open) reset() })
watch(() => props.entry, reset)

async function save(): Promise<void> {
  if (!key.value.trim() || !value.value.trim()) {
    error.value = 'Укажите ключ и значение.'
    return
  }
  if (activeLayer.value === 'working' && !props.projectId && !props.entry) {
    error.value = 'Для рабочей памяти выберите проект.'
    return
  }
  saving.value = true
  error.value = null
  try {
    if (activeLayer.value === 'working') {
      const entry = props.entry as WorkingMemoryEntry | undefined
      const result = await memory.saveWorking(entry
        ? { id: entry.id, category: workingCategory.value, key: key.value, value: value.value, enabled: enabled.value, expectedRevision: entry.revision }
        : { projectId: props.projectId!, category: workingCategory.value, key: key.value, value: value.value, enabled: enabled.value, ...props.source })
      emit('saved', result)
    } else {
      const entry = props.entry as LongTermFact | undefined
      const result = await memory.saveLongTerm(entry
        ? { id: entry.id, category: longTermCategory.value, key: key.value, value: value.value, enabled: enabled.value, global: global.value, projectIds: projectIds.value, expectedRevision: entry.revision }
        : { category: longTermCategory.value, key: key.value, value: value.value, enabled: enabled.value, global: global.value, projectIds: projectIds.value, ...props.source })
      emit('saved', result)
    }
  } catch (caughtError) {
    error.value = caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить запись.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="props.open" class="memory-form-backdrop" @click.self="emit('cancel')">
    <form class="memory-form" role="dialog" aria-modal="true" @submit.prevent="save">
      <header class="memory-form__header">
        <div>
          <p class="memory-form__eyebrow">{{ activeLayer === 'working' ? 'Рабочая память' : 'Долговременная память' }}</p>
          <h2>{{ isEditing ? 'Изменить запись' : 'Сохранить в память' }}</h2>
        </div>
        <button type="button" class="memory-form__close" aria-label="Закрыть" @click="emit('cancel')">×</button>
      </header>
      <div class="memory-form__body">
        <p class="memory-form__hint">Запись попадёт в контекст только по правилам выбранного слоя. Сохранение выполняется вручную и не вызывает модель.</p>
        <label v-if="!isEditing"><span>Слой</span><select v-model="activeLayer"><option value="working">Рабочая память</option><option value="long_term">Долговременная память</option></select></label>
        <label><span>Категория</span><select v-if="activeLayer === 'working'" v-model="workingCategory"><option value="goal">Цель</option><option value="constraint">Ограничение</option><option value="state">Состояние</option><option value="result">Результат</option><option value="note">Заметка</option></select><select v-else v-model="longTermCategory"><option value="profile">Профиль</option><option value="decision">Решение</option><option value="knowledge">Знание</option></select></label>
        <label><span>Ключ</span><input v-model="key" maxlength="80" autocomplete="off" placeholder="Например, цель проекта"></label>
        <label><span>Значение</span><textarea v-model="value" maxlength="10000" rows="6" placeholder="Короткий подтверждённый факт"></textarea></label>
        <label class="memory-form__toggle"><input v-model="enabled" type="checkbox"><span>Включать в контекст</span></label>
        <template v-if="activeLayer === 'long_term'">
          <label class="memory-form__toggle"><input v-model="global" type="checkbox"><span>Глобальный факт для всех проектов</span></label>
          <label><span>Проекты (ID через запятую)</span><input :value="projectIds.join(', ')" autocomplete="off" placeholder="Можно оставить пустым" @input="projectIds = ($event.target as HTMLInputElement).value.split(',').map(item => item.trim()).filter(Boolean)"></label>
          <p class="memory-form__hint">Без глобального флага и подключённых проектов факт хранится, но не попадёт в промпт.</p>
        </template>
        <p v-if="props.source" class="memory-form__source">Источник: сообщение текущего диалога</p>
        <p v-if="error" class="memory-form__error" role="alert">{{ error }}</p>
      </div>
      <footer class="memory-form__footer"><button type="button" @click="emit('cancel')">Отмена</button><button type="submit" :disabled="saving">{{ saving ? 'Сохраняем…' : 'Сохранить' }}</button></footer>
    </form>
  </div>
</template>

<style scoped>
.memory-form-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 1rem; background: rgb(15 23 42 / 42%); }
.memory-form { width: min(36rem, 100%); max-height: min(48rem, 100%); overflow: auto; border: 1px solid #dbe4ef; border-radius: 1rem; background: #fff; box-shadow: 0 1.5rem 4rem rgb(15 23 42 / 22%); }
.memory-form__header, .memory-form__footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.2rem; }
.memory-form__header { border-bottom: 1px solid #e2e8f0; }
.memory-form__header h2 { margin: 0; color: #172033; font-size: 1.15rem; }
.memory-form__eyebrow { margin: 0 0 .2rem; color: #64748b; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; }
.memory-form__close { border: 0; color: #64748b; background: transparent; font-size: 1.5rem; cursor: pointer; }
.memory-form__body { display: grid; gap: .8rem; padding: 1.2rem; }
.memory-form__body label { display: grid; gap: .35rem; color: #334155; font-size: .78rem; font-weight: 600; }
.memory-form__body input, .memory-form__body textarea, .memory-form__body select { width: 100%; border: 1px solid #cbd5e1; border-radius: .5rem; padding: .55rem .65rem; color: #1e293b; background: #fff; font: inherit; font-weight: 400; }
.memory-form__body textarea { resize: vertical; }
.memory-form__hint, .memory-form__source, .memory-form__error { margin: 0; color: #64748b; font-size: .74rem; line-height: 1.4; }
.memory-form__error { color: #b42318; }
.memory-form__toggle { display: flex !important; align-items: center; gap: .5rem; }
.memory-form__toggle input { width: 1rem; }
.memory-form__footer { justify-content: flex-end; border-top: 1px solid #e2e8f0; }
.memory-form__footer button { border: 1px solid #cbd5e1; border-radius: .5rem; padding: .55rem .85rem; color: #475569; background: #fff; font: inherit; font-size: .8rem; font-weight: 600; cursor: pointer; }
.memory-form__footer button[type='submit'] { border-color: #1e293b; color: #fff; background: #1e293b; }
</style>
