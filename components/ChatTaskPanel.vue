<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import type { TaskArtifact, TaskCommand, TaskWorkflowSelection } from '../shared/task'
import type { useTasks } from '../composables/useTasks'
import { useWorkflows } from '../composables/useWorkflows'
const props = defineProps<{ tasks: ReturnType<typeof useTasks>; sessionId: string; disabled: boolean; streaming: boolean }>()
const emit = defineEmits<{ action: [TaskCommand]; retry: []; create: [string, TaskWorkflowSelection] }>()
const { view, history, error, pending, busy } = props.tasks
const library = useWorkflows()
const { items } = library
const selecting = ref(false)
const creating = ref(false)
const goal = ref('')
const selection = ref<'none' | 'profile_default'>('profile_default')
const artifact = shallowRef<TaskArtifact | null>(null)
const artifactError = ref('')
let opening = 0
const unfinished = computed(() => view.value?.task?.status === 'paused' || view.value?.task?.status === 'active')
const locked = computed(() => props.disabled || busy.value || !!pending.value)
async function openArtifact(taskId: string, id: string) {
  const sequence = ++opening
  artifact.value = null
  artifactError.value = ''
  try {
    const data = await props.tasks.artifact(taskId, id)
    if (sequence === opening) artifact.value = data
  } catch (e) {
    if (sequence === opening) artifactError.value = e instanceof Error ? e.message : 'Не удалось открыть материал.'
  }
}
onMounted(() => { void library.load() })
</script>
<template>
  <aside class="task-panel" aria-label="Задача диалога">
    <TaskStateCard v-if="view?.task" :view="view" :busy="locked" :workflow-name="items.find(item => item.id === view?.task?.workflowId)?.name" @action="emit('action', $event)" @choose-workflow="selecting = !selecting" @open-artifact="openArtifact(view!.task!.id, $event)" />
    <div class="panel-links">
      <button v-if="view && !unfinished && !streaming" type="button" :disabled="locked" @click="creating = !creating">Новая задача</button>
      <NuxtLink :to="{ path: '/workflows', query: { sessionId } }">Библиотека workflow</NuxtLink>
    </div>
    <form v-if="creating && !unfinished && !streaming" @submit.prevent="emit('create', goal, selection)">
      <label>Цель <input v-model="goal" maxlength="500" placeholder="Например, подготовить отчёт"></label>
      <select v-model="selection" aria-label="Workflow новой задачи"><option value="profile_default">Как в профиле</option><option value="none">Без workflow</option></select>
      <UButton type="submit" size="xs" :disabled="locked">Создать</UButton>
    </form>
    <WorkflowSelector v-if="selecting && view?.actions.some(action => action.type === 'attach')" :items="items" :busy="locked" @attach="(workflowId, version) => emit('action', { type: 'attach', workflowId, version })" />
    <TaskHistory :items="history.filter(task => task.status === 'done' || task.status === 'cancelled')" @open-artifact="openArtifact" />
    <TaskArtifactViewer v-if="artifact" :artifact="artifact" @close="artifact = null" />
    <p v-if="artifactError || error || library.error.value" role="alert">{{ artifactError || error || library.error.value }}</p>
    <UButton v-if="pending" size="xs" color="neutral" :disabled="busy" @click="emit('retry')">Повторить действие</UButton>
    <button v-else-if="error && !view" type="button" @click="tasks.refresh()">Обновить задачу</button>
  </aside>
</template>
<style scoped>
.task-panel { margin: 0 1.25rem .5rem; padding: .6rem .8rem; display: grid; gap: .45rem; max-height: 34vh; overflow: auto; flex: 0 0 auto; background: var(--ui-bg-muted); border: 1px solid var(--ui-border); border-radius: .65rem; font-size: .8rem; }
.panel-links, form { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; }
.panel-links a,.panel-links button { text-decoration: underline; cursor: pointer; }
form input, form select { background: var(--ui-bg); padding: .3rem; border: 1px solid var(--ui-border); }
[role=alert] { color: var(--ui-error); }
</style>
