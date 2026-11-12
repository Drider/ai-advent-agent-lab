<script setup lang="ts">
import type { ChatMessageMetadata } from '~/shared/chat'

const props = defineProps<{
  metadata: ChatMessageMetadata
  showCost: boolean
  dialogueCostRub?: number
}>()

const tokenFormatter = new Intl.NumberFormat('ru-RU')
const durationFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 2,
})

function formatTokens(count: number | undefined): string {
  return count === undefined ? '—' : tokenFormatter.format(count)
}

const costFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function formatCost(amount: number): string {
  return `${costFormatter.format(amount)} ₽`
}
</script>

<template>
  <div class="message-metrics">
    <p class="message-metrics__row" aria-label="Статистика запроса">
      <span>Токены: {{ formatTokens(props.metadata.usage.totalTokens) }}</span>
      <span>Вход: {{ formatTokens(props.metadata.usage.inputTokens) }}</span>
      <span>Выход: {{ formatTokens(props.metadata.usage.outputTokens) }}</span>
      <span>Время: {{ durationFormatter.format(props.metadata.durationMs / 1_000) }} с</span>
    </p>
    <p v-if="props.showCost && props.metadata.costRub && props.dialogueCostRub !== undefined" class="message-metrics__row message-metrics__cost" aria-label="Стоимость использования">
      <span>Запрос: {{ formatCost(props.metadata.costRub.input) }}</span>
      <span>Ответ: {{ formatCost(props.metadata.costRub.output) }}</span>
      <strong>Диалог: {{ formatCost(props.dialogueCostRub) }}</strong>
    </p>
  </div>
</template>

<style scoped>
.message-metrics {
  display: grid;
  gap: 0.2rem;
}

.message-metrics__row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.9rem;
  margin: 0;
  color: #64748b;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
}

.message-metrics__row > span,
.message-metrics__row > strong {
  white-space: nowrap;
}

.message-metrics__cost {
  color: #475569;
}
</style>
