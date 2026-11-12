<script setup lang="ts">
import { computed } from 'vue'
import { stopReasonMessage, type ChatSessionStatus, type ChatStopReason } from '~/shared/chat'

const props = defineProps<{
  status: ChatSessionStatus
  stopReason?: ChatStopReason
  canContinue: boolean
  needsReview: boolean
}>()

const emit = defineEmits<{ continue: [] }>()

const title = computed(() => {
  if (props.needsReview) return 'Нужна проверка перед продолжением'
  if (props.stopReason === 'step_limit') return 'Операция завершена не полностью'
  if (props.stopReason === 'timeout') return 'Время запроса истекло'
  if (props.stopReason === 'provider_spending_limit') return 'Достигнут лимит расходов polza.ai'
  if (props.status === 'stopped') return 'Генерация остановлена'
  if (props.status === 'failed') return 'Агент завершился с ошибкой'
  return 'Ответ был прерван'
})

const description = computed(() => props.needsReview
  ? 'Результат побочного действия нельзя подтвердить автоматически. Отправьте новый запрос, если нужно продолжить диалог.'
  : stopReasonMessage(props.stopReason))
</script>

<template>
  <div class="chat-interruption" :class="{ 'chat-interruption--warning': needsReview || stopReason === 'step_limit' }" :role="status === 'failed' || stopReason === 'step_limit' ? 'alert' : 'status'">
    <div>
      <strong>{{ title }}</strong>
      <p>{{ description }}</p>
    </div>
    <UButton v-if="canContinue && !needsReview" size="sm" color="neutral" variant="soft" @click="emit('continue')">Продолжить</UButton>
  </div>
</template>
