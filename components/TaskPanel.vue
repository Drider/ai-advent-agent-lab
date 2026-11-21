<script setup lang="ts">
import { computed, reactive, shallowRef, watch } from 'vue'
import {
  TASK_TEMPLATES,
  getExpectedAction,
  getTaskTemplate,
  getTemplateQuestions,
  isTaskOpen,
  normalizeTaskAnswer,
  type TaskSnapshot,
} from '~/shared/task'

type TaskAction = {
  action: 'approve' | 'reject' | 'pause' | 'resume' | 'cancel'
  pendingTransitionId?: string
  expectedRevision?: number
  expectedProfileName?: string
}

const props = defineProps<{
  task: TaskSnapshot | null
  busy: boolean
  error?: string | null
}>()

const emit = defineEmits<{
  start: [payload: { templateId: string; goal: string }]
  action: [payload: TaskAction]
  saveAnswers: [payload: { answers: Record<string, string>; expectedRevision: number }]
  continueTask: []
}>()

const startOpen = shallowRef(false)
const expanded = shallowRef(false)
const templateId = shallowRef('dev')
const goal = shallowRef('')
const answersOpen = shallowRef(false)
const answerDraft = reactive<Record<string, string>>({ name: '', role: '', goal: '', level: '', style: '' })

const openTask = computed(() => props.task !== null && isTaskOpen(props.task))
const selectedTemplate = computed(() => getTaskTemplate(templateId.value) ?? TASK_TEMPLATES[0]!)
const stageItems = computed(() => {
  const task = props.task
  if (!task) return []
  const template = getTaskTemplate(task.templateId)
  const currentIndex = template?.stages.findIndex(stage => stage.id === task.stage) ?? -1
  return (template?.stages ?? []).map((stage, index) => ({
    ...stage,
    state: index < currentIndex ? 'completed' : index === currentIndex ? 'current' : 'future',
  }))
})
const questionnaireRows = computed(() => {
  const task = props.task
  if (!task) return []
  return getTemplateQuestions(task.templateId).map(question => ({
    ...question,
    answer: task.answers[question.id]?.trim() || '—',
  }))
})
const statusLabel = computed(() => {
  switch (props.task?.status) {
    case 'active': return 'Активна'
    case 'paused': return 'Пауза'
    case 'done': return 'Готово'
    case 'cancelled': return 'Отменена'
    default: return ''
  }
})
const panelTitle = computed(() => {
  if (!props.task) return 'Задача'
  return getTaskTemplate(props.task.templateId)?.name ?? props.task.templateId
})
const currentStageLabel = computed(() => {
  if (!props.task) return 'Нет активной задачи'
  return getTaskTemplate(props.task.templateId)?.stages.find(stage => stage.id === props.task?.stage)?.title ?? props.task.stage
})
const panelSummary = computed(() => props.task
  ? `${currentStageLabel.value} · ${statusLabel.value}`
  : 'Нажмите, чтобы начать или посмотреть доступные шаблоны')
const canSubmitStart = computed(() => !props.busy && goal.value.trim().length > 0)
const onboardingQuestions = computed(() => props.task?.templateId === 'onboarding'
  ? getTemplateQuestions('onboarding')
  : [])
const canEditAnswers = computed(() => props.task?.templateId === 'onboarding'
  && ['interview', 'review'].includes(props.task.stage)
  && props.task.status === 'active'
  && props.task.pendingTransition === null)
const canSubmitAnswers = computed(() => !props.busy && canEditAnswers.value && onboardingQuestions.value.every((question) => {
  const value = answerDraft[question.id]?.trim() ?? ''
  return value.length > 0 && (!question.options || question.options.some(option => option.value === value))
}))
const unknownLegacyAnswerIds = computed(() => onboardingQuestions.value.flatMap((question) => {
  const saved = props.task?.answers[question.id]?.trim()
  return saved && question.options && normalizeTaskAnswer(question.id, saved) === undefined ? [question.id] : []
}))
const pendingExpiryLabel = computed(() => {
  const value = props.task?.pendingTransition?.expiresAt
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
})
const lastTransitionLabel = computed(() => {
  switch (props.task?.lastTransition?.outcome) {
    case 'approved': return 'Переход подтверждён'
    case 'rejected': return 'Переход отклонён'
    case 'cancelled': return 'Запрос перехода отменён'
    case 'expired': return 'Срок запроса перехода истёк'
    default: return ''
  }
})
const canContinueAfterTransition = computed(() => {
  const outcome = props.task?.lastTransition?.outcome
  return outcome === 'approved' || outcome === 'rejected'
})

