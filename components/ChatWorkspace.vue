<script setup lang="ts">
import { DefaultChatTransport, isTextUIPart, isToolUIPart } from 'ai'
import math, { Math as MathRenderer } from '@comark/nuxt/plugins/math'
import { computed, onMounted, shallowRef, watch } from 'vue'
import { useChat } from '@ai-sdk/vue'
import { buildChatCompactionSettings, dialogueCostTotals, latestContextUsage, parseContextLimit, type ChatCompactionSettings, type ChatContextStrategySettings, type ChatPricing, type ChatRequestBody, type ChatSessionStatus, type ChatUIMessage, type SessionDetail } from '~/shared/chat'
import type { UserProfileSummary } from '~/shared/user-profile'

const props = defineProps<{
  session: SessionDetail
  projectName?: string
  modelId: string
  contextLimit: string
  compactionEnabled: boolean
  compactionThreshold: string
  contextStrategy: ChatContextStrategySettings
  pricing?: ChatPricing
  showCost: boolean
  showDetailedStatistics?: boolean
  operationError?: string | null
  historyClearPending?: boolean
  userProfiles: UserProfileSummary[]
  userProfilesLoading?: boolean
  profileSelectionError?: string | null
}>()

const emit = defineEmits<{
  newSession: []
  updated: []
  busyChange: [busy: boolean]
  dismissOperationError: []
  createBranch: [messageId: string]
  saveMemory: [payload: { text: string; source: { sourceSessionId: string; sourceMessageId: string } }]
  selectProfile: [profileId: string]
}>()

const draft = shallowRef('')
const activeRequestId = shallowRef<string | null>(null)
const lastKnownTurnId = shallowRef(props.session.lastTurn?.id ?? null)
const lastTurnStatus = shallowRef<ChatSessionStatus>(props.session.lastTurn?.status ?? props.session.status)
const continuationError = shallowRef<string | null>(null)
let pendingSend: { text: string; baselineIds: Set<string> } | null = null
let chatMessages: { value: ChatUIMessage[] } | undefined

const markdownComponents = { math: MathRenderer }
const markdownPlugins = [math()]

function getMessageText(message: ChatUIMessage): string {
  return message.parts
    .filter((part): part is Extract<ChatUIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('')
}

function getCompactionSettings(): ChatCompactionSettings {
  return buildChatCompactionSettings({
    enabled: props.contextStrategy.strategy === 'summary' && props.compactionEnabled,
    messageThreshold: props.contextStrategy.messageThreshold,
    contextWindowTokens: props.contextLimit,
  })
}

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
        compaction: getCompactionSettings(),
        contextStrategy: props.contextStrategy,
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
  onError: chatError => {
    const failed = pendingSend
    pendingSend = null
    const message = chatError.message
    continuationError.value = message
    if (!failed || !chatMessages || !/memory.{0,80}budget|working memory|long[- ]term memory/iu.test(message)) return
    const optimistic = [...chatMessages.value].reverse().find(item => item.role === 'user' && !failed.baselineIds.has(item.id) && getMessageText(item) === failed.text)
    if (!optimistic) return
    chatMessages.value = chatMessages.value.filter(item => item.id !== optimistic.id)
    draft.value = failed.text
  },
  onFinish: ({ isAbort, isError }) => {
    const reachedStepLimit = messages.value.at(-1)?.metadata?.stopReason === 'step_limit'
    lastTurnStatus.value = isAbort
      ? lastTurnStatus.value === 'stopped' ? 'stopped' : 'interrupted'
      : isError ? 'failed' : reachedStepLimit ? 'interrupted' : 'completed'
    activeRequestId.value = null
    pendingSend = null
    emit('updated')
  },
})
chatMessages = messages

