<script setup lang="ts">
import type { LongTermFact, WorkingMemoryEntry } from '~/shared/memory'

const props = defineProps<{
  layer: 'working' | 'long_term'
  items: Array<WorkingMemoryEntry | LongTermFact>
  loading?: boolean
  error?: string | null
  hasMore?: boolean
}>()

const emit = defineEmits<{
  edit: [entry: WorkingMemoryEntry | LongTermFact]
  delete: [entry: WorkingMemoryEntry | LongTermFact]
  toggle: [entry: WorkingMemoryEntry | LongTermFact]
  loadMore: []
}>()

function isGlobal(entry: WorkingMemoryEntry | LongTermFact): boolean {
  return 'global' in entry && entry.global
}
</script>

<template>
  <section class="memory-card memory-record-list" :aria-label="props.layer === 'working' ? 'Рабочая память' : 'Долговременная память'">
    <div class="memory-card__heading"><div><p class="memory-eyebrow">{{ props.layer === 'working' ? 'Проект' : 'Общие факты' }}</p><h2>{{ props.layer === 'working' ? 'Рабочие записи' : 'Долговременные факты' }}</h2></div><span class="memory-muted">{{ props.items.length }} на странице</span></div>
    <div v-if="props.loading" class="memory-empty" role="status">Загружаем записи…</div>
    <div v-else-if="props.error" class="memory-error" role="alert">{{ props.error }}</div>
    <div v-else-if="props.items.length === 0" class="memory-empty">Записей пока нет. Сохранение выполняется только после явного подтверждения.</div>
    <div v-else class="memory-records">
      <article v-for="entry in props.items" :key="entry.id" class="memory-record" :class="{ 'memory-record--disabled': !entry.enabled }">
        <div class="memory-record__heading"><span class="memory-record__category">{{ entry.category }}</span><span class="memory-record__key">{{ entry.key }}</span><span v-if="!entry.enabled" class="memory-record__state">отключено</span><span v-if="props.layer === 'long_term' && isGlobal(entry)" class="memory-record__global">глобально</span></div>
        <p class="memory-record__value">{{ entry.value }}</p>
        <p class="memory-record__meta">Ревизия {{ entry.revision }} · {{ entry.sourceMessageId ? 'есть источник' : 'источник недоступен' }}</p>
        <div class="memory-record__actions"><button type="button" @click="emit('toggle', entry)">{{ entry.enabled ? 'Отключить' : 'Включить' }}</button><button type="button" @click="emit('edit', entry)">Изменить</button><button type="button" class="memory-danger" @click="emit('delete', entry)">Удалить</button></div>
      </article>
    </div>
    <button v-if="props.hasMore" class="memory-button" type="button" @click="emit('loadMore')">Загрузить ещё</button>
  </section>
</template>

<style scoped>
.memory-records { display: grid; gap: .6rem; }
.memory-record { border: 1px solid #dbe4ef; border-radius: .65rem; padding: .75rem; background: #fff; }
.memory-record--disabled { opacity: .62; }
.memory-record__heading { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; }
.memory-record__category { border-radius: .35rem; padding: .15rem .35rem; color: #1d4ed8; background: #dbeafe; font-size: .68rem; font-weight: 700; text-transform: uppercase; }
.memory-record__key { color: #1e293b; font-size: .82rem; font-weight: 700; }
.memory-record__state, .memory-record__global { color: #b45309; font-size: .7rem; }
.memory-record__global { color: #047857; }
.memory-record__value { margin: .55rem 0; color: #334155; font-size: .82rem; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.memory-record__meta { margin: 0; color: #94a3b8; font-size: .7rem; }
.memory-record__actions { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .6rem; }
.memory-record__actions button, .memory-button { border: 1px solid #cbd5e1; border-radius: .4rem; padding: .35rem .55rem; color: #475569; background: #fff; font: inherit; font-size: .7rem; cursor: pointer; }
.memory-record__actions .memory-danger { color: #b91c1c; }
.memory-button { margin-top: .7rem; }
</style>
