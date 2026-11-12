<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import ChatSessionList from '~/components/ChatSessionList.vue'
import ChatWorkspace from '~/components/ChatWorkspace.vue'
import { pricingFromSettings, validateModelId, type ChatCostSettings, type SessionDetail, type SessionSummary } from '~/shared/chat'
import { selectInitialSession } from '~/shared/session-navigation'

interface SessionListResponse {
  items: SessionSummary[]
  nextCursor?: string
  preferredSessionId?: string
}

const route = useRoute()
const config = useRuntimeConfig()
const defaultModel = config.public.chatDefaultModel
const modelId = shallowRef(defaultModel)
const costSettings = shallowRef<ChatCostSettings>({ enabled: false, inputPrice: '', outputPrice: '' })
const detailedStatistics = shallowRef(false)
const contextLimits = shallowRef<Record<string, string>>({})
const contextLimit = computed({
  get: () => contextLimits.value[modelId.value] ?? '',
  set: (value: string) => {
    contextLimits.value = { ...contextLimits.value, [modelId.value]: value }
  },
})
const pricing = computed(() => pricingFromSettings(costSettings.value))
const session = shallowRef<SessionDetail | null>(null)
const sessions = shallowRef<SessionSummary[]>([])
const nextCursor = shallowRef<string | undefined>()
const loading = shallowRef(true)
const listLoading = shallowRef(true)
const workspaceBusy = shallowRef(false)
const error = shallowRef<string | null>(null)
const listError = shallowRef<string | null>(null)
const operationError = shallowRef<string | null>(null)
const modelSaveError = shallowRef<string | null>(null)
const deleteError = shallowRef<string | null>(null)
const deletingId = shallowRef<string | null>(null)
let modelSave = Promise.resolve()

const sessionId = computed(() => String(route.params.id))
const visibleSessions = computed(() => {
  if (!session.value || sessions.value.some(item => item.id === session.value!.id)) return sessions.value
  return [session.value, ...sessions.value]
})

async function loadSession(): Promise<void> {
  const requestedId = sessionId.value
  loading.value = true
  error.value = null
  modelSaveError.value = null
  try {
    const loadedSession = await $fetch<SessionDetail>(`/api/sessions/${requestedId}`)
    if (sessionId.value !== requestedId) return
    session.value = loadedSession
    modelId.value = loadedSession.modelId ?? loadedSession.lastTurn?.modelId ?? defaultModel
  } catch (caughtError) {
    if (sessionId.value !== requestedId) return
    session.value = null
    error.value = caughtError instanceof Error ? caughtError.message : 'Сессия не найдена'
  } finally {
    if (sessionId.value === requestedId) loading.value = false
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

async function loadSessions(append = false): Promise<SessionListResponse | null> {
  listLoading.value = true
  listError.value = null
  try {
    const query = append && nextCursor.value ? { cursor: nextCursor.value } : undefined
    const result = await $fetch<SessionListResponse>('/api/sessions', { query })
    sessions.value = append ? [...sessions.value, ...result.items] : result.items
    nextCursor.value = result.nextCursor
    return result
  } catch {
    listError.value = append ? 'Не удалось загрузить следующую страницу диалогов.' : 'Не удалось загрузить список диалогов.'
    return null
  } finally {
    listLoading.value = false
  }
}

async function handleNewSession(): Promise<void> {
  if (workspaceBusy.value || deletingId.value) return
  operationError.value = null
  let created = false
  try {
    await modelSave
    const newSession = await $fetch<SessionSummary>('/api/sessions', { method: 'POST' })
    created = true
    await navigateTo(`/chat/${newSession.id}`)
  } catch {
    operationError.value = created ? 'Диалог создан, но не удалось его открыть.' : 'Не удалось создать новый диалог.'
  }
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

async function handleDelete(sessionToDelete: string): Promise<void> {
  if (workspaceBusy.value || deletingId.value) return
  const item = visibleSessions.value.find(session => session.id === sessionToDelete)
  if (!item || !window.confirm(`Удалить диалог «${item.title}» и всю его историю? Логи сохранятся.`)) return

  deletingId.value = sessionToDelete
  deleteError.value = null
  let deleted = false
  try {
    if (sessionToDelete === sessionId.value) await modelSave
    await $fetch(`/api/sessions/${sessionToDelete}`, { method: 'DELETE' })
    deleted = true
    sessions.value = sessions.value.filter(session => session.id !== sessionToDelete)
    const remaining = await loadSessions()
    if (!remaining) throw new Error('Не удалось обновить список диалогов')
    if (sessionToDelete === sessionId.value) {
      const nextId = selectInitialSession(remaining)
      await navigateTo(nextId ? `/chat/${nextId}` : '/', { replace: true })
    }
  } catch {
    if (deleted && sessionToDelete === sessionId.value) {
      try {
        await navigateTo('/', { replace: true })
      } catch {
        deleteError.value = 'Диалог удалён, но не удалось открыть историю.'
      }
    } else {
      deleteError.value = deleted
        ? 'Диалог удалён, но список не обновился.'
        : 'Не удалось удалить диалог. Попробуйте ещё раз.'
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
    loadSessions(),
  ])
}

onMounted(async () => {
  try {
    const saved = JSON.parse(localStorage.getItem('agent-chat-context-limits-v1') ?? '{}') as unknown
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      contextLimits.value = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    }
  } catch {
    operationError.value ??= 'Не удалось прочитать локальные настройки. Проверьте настройки браузера.'
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
  await Promise.all([loadSession(), loadSessions()])
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
      :items="visibleSessions"
      :selected-id="session.id"
      :model-value="modelId"
      v-model:context-limit="contextLimit"
      :model-save-error="modelSaveError"
      :list-error="listError"
      :delete-error="deleteError"
      :deleting-id="deletingId"
      v-model:cost-settings="costSettings"
      v-model:detailed-statistics="detailedStatistics"
      :default-model="defaultModel"
      :loading="listLoading"
      :disabled="workspaceBusy || Boolean(deletingId)"
      :has-more="Boolean(nextCursor)"
      @select="handleSelect"
      @update:model-value="handleModelChange"
      @new-session="handleNewSession"
      @delete-session="handleDelete"
      @load-more="loadSessions(true)"
    />
    <ChatWorkspace
      :key="session.id"
      :session="session"
      :model-id="modelId"
      :context-limit="contextLimit"
      :pricing="pricing"
      :show-cost="costSettings.enabled"
      :show-detailed-statistics="detailedStatistics"
      :operation-error="operationError"
      @new-session="handleNewSession"
      @updated="handleUpdated"
      @busy-change="workspaceBusy = $event"
      @dismiss-operation-error="operationError = null"
    />
  </div>
</template>
