<script setup lang="ts">
import type { ChatCostSettings, SessionSummary } from '~/shared/chat'

const costSettings = defineModel<ChatCostSettings>('costSettings', { required: true })
const detailedStatistics = defineModel<boolean>('detailedStatistics', { default: false })

const props = defineProps<{
  items: SessionSummary[]
  selectedId: string
  modelValue: string
  contextLimit: string
  defaultModel: string
  modelSaveError?: string | null
  listError?: string | null
  deleteError?: string | null
  deletingId?: string | null
  loading?: boolean
  disabled?: boolean
  hasMore?: boolean
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  newSession: []
  loadMore: []
  deleteSession: [sessionId: string]
  'update:modelValue': [value: string]
  'update:contextLimit': [value: string]
}>()

function statusLabel(status: SessionSummary['status']): string {
  switch (status) {
    case 'running':
      return 'В работе'
    case 'interrupted':
      return 'Прерван'
    case 'stopped':
      return 'Остановлен'
    case 'failed':
      return 'Ошибка'
    case 'needs_review':
      return 'Нужна проверка'
    default:
      return ''
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(value))
}
</script>

<template>
  <aside class="session-sidebar" aria-label="Сессии чата">
    <ModelSettings
      :model-value="props.modelValue"
      :context-limit="props.contextLimit"
      :default-model="props.defaultModel"
      :save-error="props.modelSaveError"
      @update:model-value="emit('update:modelValue', $event)"
      @update:context-limit="emit('update:contextLimit', $event)"
    />
    <ChatCostSettings v-model="costSettings" />

    <section class="chat-token-settings" aria-label="Настройки статистики токенов">
      <label class="chat-token-settings__toggle">
        <input v-model="detailedStatistics" type="checkbox" aria-describedby="token-statistics-hint">
        <span>Подробная статистика токенов</span>
      </label>
      <p id="token-statistics-hint">Кэш, размышления и расход по обращениям к модели.</p>
    </section>

    <div class="session-sidebar__header">
      <div>
        <p class="session-sidebar__eyebrow">История</p>
        <h2>Диалоги</h2>
      </div>
      <UButton
        icon="i-lucide-square-pen"
        color="neutral"
        variant="soft"
        square
        aria-label="Новая сессия"
        :disabled="props.disabled"
        @click="emit('newSession')"
      />
    </div>

    <div v-if="props.loading" class="session-sidebar__empty" role="status">
      Загружаем диалоги…
    </div>
    <div v-else-if="props.items.length === 0 && !props.listError" class="session-sidebar__empty">
      Пока нет сохранённых диалогов.
    </div>
    <nav v-else-if="props.items.length > 0" class="session-list" aria-label="Список диалогов">
      <div
        v-for="item in props.items"
        :key="item.id"
        class="session-list__row"
      >
        <button
          class="session-list__item"
          :class="{ 'session-list__item--selected': item.id === props.selectedId }"
          type="button"
          :disabled="props.disabled || Boolean(props.deletingId)"
          :aria-current="item.id === props.selectedId ? 'page' : undefined"
          @click="emit('select', item.id)"
        >
          <span class="session-list__item-copy">
            <strong>{{ item.title }}</strong>
            <span>{{ formatDate(item.updatedAt) }}</span>
          </span>
          <span v-if="statusLabel(item.status)" class="session-list__status">
            {{ statusLabel(item.status) }}
          </span>
        </button>
        <UButton
          class="session-list__delete"
          icon="i-lucide-trash-2"
          color="error"
          variant="ghost"
          size="sm"
          square
          :aria-label="`Удалить диалог «${item.title}»`"
          :title="item.status === 'running' ? 'Дождитесь завершения запроса' : 'Удалить диалог'"
          :disabled="props.disabled || item.status === 'running' || Boolean(props.deletingId)"
          :loading="props.deletingId === item.id"
          @click="emit('deleteSession', item.id)"
        />
      </div>
    </nav>

    <p v-if="props.listError" class="session-sidebar__error" role="alert">
      {{ props.listError }}
    </p>
    <p v-if="props.deleteError" class="session-sidebar__error" role="alert">
      {{ props.deleteError }}
    </p>

    <UButton
      v-if="props.hasMore"
      class="session-sidebar__more"
      color="neutral"
      variant="ghost"
      size="sm"
      block
      :disabled="props.loading"
      @click="emit('loadMore')"
    >
      Загрузить ещё
    </UButton>
  </aside>
</template>

<style scoped>
.chat-token-settings {
  display: grid;
  gap: 0.45rem;
  border-bottom: 1px solid #e2e8f0;
  padding: 0.1rem 0.25rem 1rem;
}

.chat-token-settings__toggle {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  color: #334155;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}

.chat-token-settings__toggle input {
  width: 1rem;
  height: 1rem;
  flex: 0 0 auto;
  accent-color: #2563eb;
}

.chat-token-settings p {
  margin: 0;
  color: #64748b;
  font-size: 0.75rem;
  line-height: 1.4;
}
</style>
