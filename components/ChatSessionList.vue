<script setup lang="ts">
import type { SessionSummary } from '~/shared/chat'

const props = defineProps<{
  items: SessionSummary[]
  selectedId: string
  loading?: boolean
  disabled?: boolean
  hasMore?: boolean
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  newSession: []
  loadMore: []
}>()

function statusLabel(status: SessionSummary['status']): string {
  if (status === 'running') return 'В работе'
  if (status === 'interrupted') return 'Прерван'
  if (status === 'stopped') return 'Остановлен'
  if (status === 'failed') return 'Ошибка'
  if (status === 'needs_review') return 'Нужна проверка'
  return ''
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(value))
}
</script>

<template>
  <aside class="session-sidebar" aria-label="Сессии чата">
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
    <div v-else-if="props.items.length === 0" class="session-sidebar__empty">
      Пока нет сохранённых диалогов.
    </div>
    <nav v-else class="session-list" aria-label="Список диалогов">
      <button
        v-for="item in props.items"
        :key="item.id"
        class="session-list__item"
        :class="{ 'session-list__item--selected': item.id === props.selectedId }"
        type="button"
        :disabled="props.disabled"
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
    </nav>

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
