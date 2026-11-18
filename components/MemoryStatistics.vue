<script setup lang="ts">
import type { MemoryExclusionReason, MemoryPreview, MemoryStatistics as MemoryStatisticsData } from '~/shared/memory'

const props = defineProps<{ statistics: MemoryStatisticsData; preview?: MemoryPreview }>()

function percent(value: number, budget?: number): string {
  return budget === undefined || budget === 0 ? '—' : `${(value / budget * 100).toFixed(1)}%`
}

const exclusionLabels: Record<MemoryExclusionReason, string> = {
  disabled: 'запись отключена',
  not_relevant: 'нет совпадений с запросом',
  budget_exceeded: 'не помещается в бюджет',
}
</script>

<template>
  <section class="memory-card" aria-labelledby="memory-statistics-title">
    <div class="memory-card__heading"><div><p class="memory-eyebrow">Наблюдаемость</p><h2 id="memory-statistics-title">Статистика</h2></div><span class="memory-muted">Подготовлено ходов: {{ props.statistics.preparedTurns }}</span></div>
    <div class="memory-statistics-grid">
      <div><span>Хранится · краткосрочная</span><strong>{{ props.statistics.stored.shortTerm.count }} сообщений</strong><small>{{ props.statistics.stored.shortTerm.bytes }} байт</small></div>
      <div><span>Хранится · рабочая</span><strong>{{ props.statistics.stored.working.count }} записей</strong><small>{{ props.statistics.stored.working.bytes }} байт</small></div>
      <div><span>Хранится · долговременная</span><strong>{{ props.statistics.stored.longTerm.count }} фактов</strong><small>{{ props.statistics.stored.longTerm.bytes }} байт</small></div>
      <div><span>Производные представления</span><strong>{{ props.statistics.stored.summaries }} сводок · {{ props.statistics.stored.stickyFacts }} Sticky Facts</strong><small>не являются подтверждёнными фактами</small></div>
    </div>
    <div v-if="props.preview" class="memory-statistics__prepared">
      <p>Оценка обязательной памяти</p>
      <span>Рабочая: {{ props.preview.working.estimatedTokens }} токенов ({{ percent(props.preview.working.estimatedTokens, props.preview.working.budgetTokens) }})</span>
      <span>Долговременная: {{ props.preview.longTerm.estimatedTokens }} токенов ({{ percent(props.preview.longTerm.estimatedTokens, props.preview.longTerm.budgetTokens) }})</span>
    </div>
    <div class="memory-statistics__last">
      <p>Последняя подготовка</p>
      <template v-if="props.statistics.lastPrepared && !props.statistics.lastPrepared.contextCleared">
        <span>{{ new Date(props.statistics.lastPrepared.preparedAt).toLocaleString('ru-RU') }}</span>
        <span>{{ props.statistics.lastPrepared.working.count }} рабочих записей · {{ props.statistics.lastPrepared.longTerm.count }} долговременных фактов</span>
        <details v-if="props.statistics.lastPrepared.exclusions.length">
          <summary>Причины исключения · {{ props.statistics.lastPrepared.exclusions.length }}</summary>
          <p v-for="record in props.statistics.lastPrepared.exclusions" :key="`${record.layer}:${record.id}`">{{ record.layer === 'working' ? 'Рабочая' : 'Долговременная' }} · {{ record.id }} · {{ exclusionLabels[record.reason] }}</p>
        </details>
      </template>
      <span v-else-if="props.statistics.lastPrepared">Состав скрыт: история этого диалога очищена.</span>
      <span v-else>Нет событий подготовки памяти.</span>
    </div>
    <details v-if="props.statistics.recordUsage.length" class="memory-statistics__records">
      <summary>Частота включения записей</summary>
      <div v-for="record in props.statistics.recordUsage" :key="record.layer + record.id"><span>{{ record.layer === 'working' ? 'Рабочая' : 'Долговременная' }} · {{ record.id.slice(0, 8) }}</span><strong>{{ record.preparedTurns }} ходов</strong><em v-if="record.revisionMismatch">Ревизия изменена</em></div>
    </details>
  </section>
</template>

<style scoped>
.memory-statistics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; }
.memory-statistics-grid > div { display: grid; gap: .2rem; border: 1px solid #e2e8f0; border-radius: .55rem; padding: .7rem; background: #f8fafc; }
.memory-statistics-grid span, .memory-statistics__last p, .memory-statistics__prepared p { color: #64748b; font-size: .72rem; }
.memory-statistics-grid strong { color: #1e293b; font-size: .82rem; }
.memory-statistics-grid small { color: #94a3b8; font-size: .7rem; }
.memory-statistics__prepared, .memory-statistics__last { display: grid; gap: .25rem; margin-top: .9rem; color: #475569; font-size: .75rem; }
.memory-statistics__prepared p, .memory-statistics__last p { margin: 0; font-weight: 700; }
.memory-statistics__records { margin-top: .9rem; color: #475569; font-size: .74rem; }
.memory-statistics__records summary { cursor: pointer; font-weight: 700; }
.memory-statistics__records > div { display: flex; justify-content: space-between; gap: .5rem; padding: .4rem 0; border-bottom: 1px solid #f1f5f9; }
.memory-statistics__records em { color: #b45309; font-style: normal; }
@media (max-width: 600px) { .memory-statistics-grid { grid-template-columns: 1fr; } }
</style>
