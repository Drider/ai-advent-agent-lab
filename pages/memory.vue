<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import MemoryBudgetSettings from '~/components/MemoryBudgetSettings.vue'
import MemoryClearDialog from '~/components/MemoryClearDialog.vue'
import MemoryEntryForm from '~/components/MemoryEntryForm.vue'
import MemoryRecordList from '~/components/MemoryRecordList.vue'
import MemoryStatistics from '~/components/MemoryStatistics.vue'
import ProjectSelector from '~/components/ProjectSelector.vue'
import { useMemory } from '~/composables/useMemory'
import type { ChatUIMessage, SessionDetail } from '~/shared/chat'
import type { HistoryClearResult, LongTermFact, MemoryBudgets, MemoryPreview, MemoryScope, MemoryStatistics as MemoryStatisticsData, Project, WorkingMemoryEntry } from '~/shared/memory'

type Layer = 'short_term' | 'working' | 'long_term'

const route = useRoute()
const memory = useMemory()
const layer = ref<Layer>(route.query.layer === 'working' || route.query.layer === 'long_term' || route.query.layer === 'short_term' ? route.query.layer : 'working')
const projectId = ref(typeof route.query.projectId === 'string' ? route.query.projectId : undefined)
const sessionId = ref(typeof route.query.sessionId === 'string' ? route.query.sessionId : undefined)
const projects = ref<Project[]>([])
const budgets = ref<MemoryBudgets | null>(null)
const preview = ref<MemoryPreview | null>(null)
const statistics = ref<MemoryStatisticsData | null>(null)
const globalStatistics = ref<MemoryStatisticsData | null>(null)
const session = shallowRef<SessionDetail | null>(null)
const workingItems = ref<WorkingMemoryEntry[]>([])
const longTermItems = ref<LongTermFact[]>([])
const workingCursor = ref<string | undefined>()
const longTermCursor = ref<string | undefined>()
const search = ref('')
const category = ref('')
const loading = ref(false)
const savingBudget = ref(false)
const error = ref<string | null>(null)
const formOpen = ref(false)
const formLayer = ref<'working' | 'long_term'>('working')
const formEntry = ref<WorkingMemoryEntry | LongTermFact | undefined>()
const clearOpen = ref(false)
const clearLayer = ref<Layer>('working')
const pendingClear = ref<HistoryClearResult | undefined>()
const activeClearOperationId = ref<string | undefined>()
const clearing = ref(false)

const activeProject = computed(() => projects.value.find(project => project.id === projectId.value))
const currentScope = computed<MemoryScope>(() => sessionId.value ? { scope: 'dialogue', sessionId: sessionId.value } : projectId.value ? { scope: 'project', projectId: projectId.value } : { scope: 'global' })
const clearCount = computed(() => clearLayer.value === 'working'
  ? statistics.value?.stored.working.entries ?? 0
  : clearLayer.value === 'long_term'
    ? globalStatistics.value?.stored.longTerm.facts ?? 0
    : statistics.value?.stored.shortTerm.messages ?? 0)

function setQuery(next: Partial<{ layer: Layer; projectId?: string; sessionId?: string }>): void {
  const query = {
    layer: next.layer ?? layer.value,
    ...(next.projectId === undefined ? (projectId.value ? { projectId: projectId.value } : {}) : next.projectId ? { projectId: next.projectId } : {}),
    ...(next.sessionId === undefined ? (sessionId.value ? { sessionId: sessionId.value } : {}) : next.sessionId ? { sessionId: next.sessionId } : {}),
  }
  void navigateTo({ path: '/memory', query })
}

async function loadData(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const loadedProjects = await memory.loadProjects()
    projects.value = loadedProjects.items
    if (sessionId.value) {
      session.value = await $fetch<SessionDetail>(`/api/sessions/${sessionId.value}`)
      if (!projectId.value && session.value.projectId) projectId.value = session.value.projectId
      pendingClear.value = (await memory.loadPendingHistoryClear(sessionId.value)) ?? undefined
      if (pendingClear.value) {
        clearLayer.value = 'short_term'
        clearOpen.value = true
      }
    } else {
      session.value = null
      pendingClear.value = undefined
    }
    const [loadedBudgets, loadedPreview, loadedStatistics, loadedGlobalStatistics] = await Promise.all([
      memory.loadBudgets(),
      memory.loadPreview(projectId.value),
      memory.loadStatistics(currentScope.value),
      memory.loadStatistics({ scope: 'global' }),
    ])
    budgets.value = loadedBudgets
    preview.value = loadedPreview
    statistics.value = loadedStatistics
    globalStatistics.value = loadedGlobalStatistics
    const workingPage = projectId.value ? await memory.listWorking(projectId.value, { text: search.value || undefined, category: layer.value === 'working' ? category.value || undefined : undefined }) : { items: [], nextCursor: undefined }
    const longTermPage = await memory.listLongTerm({ projectId: projectId.value, text: search.value || undefined, category: layer.value === 'long_term' ? category.value || undefined : undefined })
    workingItems.value = workingPage.items
    longTermItems.value = longTermPage.items
    workingCursor.value = workingPage.nextCursor
    longTermCursor.value = longTermPage.nextCursor
  } catch (caughtError) {
    error.value = caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить память.'
  } finally {
    loading.value = false
  }
}

