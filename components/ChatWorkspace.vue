<script setup lang="ts">
import { DefaultChatTransport, isTextUIPart, isToolUIPart } from 'ai'
import math, { Math as MathRenderer } from '@comark/nuxt/plugins/math'
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useChat } from '@ai-sdk/vue'
import type { ChatRequestBody, ChatSessionStatus, ChatUIMessage, SessionDetail } from '~/shared/chat'

const props = defineProps<{
  session: SessionDetail
  modelId: string
}>()

const emit = defineEmits<{
  newSession: []
  updated: []
  busyChange: [busy: boolean]
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
      activeRequestId.value = body.requestId
      lastKnownTurnId.value = body.requestId
      return { body }
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
    lastTurnStatus.value = isAbort
      ? lastTurnStatus.value === 'stopped' ? 'stopped' : 'interrupted'
      : isError ? 'failed' : 'completed'
    activeRequestId.value = null
    emit('updated')
  },
})

const isBusy = computed(() => status.value === 'submitted' || status.value === 'streaming')
const canContinue = computed(() => !isBusy.value && ['interrupted', 'stopped', 'failed'].includes(lastTurnStatus.value))
const needsReview = computed(() => lastTurnStatus.value === 'needs_review' || props.session.status === 'needs_review')
const statusLabel = computed(() => {
  switch (true) {
    case status.value === 'submitted':
      return 'Подключение'
    case status.value === 'streaming':
      return 'Генерация'
    case needsReview.value:
      return 'Нужна проверка'
    case canContinue.value && lastTurnStatus.value === 'stopped':
      return 'Остановлен'
    case canContinue.value:
      return 'Прерван'
    case status.value === 'error':
      return 'Ошибка'
    default:
      return 'Готово'
  }
})

watch(isBusy, busy => emit('busyChange', busy), { immediate: true })

async function handleSubmit(event?: Event): Promise<void> {
  event?.preventDefault()
  const text = draft.value.trim()
  if (!text || isBusy.value) return
  clearError()
  continuationError.value = null
  draft.value = ''
  await sendMessage({ text })
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
    await sendMessage(undefined, {
      body: {
        kind: 'continue',
        sessionId: props.session.id,
        requestId,
        sourceTurnId,
        model: props.modelId,
      } satisfies ChatRequestBody,
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
  await stop()
}

onMounted(() => {
  void $fetch(`/api/sessions/${props.session.id}/activate`, { method: 'POST' }).catch(() => undefined)
})
</script>

<template>
  <main class="chat-workspace">
    <header class="chat-header">
      <div class="chat-header__copy">
        <p class="chat-eyebrow" :title="props.modelId">AI SDK · {{ props.modelId }}</p>
        <h1>{{ session.title }}</h1>
      </div>
      <div class="chat-header__actions">
        <UBadge class="chat-status-badge" color="neutral" variant="subtle" role="status" aria-live="polite">{{ statusLabel }}</UBadge>
        <UButton class="chat-new-session" color="neutral" variant="soft" icon="i-lucide-square-pen" aria-label="Новая сессия" :disabled="isBusy" @click="emit('newSession')">
          <span class="chat-new-session__label">Новая сессия</span>
        </UButton>
      </div>
    </header>

    <div v-if="canContinue || needsReview" class="chat-interruption" :class="{ 'chat-interruption--warning': needsReview }" role="status">
      <div>
        <strong>{{ needsReview ? 'Нужна проверка перед продолжением' : 'Ответ был прерван' }}</strong>
        <p>{{ needsReview ? 'Результат побочного действия нельзя подтвердить автоматически. Отправьте новый запрос, если нужно продолжить диалог.' : 'Сохранённая история не запускает инструменты повторно.' }}</p>
      </div>
      <UButton v-if="canContinue && !needsReview" size="sm" color="neutral" variant="soft" @click="handleContinue">Продолжить</UButton>
    </div>

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
          <ChatRequestMetrics v-if="message.role === 'assistant' && message.metadata" :metadata="message.metadata" />
        </div>
      </template>
    </UChatMessages>

    <div v-if="error || continuationError" class="chat-error" role="alert">
      <div class="chat-error__copy"><UIcon name="i-lucide-circle-alert" /><span>{{ continuationError || error?.message || 'Не удалось получить ответ модели.' }}</span></div>
      <UButton size="sm" color="neutral" variant="ghost" @click="continuationError = null; clearError()">Закрыть</UButton>
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
