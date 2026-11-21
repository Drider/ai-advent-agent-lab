<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import UserProfileEditor from '~/components/UserProfileEditor.vue'
import UserProfileList from '~/components/UserProfileList.vue'
import type { UserProfile, UserProfileSummary } from '~/shared/user-profile'
import { useWorkflows } from '~/composables/useWorkflows'

interface ProfileListResponse {
  items: UserProfileSummary[]
  defaultProfileId: string
}

const route = useRoute()
const workflows = useWorkflows()
const profiles = shallowRef<UserProfileSummary[]>([])
const defaultProfileId = shallowRef('')
const selectedProfile = shallowRef<UserProfile | null>(null)
const selectedId = shallowRef<string | null>(null)
const loading = shallowRef(true)
const saving = shallowRef(false)
const settingDefault = shallowRef(false)
const pageError = shallowRef<string | null>(null)
const saveError = shallowRef<string | null>(null)
const conflictProfile = shallowRef<UserProfile | null>(null)
const dirty = shallowRef(false)
const resetKey = shallowRef(0)

const returnToChat = computed(() => typeof route.query.sessionId === 'string' ? `/chat/${route.query.sessionId}` : '/')
const returnLabel = computed(() => typeof route.query.sessionId === 'string' ? 'Вернуться в диалог' : 'К списку диалогов')

function confirmDiscard(): boolean {
  return !dirty.value || window.confirm('Есть несохранённые изменения. Отбросить черновик?')
}

async function loadProfile(id: string): Promise<void> {
  selectedProfile.value = await $fetch<UserProfile>(`/api/user-profiles/${id}`)
  selectedId.value = id
  saveError.value = null
  conflictProfile.value = null
  resetKey.value += 1
}

async function loadData(): Promise<void> {
  loading.value = true
  pageError.value = null
  try {
    const result = await $fetch<ProfileListResponse>('/api/user-profiles')
    profiles.value = result.items
    defaultProfileId.value = result.defaultProfileId
    const requestedId = typeof route.query.profileId === 'string' ? route.query.profileId : result.defaultProfileId
    const available = result.items.some(profile => profile.id === requestedId)
      ? requestedId
      : result.items[0]?.id
    if (available) await loadProfile(available)
    else {
      selectedProfile.value = null
      selectedId.value = null
    }
  } catch (caughtError) {
    pageError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить профили.'
  } finally {
    loading.value = false
  }
}

async function chooseProfile(id: string): Promise<void> {
  if (id === selectedId.value || !confirmDiscard()) return
  try {
    await loadProfile(id)
    await navigateTo({ path: '/profiles', query: { ...route.query, profileId: id } }, { replace: true })
  } catch (caughtError) {
    saveError.value = caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить профиль.'
  }
}

function beginCreate(): void {
  if (!confirmDiscard()) return
  selectedProfile.value = null
  selectedId.value = null
  saveError.value = null
  conflictProfile.value = null
  resetKey.value += 1
}

async function createProfile(payload: { name: string; instructions: string }): Promise<void> {
  saving.value = true
  saveError.value = null
  try {
    const profile = await $fetch<UserProfile>('/api/user-profiles', { method: 'POST', body: payload })
    profiles.value = [...profiles.value, profile]
    selectedProfile.value = profile
    selectedId.value = profile.id
    dirty.value = false
    resetKey.value += 1
    await navigateTo({ path: '/profiles', query: { ...route.query, profileId: profile.id } }, { replace: true })
  } catch (caughtError) {
    saveError.value = getRequestMessage(caughtError, 'Не удалось создать профиль.')
  } finally {
    saving.value = false
  }
}

async function updateProfile(payload: { id: string; expectedRevision: number; name?: string; instructions?: string }): Promise<void> {
  saving.value = true
  saveError.value = null
  conflictProfile.value = null
  try {
    const { id, ...patch } = payload
    const profile = await $fetch<UserProfile>(`/api/user-profiles/${id}`, { method: 'PATCH', body: patch })
    selectedProfile.value = profile
    profiles.value = profiles.value.map(item => item.id === profile.id ? toSummary(profile) : item)
    dirty.value = false
    resetKey.value += 1
  } catch (caughtError) {
    saveError.value = getRequestMessage(caughtError, 'Не удалось сохранить профиль.')
    if (getErrorCode(caughtError) === 'REVISION_CONFLICT') {
      try {
        conflictProfile.value = await $fetch<UserProfile>(`/api/user-profiles/${payload.id}`)
      } catch {
        // Keep the local draft and let the user retry the version check.
      }
    }
  } finally {
    saving.value = false
  }
}

async function setDefault(id: string): Promise<void> {
  settingDefault.value = true
  saveError.value = null
  try {
    const profile = await $fetch<UserProfile>('/api/user-profiles/default', { method: 'PATCH', body: { profileId: id } })
    defaultProfileId.value = profile.id
  } catch (caughtError) {
    saveError.value = getRequestMessage(caughtError, 'Не удалось назначить профиль по умолчанию.')
  } finally {
    settingDefault.value = false
  }
}

