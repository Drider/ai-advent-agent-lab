<script setup lang="ts">
import { DefaultChatTransport, isTextUIPart, isToolUIPart } from 'ai'
import math, { Math as MathRenderer } from '@comark/nuxt/plugins/math'
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useChat } from '@ai-sdk/vue'
import { dialogueCostTotals, latestContextUsage, parseContextLimit, type ChatPricing, type ChatRequestBody, type ChatSessionStatus, type ChatUIMessage, type SessionDetail } from '~/shared/chat'

const props = defineProps<{
  session: SessionDetail
  modelId: string
  contextLimit: string
  pricing?: ChatPricing
  showCost: boolean
  showDetailedStatistics?: boolean
  operationError?: string | null
}>()

const emit = defineEmits<{
  newSession: []
  updated: []
  busyChange: [busy: boolean]
  dismissOperationError: []
}>()

const draft = shallowRef('')
const activeRequestId = shallowRef<string | null>(null)
const lastKnownTurnId = shallowRef(props.session.lastTurn?.id ?? null)
const lastTurnStatus = shallowRef<ChatSessionStatus>(props.session.lastTurn?.status ?? props.session.status)
const continuationError = shallowRef<string | null>(null)

const markdownComponents = { math: MathRenderer }
const markdownPlugins = [math()]

const transport = new DefaultChatTransport<ChatUIMessage>({
  api: '/api/chat',
  prepareSendMessagesRequest: ({ messages, body }) => {
    if (body && body.kind === 'continue') {
      const message = messages.at(-1)
      if (!message || message.role !== 'user') throw new Error('Cannot continue without a user message')
      activeRequestId.value = body.requestId
      lastKnownTurnId.value = body.requestId
      return { body: { ...body, message } }
    }

    const message = messages.at(-1)
    if (!message) {
      throw new Error('Cannot send an empty chat')
    }
    const requestId = crypto.randomUUID()
    activeRequestId.value = requestId
    lastKnownTurnId.value = requestId
    return {
      body: {
        kind: 'message',
        sessionId: props.session.id,
        requestId,
        message,
        model: props.modelId,
        ...(props.pricing === undefined ? {} : { pricing: props.pricing }),
      } satisfies ChatRequestBody,
    }
  },
})

const {
  messages,
  status,
  error,
  sendMessage,
  stop,
  clearError,
} = useChat<ChatUIMessage>({
  id: props.session.id,
  messages: props.session.messages,
  transport,
  onFinish: ({ isAbort, isError }) => {
    const reachedStepLimit = messages.value.at(-1)?.metadata?.stopReason === 'step_limit'
    lastTurnStatus.value = isAbort
      ? lastTurnStatus.value === 'stopped' ? 'stopped' : 'interrupted'
      : isError ? 'failed' : reachedStepLimit ? 'interrupted' : 'completed'
    activeRequestId.value = null
    emit('updated')
  },
})

const isBusy = computed(() => status.value === 'submitted' || status.value === 'streaming')
const dialogueTotals = computed(() => dialogueCostTotals(messages.value))
const totalDialogueCost = computed(() => [...dialogueTotals.value.values()].at(-1))
const tokenFormatter = new Intl.NumberFormat('ru-RU')
const costFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const formatCost = (amount: number) => `${costFormatter.format(amount)} ₽`
const contextModelMatches = computed(() => props.session.lastTurn?.modelId === props.modelId)
const contextUsage = computed(() => latestContextUsage(
  messages.value,
  contextModelMatches.value ? parseContextLimit(props.contextLimit) : undefined,
))
const currentTurn = computed(() => props.session.lastTurn?.id === lastKnownTurnId.value ? props.session.lastTurn : null)
const isStopped = computed(() => !isBusy.value && ['interrupted', 'stopped', 'failed'].includes(lastTurnStatus.value))
const canContinue = computed(() => isStopped.value && currentTurn.value?.continuation === 'safe')
const needsReview = computed(() => lastTurnStatus.value === 'needs_review' || currentTurn.value?.continuation === 'needs_review')
const stopReason = computed(() => currentTurn.value?.stopReason
  ?? (lastTurnStatus.value === 'interrupted' ? messages.value.at(-1)?.metadata?.stopReason : undefined))
