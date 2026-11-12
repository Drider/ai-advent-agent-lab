<script setup lang="ts">
import type { ChatMessageMetadata, ChatTokenUsage } from '~/shared/chat'

const props = defineProps<{
  metadata: ChatMessageMetadata
  showCost: boolean
  showDetailed?: boolean
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

function tokenDetails(usage: ChatTokenUsage) {
  return [
    { label: 'Вход без кэша', value: usage.inputTokenDetails?.noCacheTokens },
    { label: 'Чтение из кэша', value: usage.inputTokenDetails?.cacheReadTokens },
    { label: 'Запись в кэш', value: usage.inputTokenDetails?.cacheWriteTokens },
    { label: 'Текст ответа', value: usage.outputTokenDetails?.textTokens },
    { label: 'Размышления', value: usage.outputTokenDetails?.reasoningTokens },
  ]
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
    <p class="message-metrics__row" aria-label="Расход токенов за ход">
      <span>Токены за ход: {{ formatTokens(props.metadata.usage.totalTokens) }}</span>
      <span>Вход за ход: {{ formatTokens(props.metadata.usage.inputTokens) }}</span>
      <span>Выход за ход: {{ formatTokens(props.metadata.usage.outputTokens) }}</span>
      <span>Время: {{ durationFormatter.format(props.metadata.durationMs / 1_000) }} с</span>
    </p>
    <section v-if="props.showDetailed" class="message-metrics__details" aria-label="Подробная статистика токенов">
      <p class="message-metrics__row">
        <span v-for="detail in tokenDetails(props.metadata.usage)" :key="detail.label">{{ detail.label }}: {{ formatTokens(detail.value) }}</span>
      </p>
      <p v-if="props.metadata.steps" class="message-metrics__row">
        <span>Обращений к модели: {{ props.metadata.steps.length }}</span>
      </p>
      <ol v-if="props.metadata.steps && props.metadata.steps.length > 1" class="message-metrics__steps">
        <li v-for="(step, index) in props.metadata.steps" :key="index">
          <strong>Обращение {{ index + 1 }}</strong>
          <p class="message-metrics__row">
            <span>Вход: {{ formatTokens(step.usage.inputTokens) }}</span>
            <span>Выход: {{ formatTokens(step.usage.outputTokens) }}</span>
            <span>Всего: {{ formatTokens(step.usage.totalTokens) }}</span>
          </p>
          <p class="message-metrics__row">
            <span v-for="detail in tokenDetails(step.usage)" :key="detail.label">{{ detail.label }}: {{ formatTokens(detail.value) }}</span>
          </p>
        </li>
      </ol>
      <p class="message-metrics__hint">
        Кэш уже учтён во входных токенах, размышления — в выходных. Общие числа суммируют все обращения, включая повторную передачу истории. «—» означает, что данные недоступны.
      </p>
    </section>
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

.message-metrics__details {
  display: grid;
  gap: 0.4rem;
  border-left: 2px solid #cbd5e1;
  margin: 0.25rem 0;
  padding: 0.2rem 0 0.2rem 0.65rem;
}

.message-metrics__steps {
  display: grid;
  gap: 0.55rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.message-metrics__steps > li > strong {
  color: #475569;
  font-size: 0.75rem;
}

.message-metrics__hint {
  max-width: 44rem;
  margin: 0;
  color: #64748b;
  font-size: 0.7rem;
  line-height: 1.5;
}
</style>
