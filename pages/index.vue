<script setup lang="ts">
import { onMounted, shallowRef } from 'vue'
import { selectInitialSession } from '~/shared/session-navigation'
import type { SessionSummary } from '~/shared/chat'

const loading = shallowRef(true)
const error = shallowRef<string | null>(null)

interface SessionListResponse {
  items: SessionSummary[]
  preferredSessionId?: string
}

async function openInitialSession(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const result = await $fetch<SessionListResponse>('/api/sessions')
    const sessionId = selectInitialSession(result)
    if (sessionId) {
      await navigateTo(`/chat/${sessionId}`, { replace: true })
      return
    }

    const created = await $fetch<SessionSummary>('/api/sessions', { method: 'POST' })
    await navigateTo(`/chat/${created.id}`, { replace: true })
  } catch (caughtError) {
    error.value = caughtError instanceof Error ? caughtError.message : 'Не удалось открыть историю чатов'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void openInitialSession()
})
</script>

<template>
  <main class="route-state">
    <UIcon v-if="loading" name="i-lucide-loader-circle" class="route-state__spinner" aria-hidden="true" />
    <template v-else>
      <UIcon name="i-lucide-circle-alert" class="route-state__icon" />
      <h1>Не удалось открыть чат</h1>
      <p>{{ error }}</p>
      <UButton color="neutral" @click="openInitialSession">Повторить</UButton>
    </template>
  </main>
</template>
