<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import ChatSettingsModal from '~/components/ChatSettingsModal.vue'
import ProjectSessionGroups from '~/components/ProjectSessionGroups.vue'
import type { ChatCostSettings, ChatContextStrategySettings, SessionSummary } from '~/shared/chat'
import type { ModelConfiguration, ModelConfigurationSaveRequest } from '~/shared/model-config'
import type { Project } from '~/shared/memory'
import type { Invariant, InvariantChange } from '~/shared/invariant'

const costSettings = defineModel<ChatCostSettings>('costSettings', { required: true })
const detailedStatistics = defineModel<boolean>('detailedStatistics', { default: false })
const compactionEnabled = defineModel<boolean>('compactionEnabled', { required: true })
const compactionThreshold = defineModel<string>('compactionThreshold', { required: true })
const contextStrategy = defineModel<ChatContextStrategySettings>('contextStrategy', { required: true })
const settingsOpen = shallowRef(false)

const props = defineProps<{
  currentSession: SessionSummary
  refreshKey: number
  modelValue: string
  contextLimit: string
  defaultModel: string
  modelSaveError?: string | null
  modelConfigurations: ModelConfiguration[]
  configurationLoading?: boolean
  configurationSaving?: boolean
  configurationDeletingId?: string | null
  configurationError?: string | null
  configurationSaveError?: string | null
  configurationDeleteError?: string | null
  deleteError?: string | null
  deletingId?: string | null
  disabled?: boolean
  projects?: Project[]
  createdProjectId?: string | null
  projectError?: string | null
  invariants: Invariant[]
  invariantChanges: InvariantChange[]
  invariantsLoading?: boolean
  invariantError?: string | null
}>()

const emit = defineEmits<{
  refreshConfigurations: []
  select: [sessionId: string]
  newSession: [projectId: string | null]
  deleteSession: [session: { id: string; title: string }]
  'update:modelValue': [value: string]
  'update:contextLimit': [value: string]
  saveSettings: [payload: { modelId: string; contextLimit: string; contextStrategy: ChatContextStrategySettings; costSettings: ChatCostSettings; detailedStatistics: boolean }]
  saveConfiguration: [payload: ModelConfigurationSaveRequest]
  deleteConfiguration: [id: string]
  createProject: [name: string]
  renameProject: [payload: { id: string; name: string; expectedRevision: number }]
  assignProject: [projectId: string]
}>()

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

function openSettings(): void {
  settingsOpen.value = true
  emit('refreshConfigurations')
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
      <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-settings-2" block @click="openSettings">Настройки</UButton>
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
      :model-configurations="props.modelConfigurations"
      :configuration-loading="props.configurationLoading"
      :configuration-saving="props.configurationSaving"
      :configuration-deleting-id="props.configurationDeletingId"
      :configuration-error="props.configurationError"
      :configuration-save-error="props.configurationSaveError"
      :configuration-delete-error="props.configurationDeleteError"
      :invariants="props.invariants"
      :invariant-changes="props.invariantChanges"
      :invariants-loading="props.invariantsLoading"
      :invariant-error="props.invariantError"
      @cancel="settingsOpen = false"
      @save="handleSettingsSave"
      @save-configuration="emit('saveConfiguration', $event)"
      @delete-configuration="emit('deleteConfiguration', $event)"
    />

    <ProjectSessionGroups
      :projects="props.projects ?? []"
      :current-session="props.currentSession"
      :disabled="props.disabled"
      :deleting-id="props.deletingId"
      :refresh-key="props.refreshKey"
      :created-project-id="props.createdProjectId"
      :project-error="props.projectError"
      :delete-error="props.deleteError"
      @select="emit('select', $event)"
      @new-session="emit('newSession', $event)"
      @delete-session="emit('deleteSession', $event)"
      @create-project="emit('createProject', $event)"
      @rename-project="emit('renameProject', $event)"
      @assign-project="emit('assignProject', $event)"
    />
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

@media (max-width: 720px) {
  .chat-settings-summary__line { display: none; }
}
</style>
