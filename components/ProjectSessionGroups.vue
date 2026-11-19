<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import type { SessionSummary } from '~/shared/chat'
import type { Project } from '~/shared/memory'

interface Group {
  key: string
  name: string
  project?: Project
}

interface SessionPage {
  items: SessionSummary[]
  nextCursor?: string
  loading: boolean
  error?: string
}

const props = defineProps<{
  projects: Project[]
  currentSession: SessionSummary
  disabled?: boolean
  deletingId?: string | null
  refreshKey: number
  createdProjectId?: string | null
  projectError?: string | null
  deleteError?: string | null
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  newSession: [projectId: string | null]
  deleteSession: [session: { id: string; title: string }]
  createProject: [name: string]
  renameProject: [payload: { id: string; name: string; expectedRevision: number }]
  assignProject: [projectId: string]
}>()

const creating = shallowRef(false)
const creatingPending = shallowRef(false)
const newName = shallowRef('')
const renamingKey = shallowRef<string | null>(null)
const renameName = shallowRef('')
const expandedKeys = shallowRef<Set<string>>(new Set())
const pages = shallowRef<Record<string, SessionPage>>({})
const requestIds = new Map<string, number>()

const currentGroupKey = computed(() => props.currentSession.projectId ?? 'none')
const groups = computed<Group[]>(() => {
  const projects: Group[] = props.projects.map(project => ({ key: project.id, name: project.name, project }))
  const currentIndex = projects.findIndex(project => project.key === currentGroupKey.value)
  if (currentIndex > 0) projects.unshift(projects.splice(currentIndex, 1)[0]!)
  if (currentIndex === -1 && currentGroupKey.value !== 'none') {
    projects.unshift({ key: currentGroupKey.value, name: 'Проект привязан' })
  }
  const unassigned: Group = { key: 'none', name: 'Без проекта' }
  return currentGroupKey.value === 'none' ? [unassigned, ...projects] : [...projects, unassigned]
})

function setExpanded(key: string, expanded: boolean): void {
  const next = new Set(expandedKeys.value)
  if (expanded) next.add(key)
  else next.delete(key)
  expandedKeys.value = next
}

async function loadGroup(key: string, append = false): Promise<void> {
  const previous = pages.value[key]
  if (append && (!previous?.nextCursor || previous.loading)) return
  const requestId = (requestIds.get(key) ?? 0) + 1
  requestIds.set(key, requestId)
  pages.value = {
    ...pages.value,
    [key]: { items: previous?.items ?? [], nextCursor: previous?.nextCursor, loading: true },
  }
  try {
    const result = await $fetch<{ items: SessionSummary[]; nextCursor?: string }>('/api/sessions', {
      query: { projectId: key, limit: 30, ...(append ? { cursor: previous!.nextCursor } : {}) },
    })
    if (requestIds.get(key) !== requestId) return
    const items = append ? [...previous!.items, ...result.items] : result.items
    pages.value = { ...pages.value, [key]: { items, nextCursor: result.nextCursor, loading: false } }
  } catch {
    if (requestIds.get(key) !== requestId) return
    pages.value = {
      ...pages.value,
      [key]: { items: previous?.items ?? [], nextCursor: previous?.nextCursor, loading: false, error: 'Не удалось загрузить диалоги проекта.' },
    }
  }
}

function toggleGroup(key: string): void {
  const expanded = !expandedKeys.value.has(key)
  setExpanded(key, expanded)
  if (expanded) void loadGroup(key)
}

function groupItems(key: string): SessionSummary[] {
  const items = pages.value[key]?.items ?? []
  if (key !== currentGroupKey.value) return items
  if (!items.some(item => item.id === props.currentSession.id)) return [props.currentSession, ...items]
  return items.map(item => item.id === props.currentSession.id ? props.currentSession : item)
}

function projectActions(group: Group) {
  const actions = [{
    label: 'Новый диалог',
    icon: 'i-lucide-square-pen',
    disabled: props.disabled,
    onSelect: () => emit('newSession', group.key === 'none' ? null : group.key),
  }]
  if (group.key === 'none') return actions
  return [
    ...actions,
    {
      label: 'Память проекта',
      icon: 'i-lucide-brain',
      to: { path: '/memory', query: { projectId: group.key } },
    },
    ...(group.project ? [{
      label: 'Переименовать',
      icon: 'i-lucide-pencil',
      disabled: props.disabled,
      onSelect: () => {
        renamingKey.value = group.key
        renameName.value = group.name
      },
    }] : []),
    ...(!props.currentSession.projectId ? [{
      label: 'Подключить текущий диалог',
      icon: 'i-lucide-link',
      disabled: props.disabled,
      onSelect: () => emit('assignProject', group.key),
    }] : []),
  ]
}

