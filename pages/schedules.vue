<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef } from 'vue'
import ScheduleJobCard from '~/components/schedules/ScheduleJobCard.vue'
import type { ScheduledJobView } from '~/shared/scheduler'

const items = shallowRef<ScheduledJobView[]>([])
const loading = shallowRef(true)
const refreshing = shallowRef(false)
const error = shallowRef<string | null>(null)
const deleteError = shallowRef<string | null>(null)
const deletingId = shallowRef<string | null>(null)
const deletedIds = new Set<string>()
let refreshTimer: ReturnType<typeof setInterval> | undefined
let hasLoaded = false
let requestPending = false

async function load(): Promise<void> {
  if (requestPending) return
  requestPending = true
  if (hasLoaded) refreshing.value = true
  else loading.value = true

  try {
    const result = await $fetch<{ items: ScheduledJobView[] }>('/api/schedules')
    items.value = result.items.filter(item => !deletedIds.has(item.id))
    error.value = null
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Не удалось загрузить задания'
  } finally {
    requestPending = false
    hasLoaded = true
    loading.value = false
    refreshing.value = false
  }
}

async function deleteJob(item: ScheduledJobView): Promise<void> {
  if (deletingId.value) return
  const confirmed = window.confirm(`Удалить задание «${item.name}» вместе с историей запусков и отчётами?`)
  if (!confirmed) return

  deletingId.value = item.id
  deleteError.value = null
  try {
    await $fetch(`/api/schedules/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
    deletedIds.add(item.id)
    items.value = items.value.filter(existing => existing.id !== item.id)
  } catch (caught) {
    const statusCode = typeof caught === 'object' && caught !== null && 'statusCode' in caught
      ? caught.statusCode
      : undefined
    if (statusCode === 409) {
      deleteError.value = 'Сейчас выполняется сбор данных или формирование отчёта. Дождитесь завершения и повторите удаление.'
    } else {
      deleteError.value = caught instanceof Error ? caught.message : 'Не удалось удалить задание.'
    }
  } finally {
    deletingId.value = null
  }
}

onMounted(() => {
  void load()
  refreshTimer = setInterval(() => { void load() }, 15_000)
})

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <main class="schedules-page">
    <header class="schedules-page__header">
      <div>
        <p class="schedules-page__eyebrow">Фоновые задания</p>
        <h1>Планировщик</h1>
        <p>Отчёты и результаты запусков, собранные по расписанию.</p>
      </div>
      <div class="schedules-page__header-actions">
        <UButton color="neutral" variant="outline" :loading="refreshing" @click="load">Обновить</UButton>
        <UButton to="/" color="neutral" variant="outline">Открыть чат</UButton>
      </div>
    </header>

    <UIcon v-if="loading" name="i-lucide-loader-circle" class="route-state__spinner" aria-hidden="true" />
    <UAlert v-else-if="error && items.length === 0" color="error" :title="error" />
    <template v-else>
      <UAlert v-if="error" class="schedules-page__refresh-error" color="warning" :title="`Не удалось обновить: ${error}`" />
      <UAlert v-if="deleteError" class="schedules-page__refresh-error" color="error" title="Не удалось удалить задание" :description="deleteError" />
      <div v-if="items.length === 0" class="schedules-page__empty">Заданий пока нет. Создайте его из чата.</div>
      <div v-else class="schedules-page__list">
        <ScheduleJobCard
          v-for="item in items"
          :key="item.id"
          :item="item"
          :deleting="deletingId === item.id"
          :delete-disabled="Boolean(deletingId)"
          @delete="deleteJob"
        />
      </div>
    </template>
  </main>
</template>

<style scoped>
.schedules-page { min-height: 100dvh; padding: clamp(1rem, 3vw, 2.5rem); color: #172033; background: #f8fafc; }
.schedules-page__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; max-width: 72rem; margin: 0 auto 1.3rem; }
.schedules-page__header h1 { margin: 0; font-size: clamp(1.5rem, 3vw, 2rem); letter-spacing: -.025em; }
.schedules-page__header p:last-child { margin: .35rem 0 0; color: #64748b; font-size: .85rem; }
.schedules-page__header-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.schedules-page__eyebrow { margin: 0 0 .25rem; color: #64748b; font-size: .69rem; font-weight: 650; letter-spacing: .075em; text-transform: uppercase; }
.schedules-page__list { display: grid; gap: 1rem; max-width: 72rem; margin: 0 auto; }
.schedules-page__empty { max-width: 72rem; margin: 0 auto; border: 1px dashed #cbd5e1; border-radius: .7rem; padding: 1.5rem; color: #64748b; font-size: .8rem; text-align: center; }
.schedules-page__refresh-error { max-width: 72rem; margin: 0 auto .8rem; }
@media (max-width: 640px) {
  .schedules-page__header { flex-direction: column; }
  .schedules-page__header-actions { width: 100%; }
}
</style>