watch(
  () => [props.task?.id, props.task?.revision] as const,
  () => {
    for (const question of onboardingQuestions.value) {
      const saved = props.task?.answers[question.id]?.trim() ?? ''
      answerDraft[question.id] = question.options ? (normalizeTaskAnswer(question.id, saved) ?? '') : saved
    }
  },
  { immediate: true },
)

function submitStart(): void {
  if (!canSubmitStart.value) return
  emit('start', { templateId: templateId.value, goal: goal.value.trim() })
  goal.value = ''
  startOpen.value = false
}

function emitAction(action: TaskAction['action']): void {
  if (action === 'approve' || action === 'reject') {
    const task = props.task
    const pendingTransitionId = task?.pendingTransition?.id
    if (!task || !pendingTransitionId) return
    emit('action', {
      action,
      pendingTransitionId,
      expectedRevision: task.revision,
      ...(action === 'approve' && task.profilePreview ? { expectedProfileName: task.profilePreview.name } : {}),
    })
    return
  }
  emit('action', { action })
}

function submitAnswers(): void {
  const task = props.task
  if (!task || !canSubmitAnswers.value) return
  emit('saveAnswers', {
    answers: Object.fromEntries(onboardingQuestions.value.map(question => [question.id, answerDraft[question.id]!.trim()])),
    expectedRevision: task.revision,
  })
}
</script>