async function chooseLayer(next: Layer): Promise<void> {
  layer.value = next
  category.value = ''
  setQuery({ layer: next })
}

async function chooseProject(value: string | undefined): Promise<void> {
  projectId.value = value && value !== 'none' ? value : undefined
  sessionId.value = undefined
  setQuery({ projectId: projectId.value, sessionId: undefined })
  await loadData()
}

async function saveBudget(patch: { workingTokens?: number; longTermTokens?: number; expectedRevision: number }): Promise<void> {
  savingBudget.value = true
  try {
    budgets.value = await memory.updateBudgets(patch)
    await loadData()
  } catch (caughtError) {
    error.value = caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить бюджет.'
  } finally {
    savingBudget.value = false
  }
}

function createEntry(): void {
  formLayer.value = layer.value === 'long_term' ? 'long_term' : 'working'
  formEntry.value = undefined
  formOpen.value = true
}

function editEntry(entry: WorkingMemoryEntry | LongTermFact): void {
  formLayer.value = 'global' in entry ? 'long_term' : 'working'
  formEntry.value = entry
  formOpen.value = true
}

async function toggleEntry(entry: WorkingMemoryEntry | LongTermFact): Promise<void> {
  try {
    if ('global' in entry) await memory.saveLongTerm({ id: entry.id, enabled: !entry.enabled, expectedRevision: entry.revision })
    else await memory.saveWorking({ id: entry.id, enabled: !entry.enabled, expectedRevision: entry.revision })
    await loadData()
  } catch (caughtError) { error.value = caughtError instanceof Error ? caughtError.message : 'Не удалось изменить состояние записи.' }
}

async function deleteEntry(entry: WorkingMemoryEntry | LongTermFact): Promise<void> {
  if (!window.confirm(`Удалить запись «${entry.key}»?`)) return
  try {
    if ('global' in entry) await memory.deleteLongTerm(entry.id)
    else await memory.deleteWorking(entry.id)
    await loadData()
  } catch (caughtError) { error.value = caughtError instanceof Error ? caughtError.message : 'Не удалось удалить запись.' }
}

function openClear(next: Layer): void {
  clearLayer.value = next
  pendingClear.value = undefined
  activeClearOperationId.value = undefined
  clearOpen.value = true
}

async function confirmClear(): Promise<void> {
  if (clearing.value) return
  clearing.value = true
  try {
    if (clearLayer.value === 'working') {
      if (!projectId.value) return
      await memory.clearWorking(projectId.value)
    } else if (clearLayer.value === 'long_term') {
      await memory.clearLongTerm()
    } else {
      if (!sessionId.value) return
      const operationId = pendingClear.value?.operationId ?? activeClearOperationId.value ?? crypto.randomUUID()
      activeClearOperationId.value = operationId
      const result = await memory.clearHistory(sessionId.value, operationId)
      if (result.status !== 'completed') { pendingClear.value = result; return }
      pendingClear.value = undefined
      activeClearOperationId.value = undefined
    }
    clearOpen.value = false
    await loadData()
  } catch (caughtError) { error.value = caughtError instanceof Error ? caughtError.message : 'Не удалось очистить слой памяти.' }
  finally { clearing.value = false }
}

async function detachProject(): Promise<void> {
  if (!projectId.value || !window.confirm('Отключить все долговременные факты от этого проекта?')) return
  try { await memory.detachProject(projectId.value); await loadData() } catch (caughtError) { error.value = caughtError instanceof Error ? caughtError.message : 'Не удалось отключить проект.' }
}

function handleSaved(): void {
  formOpen.value = false
  void loadData()
}