const visibleErrors = computed(() => [
  continuationError.value,
  error.value?.message || (error.value ? 'Не удалось получить ответ модели.' : null),
  props.operationError,
].filter((message): message is string => Boolean(message)))
const statusLabel = computed(() => {
  switch (true) {
    case status.value === 'submitted':
      return 'Подключение'
    case status.value === 'streaming':
      return 'Генерация'
    case needsReview.value:
      return 'Нужна проверка'
    case stopReason.value === 'step_limit' && lastTurnStatus.value === 'interrupted':
      return 'Не завершено'
    case lastTurnStatus.value === 'stopped':
      return 'Остановлен'
    case lastTurnStatus.value === 'failed':
      return 'Ошибка'
    case lastTurnStatus.value === 'interrupted':
      return 'Прерван'
    case status.value === 'error':
      return 'Ошибка'
    default:
      return 'Готово'
  }
})

watch(isBusy, busy => emit('busyChange', busy), { immediate: true })
watch(() => props.session.lastTurn, turn => {
  if (turn?.id === lastKnownTurnId.value) lastTurnStatus.value = turn.status
})

async function handleSubmit(event?: Event): Promise<void> {
  event?.preventDefault()
  const text = draft.value.trim()
  if (!text || isBusy.value) return
  clearError()
  continuationError.value = null
  draft.value = ''
  try {
    await sendMessage({ text })
  } catch (caughtError) {
    continuationError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось отправить сообщение'
    draft.value = text
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void handleSubmit()
  }
}

function handleComposerClick(event: MouseEvent): void {
  const target = event.target as HTMLElement
  if (target.closest('button, a, input, select, textarea')) return
  const textarea = (event.currentTarget as HTMLElement).querySelector('textarea')
  textarea?.focus()
}

async function handleContinue(): Promise<void> {
  const sourceTurnId = lastKnownTurnId.value ?? props.session.lastTurn?.id
  if (!sourceTurnId || isBusy.value || needsReview.value) return
  clearError()
  continuationError.value = null
  lastTurnStatus.value = 'running'
  const requestId = crypto.randomUUID()
  activeRequestId.value = requestId
  try {
    await sendMessage({ text: 'Продолжи выполнение предыдущего запроса.' }, {
      body: {
        kind: 'continue',
        sessionId: props.session.id,
        requestId,
        sourceTurnId,
        model: props.modelId,
        ...(props.pricing === undefined ? {} : { pricing: props.pricing }),
      } satisfies Omit<Extract<ChatRequestBody, { kind: 'continue' }>, 'message'>,
    })
  } catch (caughtError) {
    continuationError.value = caughtError instanceof Error ? caughtError.message : 'Продолжение недоступно'
    lastTurnStatus.value = 'failed'
  }
}

async function handleStop(): Promise<void> {
  const requestId = activeRequestId.value
  if (requestId) {
    try {
      await $fetch(`/api/sessions/${props.session.id}/turns/${requestId}/stop`, { method: 'POST' })
      lastTurnStatus.value = 'stopped'
    } catch (caughtError) {
      continuationError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось остановить ход'
    }
  }
  try {
    await stop()
  } catch (caughtError) {
    continuationError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось остановить генерацию'
  }
}

onMounted(() => {
  void $fetch(`/api/sessions/${props.session.id}/activate`, { method: 'POST' }).catch(() => {
    continuationError.value = 'Не удалось активировать диалог.'
  })
})

function dismissError(): void {
  continuationError.value = null
  clearError()
  emit('dismissOperationError')
}
</script>

