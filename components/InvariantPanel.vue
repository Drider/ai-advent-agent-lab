<script setup lang="ts">
import type { Invariant, InvariantChange } from '~/shared/invariant'

const props = defineProps<{
  invariants: Invariant[]
  changes: InvariantChange[]
  loading?: boolean
  error?: string | null
}>()

function describeChange(change: InvariantChange): string {
  const before = change.before?.rule ?? 'нет правила'
  const after = change.after?.rule ?? 'удалено'
  return `${change.invariantId}: «${before}» → «${after}»`
}
</script>

<template>
  <details class="invariant-panel">
    <summary>
      <span>Инварианты</span>
      <UBadge color="neutral" variant="subtle">{{ props.invariants.length }}</UBadge>
    </summary>
    <div class="invariant-panel__body">
      <p v-if="props.loading" class="invariant-panel__muted">Загружаем правила…</p>
      <p v-else-if="props.error" class="invariant-panel__error">{{ props.error }}</p>
      <ul v-else class="invariant-panel__list">
        <li v-for="invariant in props.invariants" :key="invariant.id">
          <strong>{{ invariant.id }}</strong>
          <span class="invariant-panel__category">{{ invariant.category }}</span>
          <p>{{ invariant.rule }}</p>
        </li>
      </ul>
      <details v-if="props.changes.length > 0" class="invariant-panel__changes">
        <summary>Последние изменения</summary>
        <ul>
          <li v-for="change in props.changes.slice(0, 10)" :key="change.id">{{ describeChange(change) }}</li>
        </ul>
      </details>
      <p class="invariant-panel__hint">Изменение: <code>/invariant set &lt;id&gt; &lt;категория&gt; &lt;правило&gt;</code></p>
    </div>
  </details>
</template>

<style scoped>
.invariant-panel {
  margin: 0 1.25rem .75rem;
  border: 1px solid #dbe4ef;
  border-radius: .65rem;
  padding: .6rem .75rem;
  color: #475569;
  background: #f8fafc;
  font-size: .78rem;
}

.invariant-panel > summary,
.invariant-panel__changes > summary { cursor: pointer; font-weight: 600; }
.invariant-panel > summary { display: flex; align-items: center; gap: .45rem; }
.invariant-panel__body { margin-top: .6rem; }
.invariant-panel__list,
.invariant-panel__changes ul { display: grid; gap: .45rem; margin: 0; padding-left: 1.1rem; }
.invariant-panel__list p { margin: .15rem 0 0; color: #334155; }
.invariant-panel__category { margin-left: .4rem; color: #64748b; }
.invariant-panel__changes { margin-top: .65rem; }
.invariant-panel__hint,
.invariant-panel__muted,
.invariant-panel__error { margin: .65rem 0 0; }
.invariant-panel__error { color: #b91c1c; }
</style>
