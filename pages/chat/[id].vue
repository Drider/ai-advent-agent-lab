<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import ChatSessionList from '~/components/ChatSessionList.vue'
import ChatWorkspace from '~/components/ChatWorkspace.vue'
import MemoryEntryForm from '~/components/MemoryEntryForm.vue'
import { DEFAULT_COMPACTION_SETTINGS, DEFAULT_CONTEXT_STRATEGY_SETTINGS, normalizeStoredContextLimits, pricingFromSettings, validateContextStrategySettings, validateModelId, type ChatCostSettings, type ChatContextStrategySettings, type SessionDetail, type SessionSummary } from '~/shared/chat'
import { selectInitialSession } from '~/shared/session-navigation'
import { useMemory } from '~/composables/useMemory'
import type { Project, MemorySource } from '~/shared/memory'
import type { ModelConfiguration, ModelConfigurationSaveRequest } from '~/shared/model-config'
import type { UserProfileSummary } from '~/shared/user-profile'

interface SessionListResponse {
  items: SessionSummary[]
  preferredSessionId?: string
}

const route = useRoute()
const memory = useMemory()
const config = useRuntimeConfig()
const defaultModel = config.public.chatDefaultModel
const modelId = shallowRef(defaultModel)
const costSettings = shallowRef<ChatCostSettings>({ enabled: false, inputPrice: '', outputPrice: '' })
const detailedStatistics = shallowRef(false)
const contextLimits = shallowRef<Record<string, string>>({})
const compactionEnabled = shallowRef(DEFAULT_COMPACTION_SETTINGS.enabled)
const compactionThreshold = shallowRef(String(DEFAULT_COMPACTION_SETTINGS.messageThreshold))
const contextStrategy = shallowRef<ChatContextStrategySettings>({ ...DEFAULT_CONTEXT_STRATEGY_SETTINGS })
const legacyCompactionSnapshot = shallowRef<{ enabled: boolean; messageThreshold: number } | null>(null)
const contextLimit = computed({
  get: () => contextLimits.value[modelId.value] ?? '',
  set: (value: string) => {
    contextLimits.value = { ...contextLimits.value, [modelId.value]: value }
  },
})
const pricing = computed(() => pricingFromSettings(costSettings.value))
const session = shallowRef<SessionDetail | null>(null)
const userProfiles = shallowRef<UserProfileSummary[]>([])
const userProfilesLoading = shallowRef(false)
const profileSelectionError = shallowRef<string | null>(null)
const loading = shallowRef(true)
const groupRefreshKey = shallowRef(0)
const workspaceBusy = shallowRef(false)
const error = shallowRef<string | null>(null)
const operationError = shallowRef<string | null>(null)
const modelSaveError = shallowRef<string | null>(null)
const deleteError = shallowRef<string | null>(null)
const modelConfigurations = shallowRef<ModelConfiguration[]>([])
const configurationLoading = shallowRef(false)
const configurationSaving = shallowRef(false)
const configurationDeletingId = shallowRef<string | null>(null)
const configurationError = shallowRef<string | null>(null)
const configurationSaveError = shallowRef<string | null>(null)
const configurationDeleteError = shallowRef<string | null>(null)
const projectError = shallowRef<string | null>(null)
const historyClearPending = shallowRef(false)
const projects = shallowRef<Project[]>([])
const createdProjectId = shallowRef<string | null>(null)
const memoryFormOpen = shallowRef(false)
const memoryFormLayer = shallowRef<'working' | 'long_term'>('long_term')
const memoryFormText = shallowRef('')
const memoryFormSource = shallowRef<MemorySource | undefined>()
const deletingId = shallowRef<string | null>(null)
let modelSave = Promise.resolve()

const sessionId = computed(() => String(route.params.id))
const currentProject = computed(() => projects.value.find(project => project.id === session.value?.projectId))

async function loadSession(): Promise<void> {
  const requestedId = sessionId.value
  loading.value = true
  error.value = null
  modelSaveError.value = null
  try {
    const loadedSession = await $fetch<SessionDetail>(`/api/sessions/${requestedId}`)
    if (sessionId.value !== requestedId) return
    session.value = loadedSession
    const pendingClear = await memory.loadPendingHistoryClear(requestedId)
    if (sessionId.value !== requestedId) return
    historyClearPending.value = pendingClear !== null
    if (pendingClear) operationError.value = 'Очистка истории этого диалога ожидает завершения. Откройте «Память», чтобы повторить операцию.'
    modelId.value = loadedSession.modelId ?? loadedSession.lastTurn?.modelId ?? defaultModel
    contextStrategy.value = loadedSession.contextStrategy
    compactionEnabled.value = loadedSession.contextStrategy.strategy === 'summary'
    compactionThreshold.value = String(loadedSession.contextStrategy.messageThreshold)
  } catch (caughtError) {
    if (sessionId.value !== requestedId) return
    session.value = null
    historyClearPending.value = false
    error.value = caughtError instanceof Error ? caughtError.message : 'Сессия не найдена'
  } finally {
    if (sessionId.value === requestedId) loading.value = false
  }
}

