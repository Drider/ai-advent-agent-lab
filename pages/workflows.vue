<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useWorkflows } from '../composables/useWorkflows'
import { useTasks } from '../composables/useTasks'
import type { WorkflowSummary, WorkflowVersion } from '../shared/workflow'
const route = useRoute()
const sessionId = computed(() => typeof route.query.sessionId === 'string' ? route.query.sessionId : '')
const library = useWorkflows()
const tasks = useTasks(sessionId)
const selected = shallowRef<{ workflow: WorkflowSummary; version: WorkflowVersion }>()
const editorBusy = ref(false)
const loading = ref(false)
const info = ref('')
let sequence = 0
async function open(id?: string) {
  const request = ++sequence
  info.value = ''
  if (!id) {
    selected.value = undefined
    loading.value = false
    return
  }
  loading.value = true
  try {
    const result = await library.read(id)
    if (request === sequence) selected.value = result
  } catch (e) {
    if (request === sequence) info.value = e instanceof Error ? e.message : 'Не удалось открыть workflow.'
  } finally {
    if (request === sequence) loading.value = false
  }
}
async function published(version: WorkflowVersion) {
  await library.load()
  await open(version.workflowId)
  info.value = 'Опубликована версия ' + version.version
}
const canAttach = computed(() => {
  const view = tasks.view.value
  return view && (!view.task || ['done', 'cancelled'].includes(view.task.status) || view.actions.some(a => a.type === 'attach'))
})
async function attach() {
  const data = selected.value
  if (!data) return
  try {
    const { result } = await tasks.submitCommand('/task attach ' + data.workflow.id + ' ' + data.version.version)
    if (result?.ok) info.value = 'Workflow подключён к задаче.'
  } catch (e) { info.value = e instanceof Error ? e.message : 'Не удалось подключить workflow.' }
}
async function retryAttach() {
  try {
    if ((await tasks.retry()).ok) info.value = 'Workflow подключён к задаче.'
  } catch (e) { info.value = e instanceof Error ? e.message : 'Не удалось подключить workflow.' }
}
onMounted(() => { void library.load(); if (sessionId.value) void tasks.refresh() })
watch(sessionId, id => { info.value = ''; if (id) void tasks.refresh() })
</script>
<template>
  <main class="workflow-library">
    <header><h1>Библиотека workflow</h1>
      <UButton color="neutral" variant="soft" :to="sessionId ? '/chat/' + sessionId : '/'">{{ sessionId ? 'Вернуться в диалог' : 'К диалогам' }}</UButton>
    </header>
    <div class="columns">
      <nav aria-label="Процессы"><UButton variant="soft" :disabled="editorBusy" @click="open()">Новый workflow</UButton>
        <button v-for="item in library.items.value" :key="item.id" :aria-current="selected?.workflow.id === item.id ? 'true' : undefined" :disabled="editorBusy" @click="open(item.id)">{{ item.name }} <small>v{{ item.latestVersion }}</small></button>
      </nav>
      <section>
        <p v-if="loading" role="status">Загрузка схемы…</p>
        <WorkflowEditor v-else :key="selected ? selected.workflow.id + '/' + selected.version.version : 'new'" :workflow="selected?.workflow" :version="selected?.version" @published="published" @busy-change="editorBusy = $event" />
        <UButton v-if="selected && sessionId && canAttach" :disabled="loading || tasks.busy.value || !!tasks.pending.value" @click="attach()">Подключить v{{ selected.version.version }} к текущей задаче</UButton>
        <UButton v-if="tasks.pending.value" :disabled="tasks.busy.value" @click="retryAttach">Повторить подключение</UButton>
      </section>
    </div>
    <p v-if="info" role="status">{{ info }}</p>
    <p v-if="library.error.value || tasks.error.value" role="alert">{{ library.error.value || tasks.error.value }}</p>
  </main>
</template>
<style scoped>
.workflow-library { margin: auto; max-width: 72rem; padding: 1.5rem; } header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem; }
h1 { font-size: 1.5rem; font-weight: 650; } .columns { display: grid; grid-template-columns: minmax(10rem, .32fr) minmax(0, 1fr); gap: 1.5rem; }
nav { display: grid; gap: .3rem; align-content: start; } nav button { text-align: left; padding: .45rem; border-radius: .4rem; cursor: pointer; }
nav [aria-current=true] { background: var(--ui-bg-muted); } section > button { margin-top: .6rem; }
@media (max-width: 44rem) { .columns { grid-template-columns: 1fr; } }
</style>