function loadMore(): void {
  void (async () => {
    if (layer.value === 'working' && projectId.value && workingCursor.value) {
      const page = await memory.listWorking(projectId.value, { cursor: workingCursor.value, text: search.value || undefined, category: layer.value === 'working' ? category.value || undefined : undefined })
      workingItems.value = [...workingItems.value, ...page.items]
      workingCursor.value = page.nextCursor
    } else if (layer.value === 'long_term' && longTermCursor.value) {
      const page = await memory.listLongTerm({ cursor: longTermCursor.value, projectId: projectId.value, text: search.value || undefined, category: layer.value === 'long_term' ? category.value || undefined : undefined })
      longTermItems.value = [...longTermItems.value, ...page.items]
      longTermCursor.value = page.nextCursor
    }
  })()
}

watch([search, category], () => { void loadData() })
watch(layer, () => { category.value = '' })
watch(() => route.query, () => {
  layer.value = route.query.layer === 'working' || route.query.layer === 'long_term' || route.query.layer === 'short_term' ? route.query.layer : layer.value
  projectId.value = typeof route.query.projectId === 'string' ? route.query.projectId : undefined
  sessionId.value = typeof route.query.sessionId === 'string' ? route.query.sessionId : undefined
  void loadData()
})
onMounted(() => { void loadData() })
</script>

<template>
  <main class="memory-page">
    <header class="memory-page__header">
      <div><p class="memory-eyebrow">Agent memory</p><h1>Память агента</h1><p>Три независимых слоя: текущий диалог, задача проекта и подтверждённые факты.</p></div>
      <div class="memory-page__header-actions"><NuxtLink class="memory-button" to="/">К чатам</NuxtLink><button class="memory-button memory-button--primary" type="button" @click="createEntry">Новая запись</button></div>
    </header>
    <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
    <div class="memory-page__layout">
      <aside class="memory-page__sidebar">
        <ProjectSelector :projects="projects" :model-value="projectId" @update:model-value="chooseProject" @create="async name => { const project = await $fetch<Project>('/api/projects', { method: 'POST', body: { name } }); projects = [...projects, project]; await chooseProject(project.id) }" />
        <nav class="memory-tabs" aria-label="Слои памяти">
          <button :class="{ active: layer === 'short_term' }" type="button" @click="chooseLayer('short_term')">Краткосрочная</button>
          <button :class="{ active: layer === 'working' }" type="button" @click="chooseLayer('working')">Рабочая</button>
          <button :class="{ active: layer === 'long_term' }" type="button" @click="chooseLayer('long_term')">Долговременная</button>
        </nav>
        <div class="memory-page__filters"><input v-model="search" type="search" placeholder="Поиск по ключу и значению"><select v-model="category"><option value="">Все категории</option><option v-if="layer === 'working'" value="goal">Цель</option><option v-if="layer === 'working'" value="constraint">Ограничение</option><option v-if="layer === 'working'" value="state">Состояние</option><option v-if="layer === 'working'" value="result">Результат</option><option v-if="layer === 'working'" value="note">Заметка</option><option v-if="layer === 'long_term'" value="profile">Профиль</option><option v-if="layer === 'long_term'" value="decision">Решение</option><option v-if="layer === 'long_term'" value="knowledge">Знание</option></select></div>
      </aside>
      <section class="memory-page__content">
        <MemoryBudgetSettings v-if="budgets && preview" :budgets="budgets" :preview="preview" :saving="savingBudget" @save="saveBudget" />
        <MemoryStatistics v-if="statistics" :statistics="statistics" :preview="preview ?? undefined" />
        <section v-if="layer === 'short_term'" class="memory-card">
          <div class="memory-card__heading"><div><p class="memory-eyebrow">{{ session?.title ?? 'Диалог' }}</p><h2>История диалога</h2></div><button class="memory-button memory-button--danger" type="button" :disabled="!session" @click="openClear('short_term')">Очистить историю</button></div>
          <div v-if="session?.messages.length" class="memory-short-term-list"><article v-for="message in session.messages" :key="message.id"><span>{{ message.role }}</span><p>{{ message.parts.filter((part): part is Extract<ChatUIMessage['parts'][number], { type: 'text' }> => part.type === 'text').map(part => part.text).join('') }}</p></article></div>
          <p v-else class="memory-empty">Выберите диалог через ссылку из чата, чтобы просмотреть его историю.</p>
          <p class="memory-muted">Сводки и Sticky Facts создаются автоматически и не редактируются как подтверждённые факты.</p>
        </section>
        <MemoryRecordList v-else :layer="layer === 'working' ? 'working' : 'long_term'" :items="layer === 'working' ? workingItems : longTermItems" :loading="loading" :error="error" :has-more="layer === 'working' ? Boolean(workingCursor) : Boolean(longTermCursor)" @edit="editEntry" @delete="deleteEntry" @toggle="toggleEntry" @load-more="loadMore" />
        <div v-if="layer === 'long_term' && projectId" class="memory-page__footer-actions"><button class="memory-button" type="button" @click="detachProject">Отключить факты от проекта</button></div>
        <div v-else-if="layer === 'long_term'" class="memory-page__footer-actions"><button class="memory-button memory-button--danger" type="button" @click="openClear('long_term')">Очистить долговременный слой</button></div>
        <div v-else-if="layer === 'working' && projectId" class="memory-page__footer-actions"><button class="memory-button memory-button--danger" type="button" @click="openClear('working')">Очистить рабочий слой проекта</button></div>
      </section>
    </div>
    <MemoryEntryForm :open="formOpen" :layer="formLayer" :project-id="projectId" :entry="formEntry" @saved="handleSaved" @cancel="formOpen = false" />
    <MemoryClearDialog :open="clearOpen" :layer="clearLayer" :scope-label="clearLayer === 'working' ? (activeProject?.name ?? 'Проект') : clearLayer === 'short_term' ? (session?.title ?? 'Диалог') : 'Все долговременные факты'" :affected-count="clearCount" :pending="pendingClear" @confirm="confirmClear" @retry="confirmClear" @cancel="clearOpen = false" />
  </main>