async function loadUserProfiles(): Promise<void> {
  userProfilesLoading.value = true
  try {
    const result = await $fetch<{ items: UserProfileSummary[] }>('/api/user-profiles')
    userProfiles.value = result.items
    profileSelectionError.value = null
  } catch (caughtError) {
    profileSelectionError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить профили.'
  } finally {
    userProfilesLoading.value = false
  }
}

async function handleSelectProfile(profileId: string): Promise<void> {
  const current = session.value
  if (!current || workspaceBusy.value || current.userProfileId === profileId) return
  profileSelectionError.value = null
  try {
    const result = await $fetch<{ userProfileId: string; userProfile: UserProfileSummary }>(`/api/sessions/${current.id}/user-profile`, {
      method: 'PATCH',
      body: { profileId },
    })
    if (session.value?.id === current.id) {
      session.value = { ...current, userProfileId: result.userProfileId, userProfile: result.userProfile }
    }
  } catch (caughtError) {
    profileSelectionError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось выбрать профиль.'
  }
}

async function handleSettingsSave(payload: {
  modelId: string
  contextLimit: string
  contextStrategy: ChatContextStrategySettings
  costSettings: ChatCostSettings
  detailedStatistics: boolean
}): Promise<void> {
  const id = session.value?.id
  if (!id) return
  try {
    const validModelId = validateModelId(payload.modelId)
    const validStrategy = validateContextStrategySettings(payload.contextStrategy)
    await modelSave
    await $fetch(`/api/sessions/${id}/model`, { method: 'PATCH', body: { modelId: validModelId } })
    await $fetch(`/api/sessions/${id}/context-strategy`, { method: 'PATCH', body: validStrategy })
    modelId.value = validModelId
    contextStrategy.value = validStrategy
    compactionEnabled.value = validStrategy.strategy === 'summary'
    compactionThreshold.value = String(validStrategy.messageThreshold)
    contextLimit.value = payload.contextLimit
    costSettings.value = payload.costSettings
    detailedStatistics.value = payload.detailedStatistics
    modelSaveError.value = null
  } catch (caughtError) {
    modelSaveError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить настройки диалога.'
  }
}

async function loadModelConfigurations(): Promise<void> {
  configurationLoading.value = true
  configurationError.value = null
  modelConfigurations.value = []
  try {
    modelConfigurations.value = await $fetch<ModelConfiguration[]>('/api/model-configurations')
  } catch (caughtError) {
    configurationError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить конфигурации моделей.'
  } finally {
    configurationLoading.value = false
  }
}

async function handleSaveModelConfiguration(payload: ModelConfigurationSaveRequest): Promise<void> {
  configurationSaving.value = true
  configurationSaveError.value = null
  try {
    const saved = await $fetch<ModelConfiguration>('/api/model-configurations', { method: 'POST', body: payload })
    modelConfigurations.value = [saved, ...modelConfigurations.value.filter(configuration => configuration.id !== saved.id)]
    configurationError.value = null
  } catch (caughtError) {
    configurationSaveError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить конфигурацию модели.'
  } finally {
    configurationSaving.value = false
  }
}

async function handleDeleteModelConfiguration(id: string): Promise<void> {
  configurationDeletingId.value = id
  configurationDeleteError.value = null
  try {
    await $fetch(`/api/model-configurations/${id}`, { method: 'DELETE' })
    modelConfigurations.value = modelConfigurations.value.filter(configuration => configuration.id !== id)
    configurationError.value = null
  } catch (caughtError) {
    configurationDeleteError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось удалить конфигурацию модели.'
  } finally {
    configurationDeletingId.value = null
  }
}

function handleModelChange(value: string): void {
  modelId.value = value
  const id = session.value?.id
  if (!id) return

  let validModelId: string
  try {
    validModelId = validateModelId(value)
  } catch (caughtError) {
    modelSaveError.value = caughtError instanceof Error ? caughtError.message : 'Некорректный ID модели.'
    return
  }

  modelSave = modelSave.then(async () => {
    await $fetch(`/api/sessions/${id}/model`, {
      method: 'PATCH',
      body: { modelId: validModelId },
    })
    modelSaveError.value = null
  }).catch(() => {
    modelSaveError.value = 'Не удалось сохранить модель для диалога.'
  })
}

