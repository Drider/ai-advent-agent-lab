<script setup lang="ts">
import {
  DefaultChatTransport,
  isTextUIPart,
  type UIMessage,
} from 'ai'
import math, { Math as MathRenderer } from '@comark/nuxt/plugins/math'
import type { ChatRequestBody } from '~/shared/chat'
import { computed, onMounted, shallowRef } from 'vue'
import { useChat } from '@ai-sdk/vue'

const config = useRuntimeConfig()
const defaultModel = config.public.chatDefaultModel
const modelId = shallowRef(defaultModel)
const draft = shallowRef('')
const runId = shallowRef(createRunId())
const settingsOpen = shallowRef(true)

const markdownComponents = { math: MathRenderer }
const markdownPlugins = [math()]

function createRunId(): string {
  return new Date().toISOString()
}

const transport = new DefaultChatTransport<UIMessage>({
  api: '/api/chat',
  prepareSendMessagesRequest: ({ messages }) => ({
    body: {
      messages,
      model: modelId.value,
      runId: runId.value,
    } satisfies ChatRequestBody,
  }),
})

const {
  messages,
  status,
  error,
  sendMessage,
  stop,
  clearError,
} = useChat<UIMessage>({ transport })

const isBusy = computed(() => status.value === 'submitted' || status.value === 'streaming')
const statusLabel = computed(() => {
  if (status.value === 'submitted') return 'Подключение'
  if (status.value === 'streaming') return 'Генерация'
  if (status.value === 'error') return 'Ошибка'
  return 'Готово'
})

function hasToolPart(message: UIMessage): boolean {
  return message.parts.some(part => part.type.startsWith('tool-'))
}

async function handleSubmit(event?: Event): Promise<void> {
  event?.preventDefault()

  const text = draft.value.trim()
  if (!text || isBusy.value) {
    return
  }

  clearError()
  draft.value = ''
  await sendMessage({ text })
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void handleSubmit()
  }
}

function handleNewSession(): void {
  if (isBusy.value) {
    return
  }

  messages.value = []
  draft.value = ''
  modelId.value = defaultModel
  runId.value = createRunId()
  clearError()
}

onMounted(() => {
  if (window.innerWidth <= 720) {
    settingsOpen.value = false
  }
})
</script>

<template>
  <main class="chat-layout">
    <aside
      class="settings-sidebar"
      :class="{ 'settings-sidebar--open': settingsOpen }"
      aria-label="Настройки чата"
    >
      <div class="settings-sidebar__top">
        <span v-if="settingsOpen" class="settings-sidebar__title">Настройки</span>
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          square
          :icon="settingsOpen ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left-open'"
          :aria-label="settingsOpen ? 'Свернуть настройки' : 'Развернуть настройки'"
          @click="settingsOpen = !settingsOpen"
        />
      </div>

      <ModelSettings
        v-if="settingsOpen"
        v-model="modelId"
        :default-model="defaultModel"
      />
    </aside>

    <section class="chat-workspace">
      <header class="chat-header">
        <div class="chat-header__copy">
          <p class="chat-eyebrow" :title="modelId">AI SDK · {{ modelId }}</p>
          <h1>Чат с LLM</h1>
        </div>
        <div class="chat-header__actions">
          <UBadge color="neutral" variant="subtle">
            {{ statusLabel }}
          </UBadge>
          <UButton
            color="neutral"
            variant="soft"
            icon="i-lucide-square-pen"
            label="Новая сессия"
            :disabled="isBusy"
            @click="handleNewSession"
          />
        </div>
      </header>

      <div v-if="messages.length === 0" class="chat-empty-state">
        <div class="chat-empty-state__mark">
          <UIcon name="i-lucide-sparkles" />
        </div>
        <h2>Чем могу помочь?</h2>
        <p>Задайте вопрос или попросите бросить кубик — агент сам вызовет инструмент.</p>
      </div>

      <UChatMessages
        v-else
        :messages="messages"
        :status="status"
        :should-auto-scroll="true"
        :should-scroll-to-bottom="true"
        class="chat-messages"
        :assistant="{ variant: 'naked' }"
        :user="{ variant: 'soft' }"
      >
        <template #content="{ message }">
          <div class="message-content">
            <template v-for="(part, index) in message.parts" :key="message.id + '-' + index">
              <Markdown
                v-if="isTextUIPart(part) && message.role === 'assistant'"
                :value="part.text"
                :components="markdownComponents"
                :plugins="markdownPlugins"
              />
              <p v-else-if="isTextUIPart(part)" class="user-message-text">
                {{ part.text }}
              </p>
            </template>

            <div
              v-if="message.role === 'assistant' && hasToolPart(message)"
              class="tool-status"
            >
              <UIcon name="i-lucide-dices" />
              <span>Агент бросает кубик…</span>
            </div>
          </div>
        </template>
      </UChatMessages>

      <div v-if="error" class="chat-error" role="alert">
        <div class="chat-error__copy">
          <UIcon name="i-lucide-circle-alert" />
          <span>{{ error.message || 'Не удалось получить ответ модели.' }}</span>
        </div>
        <UButton
          size="sm"
          color="error"
          variant="soft"
          @click="clearError"
        >
          Закрыть
        </UButton>
      </div>

      <form class="chat-composer" @submit="handleSubmit">
        <UTextarea
          v-model="draft"
          :disabled="isBusy"
          :rows="3"
          autoresize
          size="xl"
          variant="none"
          placeholder="Напишите сообщение…"
          aria-label="Сообщение"
          @keydown="handleKeydown"
        />
        <div class="chat-composer__footer">
          <span>Enter — отправить · Shift+Enter — новая строка</span>
          <UButton
            v-if="isBusy"
            type="button"
            color="neutral"
            icon="i-lucide-square"
            aria-label="Остановить генерацию"
            @click="stop"
          />
          <UButton
            v-else
            type="submit"
            color="neutral"
            icon="i-lucide-arrow-up"
            aria-label="Отправить сообщение"
            :disabled="!draft.trim()"
          />
        </div>
      </form>
    </section>
  </main>
</template>