function useLatestVersion(): void {
  const latest = conflictProfile.value
  if (!latest) return
  selectedProfile.value = latest
  profiles.value = profiles.value.map(item => item.id === latest.id ? toSummary(latest) : item)
  conflictProfile.value = null
  saveError.value = null
  dirty.value = false
  resetKey.value += 1
}

async function saveWorkflow(id: string, expectedRevision: number, workflowId: string | null) {
  saving.value = true
  saveError.value = null
  try {
    const profile = await $fetch<UserProfile>('/api/user-profiles/' + id + '/workflow', { method: 'PATCH', body: { expectedRevision, workflowId } })
    if (selectedId.value === id) selectedProfile.value = profile
    profiles.value = profiles.value.map(item => item.id === id ? toSummary(profile) : item)
  } catch (e) {
    saveError.value = getRequestMessage(e, 'Не удалось сохранить выбор workflow.')
    if (getErrorCode(e) === 'REVISION_CONFLICT') {
      try { conflictProfile.value = await $fetch<UserProfile>('/api/user-profiles/' + id) } catch { /* Keep the draft. */ }
    }
  } finally { saving.value = false }
}

function getRequestMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'data' in error && typeof error.data === 'object' && error.data !== null && 'statusMessage' in error.data && typeof error.data.statusMessage === 'string') return error.data.statusMessage
  return error instanceof Error ? error.message : fallback
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error) || typeof error.data !== 'object' || error.data === null) return undefined
  if ('data' in error.data) {
    const nested = error.data.data
    if (typeof nested === 'object' && nested !== null && 'code' in nested && typeof nested.code === 'string') return nested.code
  }
  if ('code' in error.data && typeof error.data.code === 'string') return error.data.code
  return undefined
}

function toSummary(profile: UserProfile): UserProfileSummary {
  const { instructions: _instructions, ...summary } = profile
  return summary
}

onBeforeRouteLeave(() => confirmDiscard())
onMounted(() => { void loadData(); void workflows.load() })
</script>

<template>
  <main class="profiles-page">
    <header class="profiles-page__header">
      <div>
        <p class="profiles-page__eyebrow">Персонализация агента</p>
        <h1>Профили пользователя</h1>
        <p class="profiles-page__intro">Задайте предпочтения по стилю, формату и ограничениям. Профиль независим от памяти и назначается каждому диалогу отдельно.</p>
      </div>
      <UButton color="neutral" variant="soft" icon="i-lucide-arrow-left" :to="returnToChat">{{ returnLabel }}</UButton>
    </header>

    <p v-if="pageError" class="profiles-page__error" role="alert">{{ pageError }}</p>
    <p v-if="workflows.error.value" role="alert">{{ workflows.error.value }}</p>
    <div v-if="loading" class="profiles-page__loading" role="status"><UIcon name="i-lucide-loader-circle" /> Загружаем профили…</div>
    <div v-else class="profiles-page__layout">
      <UserProfileList
        :items="profiles"
        :selected-id="selectedId"
        :default-profile-id="defaultProfileId"
        :disabled="saving || settingDefault"
        @select="chooseProfile"
        @create="beginCreate"
      />
      <UserProfileEditor
        :workflows="workflows.items.value"
        @save-workflow="saveWorkflow"
        :profile="selectedProfile"
        :default-profile-id="defaultProfileId"
        :saving="saving"
        :setting-default="settingDefault"
        :save-error="saveError"
        :conflict-profile="conflictProfile"
        :reset-key="resetKey"
        @save="updateProfile"
        @create="createProfile"
        @set-default="setDefault"
        @reload-latest="useLatestVersion"
        @dirty-change="dirty = $event"
      />
    </div>
  </main>
</template>

<style scoped>
.profiles-page { width: min(100%, 74rem); margin: 0 auto; padding: clamp(1rem, 4vw, 2.5rem); color: #0f172a; }
.profiles-page__header { display: flex; justify-content: space-between; align-items: start; gap: 1.5rem; margin-bottom: 1.5rem; }
.profiles-page__header h1 { margin: 0; font-size: clamp(1.5rem, 3vw, 2rem); letter-spacing: -.03em; }
.profiles-page__eyebrow { margin: 0 0 .4rem; color: #64748b; font-size: .72rem; font-weight: 650; text-transform: uppercase; letter-spacing: .08em; }
.profiles-page__intro { max-width: 44rem; margin: .55rem 0 0; color: #64748b; font-size: .88rem; line-height: 1.6; }
.profiles-page__layout { display: grid; grid-template-columns: minmax(12rem, .32fr) minmax(0, 1fr); align-items: start; gap: 1.25rem; }
.profiles-page__loading { display: flex; align-items: center; gap: .5rem; color: #64748b; }
.profiles-page__error { border-radius: .65rem; padding: .75rem; color: #b91c1c; background: #fef2f2; font-size: .82rem; }
@media (max-width: 48rem) {
  .profiles-page__header { flex-direction: column; }
  .profiles-page__layout { grid-template-columns: 1fr; }
}
</style>