async function handleNewSession(projectId?: string | null): Promise<void> {
  if (workspaceBusy.value || deletingId.value) return
  if (!window.confirm('Создать новую сессию?')) return
  operationError.value = null
  let created = false
  try {
    await modelSave
    const targetProjectId = projectId === undefined ? session.value?.projectId : projectId ?? undefined
    const newSession = await $fetch<SessionSummary>('/api/sessions', { method: 'POST', body: targetProjectId ? { projectId: targetProjectId } : undefined })
    created = true
    await navigateTo(`/chat/${newSession.id}`)
  } catch {
    operationError.value = created ? 'Диалог создан, но не удалось его открыть.' : 'Не удалось создать новый диалог.'
  }
}

async function loadProjects(): Promise<void> {
  try {
    const loaded: Project[] = []
    let cursor: string | undefined
    do {
      const page = await memory.loadProjects({ limit: 100, ...(cursor ? { cursor } : {}) })
      loaded.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    projects.value = loaded
    projectError.value = null
  } catch {
    projectError.value = 'Не удалось загрузить проекты.'
  }
}

async function handleCreateProject(name: string): Promise<void> {
  projectError.value = null
  try {
    const project = await $fetch<Project>('/api/projects', { method: 'POST', body: { name } })
    projects.value = [project, ...projects.value]
    createdProjectId.value = project.id
  } catch (caughtError) {
    projectError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось создать проект.'
  }
}

async function handleRenameProject(payload: { id: string; name: string; expectedRevision: number }): Promise<void> {
  try {
    const project = await $fetch<Project>(`/api/projects/${payload.id}`, { method: 'PATCH', body: payload })
    projects.value = projects.value.map(item => item.id === project.id ? project : item)
    projectError.value = null
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : 'Не удалось переименовать проект.'
    await loadProjects()
    projectError.value = message
  }
}

async function handleAssignProject(projectId: string): Promise<void> {
  if (!session.value || session.value.projectId || workspaceBusy.value) return
  try {
    await $fetch(`/api/sessions/${session.value.id}/project`, { method: 'PATCH', body: { projectId } })
    await loadSession()
    groupRefreshKey.value++
    projectError.value = null
  } catch (caughtError) {
    projectError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось подключить диалог к проекту.'
  }
}

function handleSaveMemory(payload: { text: string; source: MemorySource }): void {
  memoryFormLayer.value = session.value?.projectId ? 'working' : 'long_term'
  memoryFormText.value = payload.text
  memoryFormSource.value = payload.source
  memoryFormOpen.value = true
}

function handleMemorySaved(): void {
  memoryFormOpen.value = false
  operationError.value = 'Запись сохранена в память.'
}

async function handleSelect(selectedId: string): Promise<void> {
  if (workspaceBusy.value || deletingId.value || selectedId === sessionId.value) return
  operationError.value = null
  try {
    await modelSave
    await navigateTo(`/chat/${selectedId}`)
  } catch {
    operationError.value = 'Не удалось открыть выбранный диалог.'
  }
}

async function handleDelete(item: { id: string; title: string }): Promise<void> {
  if (workspaceBusy.value || deletingId.value) return
  if (!window.confirm(`Удалить диалог «${item.title}» и всю его историю? Логи сохранятся.`)) return

  deletingId.value = item.id
  deleteError.value = null
  let deleted = false
  try {
    if (item.id === sessionId.value) await modelSave
    await $fetch(`/api/sessions/${item.id}`, { method: 'DELETE' })
    deleted = true
    if (item.id === sessionId.value) {
      const remaining = await $fetch<SessionListResponse>('/api/sessions')
      const nextId = selectInitialSession(remaining)
      await navigateTo(nextId ? `/chat/${nextId}` : '/', { replace: true })
    } else groupRefreshKey.value++
  } catch {
    if (deleted && item.id === sessionId.value) {
      try {
        await navigateTo('/', { replace: true })
      } catch {
        deleteError.value = 'Диалог удалён, но не удалось открыть историю.'
      }
    } else {
      deleteError.value = 'Не удалось удалить диалог. Попробуйте ещё раз.'
    }
  } finally {
    deletingId.value = null
  }
}

async function handleUpdated(): Promise<void> {
  const id = sessionId.value
  await Promise.all([
    $fetch<SessionDetail>(`/api/sessions/${id}`).then(detail => {
      if (sessionId.value === id) {
        session.value = detail
      }
    }).catch(() => {
      if (sessionId.value === id) operationError.value = 'Не удалось обновить состояние диалога. Перезагрузите страницу, чтобы проверить результат.'
    }),
    memory.loadPendingHistoryClear(id).then(pending => {
      if (sessionId.value === id) historyClearPending.value = pending !== null
    }).catch(() => undefined),
    loadUserProfiles(),
  ])
  groupRefreshKey.value++
}

async function handleCreateBranch(messageId: string): Promise<void> {
  if (workspaceBusy.value || deletingId.value) return
  operationError.value = null
  try {
    const branch = await $fetch<SessionSummary>(`/api/sessions/${sessionId.value}/branches`, {
      method: 'POST',
      body: { throughMessageId: messageId },
    })
    await navigateTo(`/chat/${branch.id}`)
  } catch (caughtError) {
    operationError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось создать ветку диалога.'
  }
}

async function importLegacyCompactionSettings(): Promise<void> {
  const legacy = legacyCompactionSnapshot.value
  const loaded = session.value
  if (!legacy || !loaded || localStorage.getItem('agent-chat-context-strategy-migrated-v1') === 'true') return

  // The old browser setting was global. Import it only while the session still
  // has the new default, then let the per-session setting take over.
  if (loaded.contextStrategy.strategy !== DEFAULT_CONTEXT_STRATEGY_SETTINGS.strategy
    || loaded.contextStrategy.messageThreshold !== DEFAULT_CONTEXT_STRATEGY_SETTINGS.messageThreshold) {
    localStorage.setItem('agent-chat-context-strategy-migrated-v1', 'true')
    return
  }

  const migrated = validateContextStrategySettings({
    ...loaded.contextStrategy,
    strategy: legacy.enabled ? 'summary' : 'off',
    messageThreshold: legacy.messageThreshold,
  })
  if (migrated.strategy === loaded.contextStrategy.strategy && migrated.messageThreshold === loaded.contextStrategy.messageThreshold) {
    localStorage.setItem('agent-chat-context-strategy-migrated-v1', 'true')
    return
  }

  try {
    await $fetch(`/api/sessions/${loaded.id}/context-strategy`, { method: 'PATCH', body: migrated })
    contextStrategy.value = migrated
    compactionEnabled.value = migrated.strategy === 'summary'
    compactionThreshold.value = String(migrated.messageThreshold)
    localStorage.setItem('agent-chat-context-strategy-migrated-v1', 'true')
  } catch {
    operationError.value = 'Не удалось перенести старую настройку сжатия в настройки диалога.'
  }
}

onMounted(async () => {
  try {
    const saved = JSON.parse(localStorage.getItem('agent-chat-context-limits-v1') ?? '{}') as unknown
    contextLimits.value = normalizeStoredContextLimits(saved)
  } catch {
    operationError.value ??= 'Не удалось прочитать локальные настройки. Проверьте настройки браузера.'
  }
  try {
    const saved = JSON.parse(localStorage.getItem('agent-chat-compaction-settings-v1') ?? 'null') as unknown
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      const record = saved as Record<string, unknown>
      if (typeof record.enabled === 'boolean') compactionEnabled.value = record.enabled
      if (typeof record.messageThreshold === 'number' && Number.isSafeInteger(record.messageThreshold)) {
        compactionThreshold.value = String(record.messageThreshold)
        legacyCompactionSnapshot.value = {
          enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
          messageThreshold: record.messageThreshold >= 12 && record.messageThreshold <= 10_000
            ? record.messageThreshold
            : DEFAULT_COMPACTION_SETTINGS.messageThreshold,
        }
      }
    }
  } catch {
    operationError.value ??= 'Не удалось прочитать локальные настройки сжатия.'
  }
  try {
    detailedStatistics.value = localStorage.getItem('agent-chat-detailed-statistics-v1') === 'true'
  } catch {
    operationError.value ??= 'Не удалось прочитать локальные настройки. Проверьте настройки браузера.'
  }
  try {
    const saved = JSON.parse(localStorage.getItem('agent-chat-cost-settings-v1') ?? 'null') as unknown
    if (saved && typeof saved === 'object'
      && 'enabled' in saved && typeof saved.enabled === 'boolean'
      && 'inputPrice' in saved && typeof saved.inputPrice === 'string'
      && 'outputPrice' in saved && typeof saved.outputPrice === 'string') {
      costSettings.value = saved as ChatCostSettings
    }
  } catch {
    operationError.value ??= 'Не удалось прочитать локальные настройки. Проверьте настройки браузера.'
  }
  await Promise.all([loadSession(), loadUserProfiles(), loadProjects()])
  await importLegacyCompactionSettings()
})

