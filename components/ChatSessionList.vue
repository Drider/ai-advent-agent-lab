<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import ChatSettingsModal from '~/components/ChatSettingsModal.vue'
import type { ChatCostSettings, ChatContextStrategySettings, SessionSummary } from '~/shared/chat'
import ProjectSelector from '~/components/ProjectSelector.vue'
import type { Project } from '~/shared/memory'

const costSettings = defineModel<ChatCostSettings>('costSettings', { required: true })
const detailedStatistics = defineModel<boolean>('detailedStatistics', { default: false })
const compactionEnabled = defineModel<boolean>('compactionEnabled', { required: true })
const compactionThreshold = defineModel<string>('compactionThreshold', { required: true })
const contextStrategy = defineModel<ChatContextStrategySettings>('contextStrategy', { required: true })
const settingsOpen = shallowRef(false)

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
  projects?: Project[]
  projectFilter?: string
  currentProjectId?: string
  projectError?: string | null
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  newSession: []
  loadMore: []
  deleteSession: [sessionId: string]
  'update:modelValue': [value: string]
  'update:contextLimit': [value: string]
  saveSettings: [payload: { modelId: string; contextLimit: string; contextStrategy: ChatContextStrategySettings; costSettings: ChatCostSettings; detailedStatistics: boolean }]
  'update:projectFilter': [value: string | undefined]
  createProject: [name: string]
  renameProject: [payload: { id: string; name: string; expectedRevision: number }]
  assignProject: [projectId: string]
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

const strategyLabel = computed(() => {
  switch (contextStrategy.value.strategy) {
    case 'sliding_window': return `Sliding Window · ${contextStrategy.value.windowSize}`
    case 'sticky_facts': return `Sticky Facts · ${contextStrategy.value.windowSize}`
    case 'off': return 'Выключено'
    default: return `Summary · ${contextStrategy.value.messageThreshold}`
  }
})

function handleSettingsSave(payload: { modelId: string; contextLimit: string; contextStrategy: ChatContextStrategySettings; costSettings: ChatCostSettings; detailedStatistics: boolean }): void {
  emit('saveSettings', payload)
  settingsOpen.value = false
}
</script>

<template>
  <aside class="session-sidebar" aria-label="Сессии чата">
    <section class="chat-settings-summary" aria-label="Текущие настройки">
      <div class="chat-settings-summary__line"><span>Модель</span><strong :title="props.modelValue">{{ props.modelValue }}</strong></div>
      <div class="chat-settings-summary__line"><span>Окно</span><strong>{{ props.contextLimit || 'не задано' }}</strong></div>
      <div class="chat-settings-summary__line"><span>Контекст</span><strong>{{ strategyLabel }}</strong></div>
      <div class="chat-settings-summary__line"><span>Стоимость</span><strong>{{ costSettings.enabled ? 'включена' : 'выключена' }}</strong></div>
      <div class="chat-settings-summary__line"><span>Статистика</span><strong>{{ detailedStatistics ? 'подробная' : 'обычная' }}</strong></div>
      <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-settings-2" block @click="settingsOpen = true">Настройки</UButton>
      <p v-if="props.modelSaveError" class="chat-settings-summary__error" role="alert">{{ props.modelSaveError }}</p>
    </section>
    <ChatSettingsModal
      :open="settingsOpen"
      :model-id="props.modelValue"
      :context-limit="props.contextLimit"
      :default-model="props.defaultModel"
      :context-strategy="contextStrategy"
      :cost-settings="costSettings"
      :detailed-statistics="detailedStatistics"
      :save-error="props.modelSaveError"
      @cancel="settingsOpen = false"
      @save="handleSettingsSave"
    />

    <ProjectSelector
      :projects="props.projects ?? []"
      :model-value="props.projectFilter"
      :assigned-project-id="props.currentProjectId"
      :disabled="props.disabled"
      @update:model-value="emit('update:projectFilter', $event)"
      @create="emit('createProject', $event)"
      @rename="emit('renameProject', $event)"
      @assign-session="emit('assignProject', $event)"
    />
    <p v-if="props.projectError" class="session-sidebar__error" role="alert">{{ props.projectError }}</p>

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
            <span class="session-list__item-meta">
              <span
                class="session-list__kind"
                :class="{ 'session-list__kind--branch': item.branchSourceMessageId }"
              >
                <UIcon
                  :name="item.branchSourceMessageId ? 'i-lucide-git-branch' : 'i-lucide-message-square'"
                  aria-hidden="true"
                />
                {{ item.branchSourceMessageId ? 'Ветка' : 'Основной диалог' }}
              </span>
              <span>{{ formatDate(item.updatedAt) }}</span>
            </span>
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
.chat-settings-summary {
  display: grid;
  gap: 0.55rem;
  border-bottom: 1px solid #e2e8f0;
  padding: 0.1rem 0.25rem 1rem;
}

.chat-settings-summary__line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .7rem;
  color: #64748b;
  font-size: .74rem;
}

.chat-settings-summary__line strong {
  min-width: 0;
  overflow: hidden;
  color: #334155;
  font-size: .75rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-settings-summary__error {
  margin: 0;
  color: #b42318;
  font-size: .74rem;
  line-height: 1.35;
}
</style>
