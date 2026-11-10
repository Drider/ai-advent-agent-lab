<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import ChatSessionList from '~/components/ChatSessionList.vue'
import ChatWorkspace from '~/components/ChatWorkspace.vue'
import type { SessionDetail, SessionSummary } from '~/shared/chat'

interface SessionListResponse {
  items: SessionSummary[]
  nextCursor?: string
  preferredSessionId?: string
}

const route = useRoute()
const config = useRuntimeConfig()
const defaultModel = config.public.chatDefaultModel
const modelId = shallowRef(defaultModel)
const session = shallowRef<SessionDetail | null>(null)
const sessions = shallowRef<SessionSummary[]>([])
const nextCursor = shallowRef<string | undefined>()
const loading = shallowRef(true)
const listLoading = shallowRef(true)
const workspaceBusy = shallowRef(false)
const error = shallowRef<string | null>(null)

const sessionId = computed(() => String(route.params.id))
const visibleSessions = computed(() => {
  if (!session.value || sessions.value.some(item => item.id === session.value!.id)) return sessions.value
  return [session.value, ...sessions.value]
})

async function loadSession(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const loadedSession = await $fetch<SessionDetail>(`/api/sessions/${sessionId.value}`)
    session.value = loadedSession
    modelId.value = loadedSession.lastTurn?.modelId ?? defaultModel
  } catch (caughtError) {
    session.value = null
    error.value = caughtError instanceof Error ? caughtError.message : 'Сессия не найдена'
  } finally {
    loading.value = false
  }
}

async function loadSessions(append = false): Promise<void> {
  listLoading.value = true
  try {
    const query = append && nextCursor.value ? { cursor: nextCursor.value } : undefined
    const result = await $fetch<SessionListResponse>('/api/sessions', { query })
    sessions.value = append ? [...sessions.value, ...result.items] : result.items
    nextCursor.value = result.nextCursor
  } finally {
    listLoading.value = false
  }
}

async function handleNewSession(): Promise<void> {
  if (workspaceBusy.value) return
  const created = await $fetch<SessionSummary>('/api/sessions', { method: 'POST' })
  await navigateTo(`/chat/${created.id}`)
}

async function handleSelect(selectedId: string): Promise<void> {
  if (workspaceBusy.value || selectedId === sessionId.value) return
  await navigateTo(`/chat/${selectedId}`)
}

async function handleUpdated(): Promise<void> {
  await loadSessions()
}

onMounted(async () => {
  await Promise.all([loadSession(), loadSessions()])
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
      v-model:model-value="modelId"
      :default-model="defaultModel"
      :loading="listLoading"
      :disabled="workspaceBusy"
      :has-more="Boolean(nextCursor)"
      @select="handleSelect"
      @new-session="handleNewSession"
      @load-more="loadSessions(true)"
    />
    <ChatWorkspace
      :key="session.id"
      :session="session"
      :model-id="modelId"
      @new-session="handleNewSession"
      @updated="handleUpdated"
      @busy-change="workspaceBusy = $event"
    />
  </div>
</template>