watch(costSettings, value => {
  if (!import.meta.client) return
  try {
    localStorage.setItem('agent-chat-cost-settings-v1', JSON.stringify(value))
  } catch {
    operationError.value ??= 'Не удалось сохранить локальные настройки в браузере.'
  }
})

watch(detailedStatistics, value => {
  if (!import.meta.client) return
  try {
    localStorage.setItem('agent-chat-detailed-statistics-v1', String(value))
  } catch {
    operationError.value ??= 'Не удалось сохранить локальные настройки в браузере.'
  }
})

watch(contextLimits, value => {
  if (!import.meta.client) return
  try {
    localStorage.setItem('agent-chat-context-limits-v1', JSON.stringify(value))
  } catch {
    operationError.value ??= 'Не удалось сохранить локальные настройки в браузере.'
  }
})

watch([compactionEnabled, compactionThreshold], ([enabled, threshold]) => {
  if (!import.meta.client) return
  try {
    localStorage.setItem('agent-chat-compaction-settings-v1', JSON.stringify({ enabled, messageThreshold: Number(threshold) }))
  } catch {
    operationError.value ??= 'Не удалось сохранить настройки сжатия в браузере.'
  }
})

watch(sessionId, () => {
  void loadSession()
})
</script>

<template>
  <main v-if="loading" class="route-state">
    <UIcon name="i-lucide-loader-circle" class="route-state__spinner" aria-hidden="true" />
    <span>Загружаем диалог…</span>
  </main>
  <main v-else-if="!session" class="route-state">
    <UIcon name="i-lucide-circle-alert" class="route-state__icon" />
    <h1>Диалог не найден</h1>
    <p>{{ error }}</p>
    <UButton color="neutral" @click="navigateTo('/')">Открыть историю</UButton>
  </main>
  <div v-else class="chat-app-shell">
    <ChatSessionList
      :current-session="session"
      :refresh-key="groupRefreshKey"
      :model-value="modelId"
      v-model:context-limit="contextLimit"
      :model-save-error="modelSaveError"
      :model-configurations="modelConfigurations"
      :configuration-loading="configurationLoading"
      :configuration-saving="configurationSaving"
      :configuration-deleting-id="configurationDeletingId"
      :configuration-error="configurationError"
      :configuration-save-error="configurationSaveError"
      :configuration-delete-error="configurationDeleteError"
      :delete-error="deleteError"
      :deleting-id="deletingId"
      v-model:cost-settings="costSettings"
      v-model:detailed-statistics="detailedStatistics"
      v-model:compaction-enabled="compactionEnabled"
      v-model:compaction-threshold="compactionThreshold"
      v-model:context-strategy="contextStrategy"
      :default-model="defaultModel"
      :disabled="workspaceBusy || Boolean(deletingId)"
      :projects="projects"
      :created-project-id="createdProjectId"
      :project-error="projectError"
      @select="handleSelect"
      @refresh-configurations="loadModelConfigurations"
      @update:model-value="handleModelChange"
      @save-settings="handleSettingsSave"
      @save-configuration="handleSaveModelConfiguration"
      @delete-configuration="handleDeleteModelConfiguration"
      @new-session="handleNewSession"
      @delete-session="handleDelete"
      @create-project="handleCreateProject"
      @rename-project="handleRenameProject"
      @assign-project="handleAssignProject"
    />
    <ChatWorkspace
      :key="session.id"
      :session="session"
      :project-name="currentProject?.name"
      :model-id="modelId"
      :context-limit="contextLimit"
      :pricing="pricing"
      :show-cost="costSettings.enabled"
      :show-detailed-statistics="detailedStatistics"
      :compaction-enabled="compactionEnabled"
      :compaction-threshold="compactionThreshold"
      :context-strategy="contextStrategy"
      :operation-error="operationError"
      :history-clear-pending="historyClearPending"
      :user-profiles="userProfiles"
      :user-profiles-loading="userProfilesLoading"
      :profile-selection-error="profileSelectionError"
      @new-session="handleNewSession"
      @updated="handleUpdated"
      @busy-change="workspaceBusy = $event"
      @dismiss-operation-error="operationError = null"
      @create-branch="handleCreateBranch"
      @save-memory="handleSaveMemory"
      @select-profile="handleSelectProfile"
    />
    <MemoryEntryForm
      :open="memoryFormOpen"
      :layer="memoryFormLayer"
      :project-id="session.projectId"
      :source="memoryFormSource"
      :initial-text="memoryFormText"
      @saved="handleMemorySaved"
      @cancel="memoryFormOpen = false"
    />
  </div>
</template>
