<script setup lang="ts">
import type { HistoryClearResult } from '~/shared/memory'

const props = defineProps<{
  open: boolean
  layer: 'short_term' | 'working' | 'long_term'
  scopeLabel: string
  affectedCount: number
  pending?: HistoryClearResult
}>()

const emit = defineEmits<{ confirm: []; cancel: []; retry: [] }>()
const title = () => props.layer === 'short_term' ? 'Очистить историю диалога?' : props.layer === 'working' ? 'Очистить рабочую память?' : 'Очистить долговременную память?'
</script>

<template>
  <div v-if="props.open" class="memory-form-backdrop" @click.self="emit('cancel')">
    <section class="memory-clear-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-clear-title">
      <p class="memory-eyebrow">{{ props.scopeLabel }}</p>
      <h2 id="memory-clear-title">{{ title() }}</h2>
      <p v-if="props.pending?.status === 'failed'" class="memory-error">Предыдущая попытка не завершила удаление лог-файла: {{ props.pending.error }}. Повтор можно выполнить безопасно.</p>
      <p v-else>Будет удалено элементов: {{ props.affectedCount }}. Соседние слои памяти не изменятся.</p>
      <p v-if="props.layer === 'short_term'" class="memory-muted">История сообщений и производные данные этого диалога будут удалены. Проект, рабочие и долговременные записи сохранятся.</p>
      <footer><button type="button" @click="emit('cancel')">Отмена</button><button type="button" class="memory-button--danger" @click="props.pending ? emit('retry') : emit('confirm')">{{ props.pending ? 'Повторить очистку' : 'Очистить' }}</button></footer>
    </section>
  </div>
</template>

<style scoped>
.memory-clear-dialog { width: min(32rem, 100%); border: 1px solid #dbe4ef; border-radius: 1rem; padding: 1.25rem; background: #fff; box-shadow: 0 1.5rem 4rem rgb(15 23 42 / 22%); }
.memory-clear-dialog h2 { margin: .2rem 0 .7rem; color: #172033; font-size: 1.15rem; }
.memory-clear-dialog p { color: #475569; font-size: .82rem; line-height: 1.5; }
.memory-clear-dialog footer { display: flex; justify-content: flex-end; gap: .5rem; margin-top: 1rem; }
.memory-clear-dialog button { border: 1px solid #cbd5e1; border-radius: .45rem; padding: .5rem .7rem; color: #475569; background: #fff; font: inherit; font-size: .75rem; cursor: pointer; }
.memory-clear-dialog .memory-button--danger { border-color: #b91c1c; color: #fff; background: #b91c1c; }
</style>
