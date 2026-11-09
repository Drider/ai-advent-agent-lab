<script setup lang="ts">
import type { ChatMessageMetadata } from '~/shared/chat'

defineProps<{
  metadata: ChatMessageMetadata
}>()

const tokenFormatter = new Intl.NumberFormat('ru-RU')
const durationFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 2,
})

function formatTokens(count: number | undefined): string {
  return count === undefined ? '—' : tokenFormatter.format(count)
}
</script>

<template>
  <p class="message-metrics" aria-label="Статистика запроса">
    <span>Токены: {{ formatTokens(metadata.usage.totalTokens) }}</span>
    <span>Вход: {{ formatTokens(metadata.usage.inputTokens) }}</span>
    <span>Выход: {{ formatTokens(metadata.usage.outputTokens) }}</span>
    <span>Время: {{ durationFormatter.format(metadata.durationMs / 1_000) }} с</span>
  </p>
</template>

<style scoped>
.message-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.9rem;
  margin: 0;
  color: #64748b;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
}

.message-metrics > span {
  white-space: nowrap;
}
</style>