<template>
  <section class="task-panel" aria-labelledby="task-panel-title">
    <div class="task-panel__heading">
      <button
        type="button"
        class="task-panel__toggle"
        :aria-expanded="expanded"
        aria-controls="task-panel-content"
        @click="expanded = !expanded"
      >
        <span class="task-panel__toggle-copy">
          <span class="task-panel__eyebrow">Жизненный цикл задачи</span>
          <span id="task-panel-title" class="task-panel__title">{{ panelTitle }}</span>
          <span class="task-panel__summary">{{ panelSummary }}</span>
        </span>
        <span class="task-panel__chevron" :class="{ 'task-panel__chevron--open': expanded }" aria-hidden="true">⌄</span>
      </button>
    </div>

    <div v-if="expanded" id="task-panel-content" class="task-panel__content">
      <template v-if="!openTask">
      <p v-if="props.task?.status === 'done'" class="task-panel__muted">Задача завершена.</p>
      <p v-else-if="props.task?.status === 'cancelled'" class="task-panel__muted">Задача отменена. Можно начать новую.</p>
      <dl v-if="questionnaireRows.length" class="task-panel__answers">
        <template v-for="row in questionnaireRows" :key="row.id">
          <dt>{{ row.label }}</dt>
          <dd>{{ row.answer }}</dd>
        </template>
      </dl>

      <UButton color="neutral" variant="soft" :disabled="props.busy" @click="startOpen = !startOpen">
        {{ startOpen ? 'Скрыть форму' : 'Начать задачу' }}
      </UButton>
      <form v-if="startOpen" class="task-panel__form" @submit.prevent="submitStart">
        <label class="task-panel__label" for="task-template">Шаблон</label>
        <select id="task-template" v-model="templateId" class="task-panel__select" :disabled="props.busy">
          <option v-for="template in TASK_TEMPLATES" :key="template.id" :value="template.id">{{ template.name }}</option>
        </select>
        <label class="task-panel__label" for="task-goal">Цель</label>
        <textarea id="task-goal" v-model="goal" class="task-panel__textarea" rows="2" maxlength="2000" placeholder="Что нужно сделать?" :disabled="props.busy" />
        <p class="task-panel__hint">Стартовый этап: {{ selectedTemplate.stages[0]?.title }}</p>
        <UButton type="submit" color="neutral" :disabled="!canSubmitStart">Создать задачу</UButton>
      </form>
      </template>

      <template v-else-if="props.task">
      <p class="task-panel__goal">{{ props.task.goal }}</p>
      <ol class="task-panel__stages">
        <li v-for="stage in stageItems" :key="stage.id" :class="`task-panel__stage task-panel__stage--${stage.state}`">
          <span class="task-panel__stage-marker" aria-hidden="true">{{ stage.state === 'completed' ? '✓' : stageItems.indexOf(stage) + 1 }}</span>
          <span>
            <strong>{{ stage.title }}</strong>
            <small v-if="stage.state === 'current'">{{ stage.agentAction }}</small>
          </span>
        </li>
      </ol>
      <p class="task-panel__expected"><strong>Ожидается:</strong> {{ getExpectedAction(props.task) || 'ничего — этап завершён' }}</p>
      <p v-if="props.task.step" class="task-panel__step"><strong>Шаг:</strong> {{ props.task.step }}</p>
      <dl v-if="questionnaireRows.length" class="task-panel__answers">
        <template v-for="row in questionnaireRows" :key="row.id">
          <dt>{{ row.label }}</dt>
          <dd>{{ row.answer }}</dd>
        </template>
      </dl>

      <section v-if="props.task.profilePreview" class="task-panel__preview" aria-labelledby="task-profile-preview-title">
        <strong id="task-profile-preview-title">Будет создан профиль: {{ props.task.profilePreview.name }}</strong>
        <pre>{{ props.task.profilePreview.instructions }}</pre>
        <small>Ревизия анкеты: {{ props.task.profilePreview.taskRevision }}</small>
      </section>

      <div v-if="canEditAnswers" class="task-panel__bulk">
        <UButton color="neutral" variant="soft" :disabled="props.busy" @click="answersOpen = !answersOpen">
          {{ answersOpen ? 'Скрыть форму' : 'Заполнить анкету формой' }}
        </UButton>
        <form v-if="answersOpen" class="task-panel__form task-panel__answers-form" @submit.prevent="submitAnswers">
          <template v-for="question in onboardingQuestions" :key="question.id">
            <label class="task-panel__label" :for="`task-answer-${question.id}`">{{ question.label }}</label>
            <select
              v-if="question.options"
              :id="`task-answer-${question.id}`"
              v-model="answerDraft[question.id]"
              class="task-panel__select"
              :disabled="props.busy"
              required
            >
              <option value="" disabled>Выберите вариант</option>
              <option v-for="option in question.options" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <input
              v-else
              :id="`task-answer-${question.id}`"
              v-model="answerDraft[question.id]"
              class="task-panel__select"
              :disabled="props.busy"
              maxlength="500"
              required
            >
            <p v-if="unknownLegacyAnswerIds.includes(question.id)" class="task-panel__warning">
              Сохранённое значение «{{ props.task.answers[question.id] }}» не распознано. Выберите вариант вручную.
            </p>
          </template>
          <UButton type="submit" color="neutral" :disabled="!canSubmitAnswers">Сохранить все ответы</UButton>
        </form>
      </div>

      <div v-if="props.task.pendingTransition" class="task-panel__pending">
        <strong>Агент предлагает перейти: {{ props.task.stage }} → {{ props.task.pendingTransition.to }}</strong>
        <p>{{ props.task.pendingTransition.summary }}</p>
        <p class="task-panel__meta">Подтвердить до {{ pendingExpiryLabel }}</p>
        <div class="task-panel__actions">
          <UButton color="neutral" :disabled="props.busy" @click="emitAction('approve')">Подтвердить</UButton>
          <UButton color="neutral" variant="soft" :disabled="props.busy" @click="emitAction('reject')">Отклонить</UButton>
        </div>
      </div>

      <div v-else-if="props.task.lastTransition" class="task-panel__result" role="status">
        <strong>{{ lastTransitionLabel }}: {{ props.task.lastTransition.to }}</strong>
        <small>ID: {{ props.task.lastTransition.id }}</small>
        <UButton v-if="canContinueAfterTransition" color="neutral" :disabled="props.busy" @click="emit('continueTask')">Продолжить задачу</UButton>
      </div>

      <div class="task-panel__actions">
        <UButton v-if="props.task.status === 'active'" color="neutral" variant="soft" :disabled="props.busy" @click="emitAction('pause')">Пауза</UButton>
        <UButton v-else color="neutral" variant="soft" :disabled="props.busy" @click="emitAction('resume')">Снять с паузы</UButton>
        <UButton color="neutral" variant="ghost" :disabled="props.busy" @click="emitAction('cancel')">Отменить</UButton>
      </div>
      </template>
    </div>

    <p v-if="props.error" class="task-panel__error" role="alert">{{ props.error }}</p>
  </section>
</template>

<style scoped>
.task-panel {
  margin: 0 1.25rem .75rem;
  border: 1px solid #dbe4ef;
  border-radius: .75rem;
  padding: .45rem .6rem;
  color: #334155;
  background: #f8fafc;
}