const isBusy = computed(() => status.value === 'submitted' || status.value === 'streaming')
const dialogueTotals = computed(() => dialogueCostTotals(messages.value, props.session.compactionAttempts))
const stickyFactsMaintenanceTokens = computed(() => props.session.factsUpdates.reduce((total, update) => total + (update.usage?.totalTokens ?? 0), 0))
const compactionAttemptsByUserMessage = computed(() => {
  const grouped = new Map<string, SessionDetail['compactionAttempts']>()
  for (const attempt of props.session.compactionAttempts) {
    if (!attempt.userMessageId) continue
    grouped.set(attempt.userMessageId, [...(grouped.get(attempt.userMessageId) ?? []), attempt])
  }
  return grouped
})
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
  if (!text || isBusy.value || props.historyClearPending) return
  clearError()
  continuationError.value = null
  pendingSend = { text, baselineIds: new Set(messages.value.map(message => message.id)) }
  draft.value = ''
  try {
    await sendMessage({ text })
  } catch (caughtError) {
    pendingSend = null
    continuationError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось отправить сообщение'
    draft.value = text
    emit('updated')
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
  if (!sourceTurnId || isBusy.value || needsReview.value || props.historyClearPending) return
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
        compaction: getCompactionSettings(),
        contextStrategy: props.contextStrategy,
      } satisfies Omit<Extract<ChatRequestBody, { kind: 'continue' }>, 'message'>,
    })
  } catch (caughtError) {
    continuationError.value = caughtError instanceof Error ? caughtError.message : 'Продолжение недоступно'
    lastTurnStatus.value = 'failed'
    emit('updated')
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
        <p class="chat-project" aria-live="polite">
          <UIcon name="i-lucide-folder" aria-hidden="true" />
          <span v-if="props.session.projectId">Проект: {{ props.projectName ?? props.session.projectId }}</span>
          <span v-else>Без проекта</span>
        </p>
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
        <UserProfileSelector
          :items="props.userProfiles"
          :model-value="props.session.userProfileId"
          :disabled="isBusy"
          :loading="props.userProfilesLoading"
          :error="props.profileSelectionError"
          @select="emit('selectProfile', $event)"
        />
        <UButton color="neutral" variant="soft" icon="i-lucide-user-round-cog" :to="{ path: '/profiles', query: { sessionId: props.session.id, profileId: props.session.userProfileId } }">Профили</UButton>
        <UButton color="neutral" variant="soft" icon="i-lucide-brain" :to="{ path: '/memory', query: { sessionId: props.session.id, ...(props.session.projectId ? { projectId: props.session.projectId } : {}) } }">Память</UButton>
        <UBadge class="chat-status-badge" color="neutral" variant="subtle" role="status" aria-live="polite">{{ statusLabel }}</UBadge>
        <UButton class="chat-new-session" color="neutral" variant="soft" icon="i-lucide-square-pen" aria-label="Новая сессия" :disabled="isBusy" @click="emit('newSession')">
          <span class="chat-new-session__label">Новая сессия</span>
        </UButton>
      </div>
    </header>

    <details v-if="props.contextStrategy.strategy === 'sticky_facts' && Object.keys(props.session.stickyFacts).length > 0" class="sticky-facts-panel">
      <summary>Sticky Facts · {{ Object.keys(props.session.stickyFacts).length }} фактов</summary>
      <p class="sticky-facts-panel__meta">Обновлений: {{ props.session.factsUpdates.length }} · maintenance-токены: {{ tokenFormatter.format(stickyFactsMaintenanceTokens) }}</p>
      <dl>
        <template v-for="(value, key) in props.session.stickyFacts" :key="key">
          <dt>{{ key }}</dt>
          <dd>{{ value }}</dd>
        </template>
      </dl>
    </details>

    <nav v-if="props.session.parent || props.session.children.length > 0" class="branch-navigation" aria-label="Ветки диалога">
      <span class="branch-navigation__label"><UIcon name="i-lucide-git-branch" aria-hidden="true" /> Ветки</span>
      <button v-if="props.session.parent" type="button" @click="navigateTo(`/chat/${props.session.parent.id}`)">Исходный диалог</button>
      <button v-for="child in props.session.children" :key="child.id" type="button" :class="{ 'branch-navigation__current': child.id === props.session.id }" @click="navigateTo(`/chat/${child.id}`)">{{ child.title }}</button>
    </nav>

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
          <button
            v-if="!isBusy && getMessageText(message)"
            type="button"
            class="message-memory-button"
            title="Сохранить видимый текст в память"
            @click="emit('saveMemory', { text: getMessageText(message), source: { sourceSessionId: props.session.id, sourceMessageId: message.id } })"
          >
            <UIcon name="i-lucide-brain" aria-hidden="true" />
            <span>Сохранить в память</span>
          </button>
          <button
            v-if="message.role === 'assistant' && !isBusy"
            type="button"
            class="branch-message-button"
            title="Создать ветку из этого ответа"
            @click="emit('createBranch', message.id)"
          >
            <UIcon name="i-lucide-git-branch" aria-hidden="true" />
            <span>Ветка</span>
          </button>
          <details
            v-for="attempt in compactionAttemptsByUserMessage.get(message.id) ?? []"
            :key="attempt.id"
            class="compaction-attempt"
          >
            <summary>
              Сжатие контекста: {{ attempt.status === 'completed' ? 'выполнено' : attempt.status === 'failed' ? 'ошибка' : 'в работе' }}
            </summary>
            <p v-if="attempt.summary" class="compaction-attempt__summary">{{ attempt.summary }}</p>
            <p v-if="attempt.error" class="compaction-attempt__error">{{ attempt.error }}</p>
            <p v-if="attempt.costRub" class="compaction-attempt__meta">Стоимость сжатия: {{ formatCost(attempt.costRub.total) }}</p>
          </details>
        </div>
      </template>
    </UChatMessages>

    <div v-if="visibleErrors.length" class="chat-error" role="alert">
      <div class="chat-error__copy"><UIcon name="i-lucide-circle-alert" /><span><span v-for="(message, index) in visibleErrors" :key="index" class="chat-error__message">{{ message }}</span></span></div>
      <UButton size="sm" color="neutral" variant="ghost" @click="dismissError">Закрыть</UButton>
    </div>

    <form class="chat-composer" @click="handleComposerClick" @submit="handleSubmit">
      <UTextarea v-model="draft" :disabled="isBusy || props.historyClearPending" :rows="3" autoresize size="xl" variant="none" :placeholder="props.historyClearPending ? 'Очистка истории ожидает завершения…' : 'Напишите сообщение…'" aria-label="Сообщение" @keydown="handleKeydown" />
      <div class="chat-composer__footer">
        <span class="chat-composer__hint">Enter — отправить · Shift+Enter — новая строка</span>
        <UButton v-if="isBusy" type="button" color="neutral" icon="i-lucide-square" aria-label="Остановить генерацию" @click="handleStop" />
        <UButton v-else type="submit" class="chat-composer__submit" color="neutral" variant="solid" aria-label="Отправить сообщение" :disabled="!draft.trim() || props.historyClearPending"><UIcon name="i-lucide-arrow-up" class="chat-composer__submit-icon" aria-hidden="true" /></UButton>
      </div>
    </form>
  </main>
</template>

<style scoped>
.chat-project {
  display: flex;
  align-items: center;
  gap: .3rem;
  margin: .3rem 0;
  color: #475569;
  font-size: .75rem;
  overflow-wrap: anywhere;
}

.chat-header__actions { flex-wrap: wrap; align-items: start; }

.sticky-facts-panel {
  margin: 0 1.25rem .75rem;
  border: 1px solid #dbe4ef;
  border-radius: .65rem;
  padding: .6rem .75rem;
  color: #475569;
  background: #f8fafc;
  font-size: .78rem;
}

.branch-navigation {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: .35rem;
  margin: 0 1.25rem .75rem;
  color: #64748b;
  font-size: .74rem;
}

.branch-navigation__label { display: inline-flex; align-items: center; gap: .25rem; font-weight: 600; }
.branch-navigation button { border: 0; border-radius: .35rem; padding: .25rem .4rem; color: #475569; background: #f1f5f9; font: inherit; cursor: pointer; }
.branch-navigation button:hover, .branch-navigation__current { color: #1e293b; background: #e2e8f0; }

.sticky-facts-panel summary { cursor: pointer; font-weight: 600; }
.sticky-facts-panel dl { display: grid; grid-template-columns: minmax(7rem, .4fr) 1fr; gap: .35rem .7rem; margin: .7rem 0 .1rem; }
.sticky-facts-panel dt { color: #64748b; font-weight: 600; }
.sticky-facts-panel dd { margin: 0; color: #334155; }

.branch-message-button {
  display: inline-flex;
  align-items: center;
  gap: .3rem;
  margin-top: .55rem;
  border: 0;
  padding: .2rem .35rem;
  color: #64748b;
  background: transparent;
  font: inherit;
  font-size: .72rem;
  cursor: pointer;
}

.branch-message-button:hover { color: #1e293b; background: #f1f5f9; }

.message-memory-button {
  display: inline-flex;
  align-items: center;
  gap: .3rem;
  margin-top: .35rem;
  border: 0;
  padding: .2rem .35rem;
  color: #64748b;
  background: transparent;
  font: inherit;
  font-size: .72rem;
  cursor: pointer;
}

.message-memory-button:hover { color: #1d4ed8; background: #eff6ff; }

.compaction-attempt {
  margin-top: 0.5rem;
  border-left: 2px solid #cbd5e1;
  padding-left: 0.65rem;
  color: #64748b;
  font-size: 0.75rem;
}

.compaction-attempt summary {
  cursor: pointer;
  font-weight: 600;
}

.compaction-attempt__summary,
.compaction-attempt__error,
.compaction-attempt__meta {
  margin: 0.35rem 0 0;
  white-space: pre-wrap;
}

.compaction-attempt__error {
  color: #b91c1c;
}
</style>