</template>

<style scoped>
.memory-page { min-height: 100dvh; padding: clamp(1rem, 3vw, 2.5rem); color: #172033; background: #f8fafc; }
.memory-page__header { display: flex; justify-content: space-between; gap: 1.5rem; max-width: 90rem; margin: 0 auto 1.25rem; }
.memory-page__header h1 { margin: 0; font-size: clamp(1.5rem, 3vw, 2.2rem); }
.memory-page__header p:last-child { max-width: 46rem; margin: .45rem 0 0; color: #64748b; font-size: .86rem; line-height: 1.5; }
.memory-page__header-actions { display: flex; align-items: flex-start; gap: .5rem; }
.memory-page__layout { display: grid; grid-template-columns: 18rem minmax(0, 1fr); gap: 1rem; max-width: 90rem; margin: 0 auto; }
.memory-page__sidebar { display: grid; align-content: start; gap: 1rem; }
.memory-page__content { display: grid; align-content: start; gap: 1rem; min-width: 0; }
.memory-tabs { display: grid; gap: .3rem; }
.memory-tabs button { border: 1px solid transparent; border-radius: .5rem; padding: .6rem .7rem; color: #64748b; background: transparent; text-align: left; font: inherit; font-size: .8rem; cursor: pointer; }
.memory-tabs button.active, .memory-tabs button:hover { border-color: #dbe4ef; color: #1e293b; background: #fff; }
.memory-page__filters { display: grid; gap: .45rem; }
.memory-page__filters input, .memory-page__filters select { width: 100%; border: 1px solid #cbd5e1; border-radius: .45rem; padding: .5rem .55rem; color: #334155; background: #fff; font: inherit; font-size: .76rem; }
.memory-card { border: 1px solid #dbe4ef; border-radius: .8rem; padding: 1rem; background: #fff; box-shadow: 0 2px 10px rgb(15 23 42 / 3%); }
.memory-card__heading { display: flex; align-items: flex-start; justify-content: space-between; gap: .8rem; margin-bottom: .8rem; }
.memory-card__heading h2 { margin: 0; font-size: 1rem; }
.memory-eyebrow { margin: 0 0 .2rem; color: #64748b; font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; }
.memory-muted, .memory-empty { color: #64748b; font-size: .75rem; line-height: 1.45; }
.memory-error { color: #b42318; font-size: .78rem; line-height: 1.4; }
.memory-button { display: inline-flex; align-items: center; border: 1px solid #cbd5e1; border-radius: .45rem; padding: .5rem .7rem; color: #475569; background: #fff; font: inherit; font-size: .75rem; text-decoration: none; cursor: pointer; }
.memory-button--primary { border-color: #1e293b; color: #fff; background: #1e293b; }
.memory-button--danger { border-color: #fecaca; color: #b91c1c; background: #fff; }
.memory-page__footer-actions { display: flex; flex-wrap: wrap; gap: .5rem; justify-content: flex-end; }
.memory-short-term-list { display: grid; gap: .5rem; }
.memory-short-term-list article { border-bottom: 1px solid #f1f5f9; padding: .55rem 0; }
.memory-short-term-list span { color: #64748b; font-size: .68rem; text-transform: uppercase; }
.memory-short-term-list p { margin: .25rem 0 0; color: #334155; font-size: .8rem; line-height: 1.5; white-space: pre-wrap; }
@media (max-width: 760px) { .memory-page__header { flex-direction: column; } .memory-page__layout { grid-template-columns: 1fr; } .memory-page__sidebar { order: -1; } }
</style>