function createProject(): void {
  const name = newName.value.trim()
  if (!name || creatingPending.value) return
  creatingPending.value = true
  emit('createProject', name)
}

function renameProject(project: Project): void {
  const name = renameName.value.trim()
  if (!name) return
  emit('renameProject', { id: project.id, name, expectedRevision: project.revision })
  renamingKey.value = null
  renameName.value = ''
}

function statusLabel(status: SessionSummary['status']): string {
  switch (status) {
    case 'running': return 'В работе'
    case 'interrupted': return 'Прерван'
    case 'stopped': return 'Остановлен'
    case 'failed': return 'Ошибка'
    case 'needs_review': return 'Нужна проверка'
    default: return ''
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(value))
}

watch([() => props.currentSession.id, currentGroupKey], () => {
  setExpanded(currentGroupKey.value, true)
  void loadGroup(currentGroupKey.value)
}, { immediate: true })

watch(() => props.refreshKey, () => {
  for (const key of expandedKeys.value) void loadGroup(key)
})

watch(() => props.createdProjectId, id => {
  if (!id) return
  creatingPending.value = false
  creating.value = false
  newName.value = ''
  setExpanded(id, true)
  void loadGroup(id)
})

watch(() => props.projectError, error => {
  if (error) creatingPending.value = false
})
</script>