<template>
  <main class="chat-workspace">
    <header class="chat-header">
      <div class="chat-header__copy">
        <p class="chat-eyebrow" :title="props.modelId">AI SDK · {{ props.modelId }}</p>
        <h1>{{ session.title }}</h1>
        <div class="chat-context-usage" aria-label="Использование контекстного окна">
          <p v-if="contextUsage?.kind === 'limited'">
            Последнее обращение: {{ tokenFormatter.format(contextUsage.occupiedTokens) }} / {{ tokenFormatter.format(contextUsage.limit) }} токенов ({{ contextUsage.percent }} %)
            · вход {{ tokenFormatter.format(contextUsage.inputTokens) }} + выход {{ tokenFormatter.format(contextUsage.outputTokens) }}
            · до лимита: {{ tokenFormatter.format(contextUsage.remaining) }}
            <span v-if="props.showCost && totalDialogueCost !== undefined"> · Общая стоимость диалога: {{ formatCost(totalDialogueCost) }}</span>
          </p>
          <p v-else-if="contextUsage?.kind === 'measured'">Последнее обращение: {{ tokenFormatter.format(contextUsage.occupiedTokens) }} токенов (вход {{ tokenFormatter.format(contextUsage.inputTokens) }} + выход {{ tokenFormatter.format(contextUsage.outputTokens) }}) · {{ contextModelMatches ? 'задайте лимит модели для расчёта доли' : 'модель изменена, лимит прошлого обращения неизвестен' }}</p>
          <p v-else-if="contextUsage">Вход последнего обращения: {{ tokenFormatter.format(contextUsage.inputTokens) }} токенов · выход неизвестен, долю окна рассчитать нельзя</p>
          <p v-else>Последнее обращение: нет данных о токенах</p>
          <progress v-if="contextUsage?.kind === 'limited'" :value="Math.min(contextUsage.occupiedTokens, contextUsage.limit)" :max="contextUsage.limit" aria-label="Доля контекстного окна, занятая последним обращением" />
          <p class="chat-context-usage__hint">Лимит действует на одно обращение к модели. Вход уже включает историю и токены из кэша; выход включает размышления.</p>
        </div>
      </div>
      <div class="chat-header__actions">
        <UBadge class="chat-status-badge" color="neutral" variant="subtle" role="status" aria-live="polite">{{ statusLabel }}</UBadge>
        <UButton class="chat-new-session" color="neutral" variant="soft" icon="i-lucide-square-pen" aria-label="Новая сессия" :disabled="isBusy" @click="emit('newSession')">
          <span class="chat-new-session__label">Новая сессия</span>
        </UButton>
      </div>
    </header>

    <ChatInterruptionNotice
      v-if="isStopped || needsReview"
      :status="lastTurnStatus"
      :stop-reason="stopReason"
      :can-continue="canContinue"
      :needs-review="needsReview"
      @continue="handleContinue"
    />

    <div v-if="messages.length === 0" class="chat-empty-state">
      <div class="chat-empty-state__mark"><UIcon name="i-lucide-sparkles" /></div>
      <h2>Чем могу помочь?</h2>
      <p>Задайте вопрос или попросите бросить кубик — агент сам вызовет инструмент.</p>
    </div>

    <UChatMessages v-else :messages="messages" :status="status" :should-auto-scroll="true" :should-scroll-to-bottom="true" class="chat-messages" :assistant="{ variant: 'naked' }" :user="{ variant: 'soft' }">
      <template #content="{ message }">
        <div class="message-content">
          <template v-for="(part, index) in message.parts" :key="message.id + '-' + index">
            <Markdown v-if="isTextUIPart(part) && message.role === 'assistant'" :value="part.text" :components="markdownComponents" :plugins="markdownPlugins" />
            <p v-else-if="isTextUIPart(part)" class="user-message-text">{{ part.text }}</p>
            <ChatToolCall v-else-if="message.role === 'assistant' && isToolUIPart(part)" :part="part" :is-active="isBusy && message.id === messages.at(-1)?.id" />
          </template>
          <ChatRequestMetrics
            v-if="message.role === 'assistant' && message.metadata"
            :metadata="message.metadata"
            :show-cost="props.showCost"
            :show-detailed="props.showDetailedStatistics"
            :dialogue-cost-rub="dialogueTotals.get(message.id)"
          />
        </div>
      </template>
    </UChatMessages>

    <div v-if="visibleErrors.length" class="chat-error" role="alert">
      <div class="chat-error__copy"><UIcon name="i-lucide-circle-alert" /><span><span v-for="(message, index) in visibleErrors" :key="index" class="chat-error__message">{{ message }}</span></span></div>
      <UButton size="sm" color="neutral" variant="ghost" @click="dismissError">Закрыть</UButton>
    </div>

    <form class="chat-composer" @click="handleComposerClick" @submit="handleSubmit">
      <UTextarea v-model="draft" :disabled="isBusy" :rows="3" autoresize size="xl" variant="none" placeholder="Напишите сообщение…" aria-label="Сообщение" @keydown="handleKeydown" />
      <div class="chat-composer__footer">
        <span class="chat-composer__hint">Enter — отправить · Shift+Enter — новая строка</span>
        <UButton v-if="isBusy" type="button" color="neutral" icon="i-lucide-square" aria-label="Остановить генерацию" @click="handleStop" />
        <UButton v-else type="submit" class="chat-composer__submit" color="neutral" variant="solid" aria-label="Отправить сообщение" :disabled="!draft.trim()"><UIcon name="i-lucide-arrow-up" class="chat-composer__submit-icon" aria-hidden="true" /></UButton>
      </div>
    </form>
  </main>
</template>
