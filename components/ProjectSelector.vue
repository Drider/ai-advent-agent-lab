<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Project } from '~/shared/memory'

const props = defineProps<{
  projects: Project[]
  modelValue?: string
  disabled?: boolean
  assignedProjectId?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string | undefined]
  create: [name: string]
  rename: [payload: { id: string; name: string; expectedRevision: number }]
  assignSession: [projectId: string]
}>()

const newName = ref('')
const renameName = ref('')
const selected = computed({
  get: () => props.modelValue ?? '',
  set: value => emit('update:modelValue', value || undefined),
})
const selectedProject = computed(() => props.projects.find(project => project.id === props.modelValue))
const assignedProject = computed(() => props.projects.find(project => project.id === props.assignedProjectId))

function createProject(): void {
  const name = newName.value.trim()
  if (!name) return
  emit('create', name)
  newName.value = ''
}

function renameProject(): void {
  const project = selectedProject.value
  const name = renameName.value.trim()
  if (!project || !name) return
  emit('rename', { id: project.id, name, expectedRevision: project.revision })
  renameName.value = ''
}
</script>

<template>
  <section class="project-selector" aria-label="Проект диалога">
    <div class="project-selector__heading">
      <span class="project-selector__label">Проект</span>
      <NuxtLink class="project-selector__link" :to="{ path: '/memory', query: { projectId: props.assignedProjectId ?? props.modelValue } }">Память</NuxtLink>
    </div>
    <div class="project-selector__current" aria-live="polite">
      <span>Текущий диалог</span>
      <strong v-if="assignedProject">Проект: {{ assignedProject.name }}</strong>
      <strong v-else-if="props.assignedProjectId">Проект привязан</strong>
      <strong v-else>Без проекта</strong>
    </div>
    <label class="project-selector__filter">
      Фильтр диалогов
      <select v-model="selected" :disabled="props.disabled" aria-label="Фильтр проекта">
        <option value="">Все проекты</option>
        <option value="none">Без проекта</option>
        <option v-for="project in props.projects" :key="project.id" :value="project.id">{{ project.name }}</option>
      </select>
    </label>
    <div class="project-selector__actions">
      <input v-model="newName" :disabled="props.disabled" type="text" maxlength="120" placeholder="Новый проект" @keydown.enter.prevent="createProject">
      <button type="button" :disabled="props.disabled || !newName.trim()" @click="createProject">Создать</button>
    </div>
    <div v-if="selectedProject" class="project-selector__actions">
      <input v-model="renameName" :disabled="props.disabled" type="text" maxlength="120" :placeholder="selectedProject.name" @keydown.enter.prevent="renameProject">
      <button type="button" :disabled="props.disabled || !renameName.trim()" @click="renameProject">Переименовать</button>
    </div>
    <button
      v-if="props.assignedProjectId === undefined && props.modelValue && props.modelValue !== 'none'"
      class="project-selector__assign"
      type="button"
      :disabled="props.disabled"
      @click="emit('assignSession', props.modelValue!)"
    >
      Подключить текущий диалог
    </button>
  </section>
</template>

<style scoped>
.project-selector { display: grid; gap: .5rem; padding: .1rem .25rem .8rem; border-bottom: 1px solid #e2e8f0; }
.project-selector__heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.project-selector__label { color: #475569; font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.project-selector__link { color: #2563eb; font-size: .72rem; text-decoration: none; }
.project-selector__current { display: grid; gap: .2rem; border-radius: .45rem; padding: .55rem; color: #64748b; background: #f1f5f9; font-size: .72rem; }
.project-selector__current strong { color: #334155; font-size: .76rem; overflow-wrap: anywhere; }
.project-selector__filter { display: grid; gap: .3rem; color: #64748b; font-size: .72rem; }
.project-selector select, .project-selector input { width: 100%; min-width: 0; border: 1px solid #cbd5e1; border-radius: .45rem; padding: .45rem .55rem; color: #334155; background: #fff; font: inherit; font-size: .76rem; }
.project-selector__actions { display: flex; gap: .35rem; }
.project-selector__actions button, .project-selector__assign { flex: 0 0 auto; border: 1px solid #cbd5e1; border-radius: .45rem; padding: .4rem .55rem; color: #475569; background: #fff; font: inherit; font-size: .7rem; cursor: pointer; }
.project-selector button:disabled { cursor: not-allowed; opacity: .55; }
.project-selector__assign { width: 100%; color: #1d4ed8; border-color: #bfdbfe; background: #eff6ff; }
</style>