.task-panel__heading,
.task-panel__actions { display: flex; align-items: center; gap: .5rem; }
.task-panel__heading { min-width: 0; }
.task-panel__toggle { display: flex; align-items: center; justify-content: space-between; gap: .6rem; width: 100%; border: 0; padding: .1rem 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
.task-panel__toggle-copy { display: grid; min-width: 0; gap: .05rem; }
.task-panel__eyebrow { color: #64748b; font-size: .62rem; letter-spacing: .08em; line-height: 1.1; text-transform: uppercase; }
.task-panel__title { overflow: hidden; font-size: .86rem; font-weight: 700; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
.task-panel__summary { overflow: hidden; color: #64748b; font-size: .72rem; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
.task-panel__chevron { flex: 0 0 auto; color: #64748b; font-size: 1rem; line-height: 1; transform: rotate(0deg); transition: transform .15s ease; }
.task-panel__chevron--open { transform: rotate(180deg); }
.task-panel__content { padding-top: .55rem; }
.task-panel__goal { margin: .65rem 0; font-weight: 600; overflow-wrap: anywhere; }
.task-panel__muted,
.task-panel__hint,
.task-panel__expected,
.task-panel__step { margin: .55rem 0; color: #64748b; font-size: .78rem; }
.task-panel__form { display: grid; gap: .35rem; max-width: 40rem; margin-top: .7rem; }
.task-panel__label { color: #475569; font-size: .75rem; font-weight: 600; }
.task-panel__select,
.task-panel__textarea { width: 100%; border: 1px solid #cbd5e1; border-radius: .45rem; padding: .45rem .55rem; color: #1e293b; background: #fff; font: inherit; font-size: .8rem; }
.task-panel__textarea { resize: vertical; }
.task-panel__answers { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); gap: .25rem .75rem; margin: .7rem 0; font-size: .78rem; }
.task-panel__answers dt { color: #64748b; }
.task-panel__answers dd { margin: 0; color: #1e293b; overflow-wrap: anywhere; }
.task-panel__stages { display: flex; flex-wrap: wrap; gap: .45rem; margin: .7rem 0; padding: 0; list-style: none; }
.task-panel__stage { display: flex; align-items: center; gap: .3rem; min-width: 8rem; color: #94a3b8; font-size: .76rem; }
.task-panel__stage--completed { color: #64748b; }
.task-panel__stage--current { color: #1e293b; }
.task-panel__stage-marker { display: inline-grid; width: 1.25rem; height: 1.25rem; place-items: center; border-radius: 999px; background: #e2e8f0; font-size: .68rem; }
.task-panel__stage--completed .task-panel__stage-marker { color: #166534; background: #dcfce7; }
.task-panel__stage--current .task-panel__stage-marker { color: #fff; background: #334155; }
.task-panel__stage small { display: block; margin-top: .1rem; color: #64748b; font-size: .68rem; }
.task-panel__pending { margin: .7rem 0; border-left: 3px solid #64748b; padding: .55rem .7rem; background: #fff; font-size: .78rem; }
.task-panel__pending p { margin: .35rem 0 .55rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.task-panel__meta { color: #64748b; font-size: .72rem; }
.task-panel__result { display: grid; justify-items: start; gap: .4rem; margin: .7rem 0; border-left: 3px solid #16a34a; padding: .55rem .7rem; background: #fff; font-size: .78rem; }
.task-panel__result small { color: #64748b; overflow-wrap: anywhere; }
.task-panel__preview { display: grid; gap: .4rem; margin: .7rem 0; border: 1px solid #cbd5e1; border-radius: .5rem; padding: .65rem; background: #fff; font-size: .78rem; }
.task-panel__preview pre { margin: 0; color: #334155; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
.task-panel__preview small { color: #64748b; }
.task-panel__bulk { margin: .7rem 0; }
.task-panel__answers-form { grid-template-columns: minmax(10rem, .8fr) minmax(12rem, 1.2fr); align-items: center; }
.task-panel__answers-form > button { grid-column: 2; justify-self: start; }
.task-panel__warning { grid-column: 2; margin: -.15rem 0 .15rem; color: #b45309; font-size: .72rem; }
.task-panel__error { margin: .65rem 0 0; color: #b91c1c; font-size: .78rem; white-space: pre-wrap; }
.task-panel__actions { flex-wrap: wrap; margin-top: .55rem; }

@media (max-width: 640px) {
  .task-panel__answers-form { grid-template-columns: 1fr; }
  .task-panel__answers-form > button,
  .task-panel__warning { grid-column: 1; }
}
</style>