<template>
  <section class="project-groups" aria-label="Проекты и диалоги">
    <div class="project-groups__heading">
      <h2>Проекты</h2>
      <UButton
        icon="i-lucide-plus"
        color="neutral"
        variant="soft"
        size="sm"
        square
        aria-label="Создать проект"
        :disabled="props.disabled || creatingPending"
        @click="creating = !creating"
      />
    </div>

    <form v-if="creating" class="project-groups__form" @submit.prevent="createProject">
      <input v-model="newName" type="text" maxlength="120" aria-label="Название нового проекта" placeholder="Название проекта" :disabled="props.disabled || creatingPending">
      <UButton type="submit" icon="i-lucide-check" color="neutral" variant="soft" size="sm" square aria-label="Создать проект" :loading="creatingPending" :disabled="props.disabled || creatingPending || !newName.trim()" />
      <UButton type="button" icon="i-lucide-x" color="neutral" variant="ghost" size="sm" square aria-label="Отмена" :disabled="creatingPending" @click="creating = false" />
    </form>
    <p v-if="props.projectError" class="session-sidebar__error" role="alert">{{ props.projectError }}</p>

    <nav class="project-groups__list" aria-label="Диалоги по проектам">
      <section v-for="group in groups" :key="group.key" class="project-group">
        <div class="project-group__heading" :class="{ 'project-group__heading--current': group.key === currentGroupKey }">
          <button
            type="button"
            class="project-group__toggle"
            :aria-expanded="expandedKeys.has(group.key)"
            :aria-controls="`project-group-${group.key}`"
            @click="toggleGroup(group.key)"
          >
            <UIcon :name="expandedKeys.has(group.key) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" aria-hidden="true" />
            <UIcon :name="group.key === 'none' ? 'i-lucide-folder-open' : 'i-lucide-folder'" aria-hidden="true" />
            <span :title="group.name">{{ group.name }}</span>
          </button>
          <UDropdownMenu :items="projectActions(group)">
            <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" square :aria-label="`Действия: ${group.name}`" />
          </UDropdownMenu>
        </div>

        <form v-if="renamingKey === group.key && group.project" class="project-groups__form" @submit.prevent="renameProject(group.project)">
          <input v-model="renameName" type="text" maxlength="120" :aria-label="`Новое название проекта ${group.name}`" :disabled="props.disabled">
          <UButton type="submit" icon="i-lucide-check" color="neutral" variant="soft" size="sm" square aria-label="Сохранить название" :disabled="props.disabled || !renameName.trim()" />
          <UButton type="button" icon="i-lucide-x" color="neutral" variant="ghost" size="sm" square aria-label="Отмена" @click="renamingKey = null" />
        </form>

        <div v-if="expandedKeys.has(group.key)" :id="`project-group-${group.key}`" class="project-group__body">
          <div v-if="pages[group.key]?.loading && groupItems(group.key).length === 0" class="project-group__message" role="status">Загружаем диалоги…</div>
          <div v-else-if="!pages[group.key]?.loading && groupItems(group.key).length === 0 && !pages[group.key]?.error" class="project-group__message">Пока нет диалогов.</div>
          <div v-for="item in groupItems(group.key)" :key="item.id" class="session-list__row">
            <button
              class="session-list__item"
              :class="{ 'session-list__item--selected': item.id === props.currentSession.id }"
              type="button"
              :disabled="props.disabled || Boolean(props.deletingId)"
              :aria-current="item.id === props.currentSession.id ? 'page' : undefined"
              @click="emit('select', item.id)"
            >
              <span class="session-list__item-copy">
                <strong>{{ item.title }}</strong>
                <span class="session-list__item-meta">
                  <span class="session-list__kind" :class="{ 'session-list__kind--branch': item.branchSourceMessageId }">
                    <UIcon :name="item.branchSourceMessageId ? 'i-lucide-git-branch' : 'i-lucide-message-square'" aria-hidden="true" />
                    {{ item.branchSourceMessageId ? 'Ветка' : 'Основной диалог' }}
                  </span>
                  <span>{{ formatDate(item.updatedAt) }}</span>
                </span>
              </span>
              <span v-if="statusLabel(item.status)" class="session-list__status">{{ statusLabel(item.status) }}</span>
            </button>
            <UButton
              class="session-list__delete"
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="sm"
              square
              :aria-label="`Удалить диалог «${item.title}»`"
              :title="item.status === 'running' ? 'Дождитесь завершения запроса' : 'Удалить диалог'"
              :disabled="props.disabled || item.status === 'running' || Boolean(props.deletingId)"
              :loading="props.deletingId === item.id"
              @click="emit('deleteSession', { id: item.id, title: item.title })"
            />
          </div>
          <p v-if="pages[group.key]?.error" class="session-sidebar__error" role="alert">{{ pages[group.key]?.error }}</p>
          <UButton v-if="pages[group.key]?.error" color="neutral" variant="ghost" size="sm" block @click="loadGroup(group.key)">Повторить загрузку</UButton>
          <UButton v-else-if="pages[group.key]?.nextCursor" color="neutral" variant="ghost" size="sm" block :disabled="pages[group.key]?.loading" @click="loadGroup(group.key, true)">Загрузить ещё</UButton>
        </div>
      </section>
    </nav>
    <p v-if="props.deleteError" class="session-sidebar__error" role="alert">{{ props.deleteError }}</p>
  </section>
</template>

<style scoped>
.project-groups { display: grid; gap: .55rem; min-height: 0; }
.project-groups__heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .1rem .25rem .5rem; border-bottom: 1px solid #e2e8f0; }
.project-groups__heading h2 { margin: 0; color: #172033; font-size: 1.05rem; }
.project-groups__form { display: flex; align-items: center; gap: .3rem; padding: .15rem .25rem; }
.project-groups__form input { width: 100%; min-width: 0; border: 1px solid #cbd5e1; border-radius: .45rem; padding: .4rem .5rem; background: #fff; color: #334155; font: inherit; font-size: .76rem; }
.project-groups__list { display: grid; gap: .35rem; }
.project-group { min-width: 0; }
.project-group__heading { display: flex; align-items: center; gap: .15rem; border-radius: .5rem; }
.project-group__heading--current { background: #eef2f7; }
.project-group__toggle { display: flex; min-width: 0; flex: 1; align-items: center; gap: .4rem; border: 0; border-radius: .5rem; padding: .5rem .35rem; background: transparent; color: #334155; cursor: pointer; text-align: left; font: inherit; font-size: .78rem; font-weight: 650; }
.project-group__toggle:hover { background: #e2e8f0; }
.project-group__toggle span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-group__toggle :first-child { flex: 0 0 auto; }
.project-group__body { display: grid; gap: .2rem; padding: .2rem 0 .35rem .65rem; }
.project-group__message { padding: .55rem .5rem; color: #64748b; font-size: .72rem; }
</style>
