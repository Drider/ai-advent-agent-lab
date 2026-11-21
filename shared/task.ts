export type TaskStatus = 'active' | 'paused' | 'done' | 'cancelled'

export interface TaskQuestion {
  id: string
  label: string
  options?: TaskQuestionOption[]
}

export interface TaskQuestionOption {
  value: string
  label: string
}

export interface TaskStageDefinition {
  id: string
  title: string
  agentAction: string
  next: string[]
  allowWrites?: boolean
  questions?: TaskQuestion[]
  tools?: string[]
}

export interface TaskTemplate {
  id: string
  name: string
  stages: TaskStageDefinition[]
}

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: 'dev',
    name: 'Разработка',
    stages: [
      { id: 'planning', title: 'Планирование', agentAction: 'Составить план и предложить переход', next: ['execution'] },
      { id: 'execution', title: 'Реализация', agentAction: 'Выполнить план', next: ['validation'], allowWrites: true },
      { id: 'validation', title: 'Валидация', agentAction: 'Проверить результат по плану', next: ['done', 'execution'] },
      { id: 'done', title: 'Готово', agentAction: '', next: [] },
    ],
  },
  {
    id: 'bugfix',
    name: 'Исправление ошибки',
    stages: [
      { id: 'diagnosis', title: 'Диагностика', agentAction: 'Найти причину ошибки и предложить переход', next: ['planning'] },
      { id: 'planning', title: 'Планирование', agentAction: 'Составить план исправления и предложить переход', next: ['execution'] },
      { id: 'execution', title: 'Реализация', agentAction: 'Выполнить план исправления', next: ['validation'], allowWrites: true },
      { id: 'validation', title: 'Валидация', agentAction: 'Проверить исправление по плану', next: ['done', 'execution'] },
      { id: 'done', title: 'Готово', agentAction: '', next: [] },
    ],
  },
  {
    id: 'onboarding',
    name: 'Анкетирование',
    stages: [
      {
        id: 'interview',
        title: 'Анкета',
        agentAction: 'Задать вопросы анкеты по одному и сохранить ответы',
        next: ['review'],
        questions: [
          { id: 'name', label: 'Как к вам обращаться?' },
          { id: 'role', label: 'Чем вы занимаетесь?' },
          { id: 'goal', label: 'Для чего вам нужен ассистент?' },
          {
            id: 'level',
            label: 'Какой у вас уровень в этой теме: новичок, средний или эксперт?',
            options: [
              { value: 'beginner', label: 'Новичок' },
              { value: 'intermediate', label: 'Средний' },
              { value: 'expert', label: 'Эксперт' },
            ],
          },
          {
            id: 'style',
            label: 'Какой стиль ответов удобнее: кратко или подробно?',
            options: [
              { value: 'brief', label: 'Кратко' },
              { value: 'detailed', label: 'Подробно' },
            ],
          },
        ],
        tools: ['record_task_answer', 'update_task_step', 'request_task_transition'],
      },
      {
        id: 'review',
        title: 'Проверка ответов',
        agentAction: 'Показать ответы и предложить завершение',
        next: ['done', 'interview'],
        tools: ['amend_task_answer', 'update_task_step', 'request_task_transition'],
      },
      { id: 'done', title: 'Готово', agentAction: '', next: [] },
    ],
  },
]

export type TaskErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'TASK_EXISTS'
  | 'SESSION_RUNNING'
  | 'TURN_NOT_ACTIVE'
  | 'TRANSITION_NOT_ALLOWED'
  | 'TASK_PAUSED'
  | 'TASK_FINISHED'
  | 'TRANSITION_PENDING'
  | 'NO_PENDING_TRANSITION'
  | 'STAGE_MISMATCH'
  | 'REVISION_CONFLICT'
  | 'PROFILE_PREVIEW_CONFLICT'
  | 'SUMMARY_REQUIRED'
  | 'ANSWERS_MISSING'

export class TaskError extends Error {
  constructor(
    public readonly code: TaskErrorCode,
    message: string,
    public readonly allowedNext?: string[],
    public readonly missing?: string[],
    public readonly snapshot?: TaskSnapshot,
  ) {
    super(message)
    this.name = 'TaskError'
  }
}

export interface TaskState {
  id: string
  sessionId: string
  templateId: string
  goal: string
  stage: string
  step: string
  status: TaskStatus
  artifacts: Record<string, string>
  answers: Record<string, string>
  createdAt: string
  updatedAt: string
  pendingStage?: string
  pendingSummary?: string
}

export type TaskTransitionOutcome = 'approved' | 'rejected' | 'expired' | 'cancelled'

export interface TaskPendingTransition {
  id: string
  to: string
  summary: string
  requestedAt: string
  expiresAt: string
}

export interface TaskResolvedTransition {
  id: string
  to: string
  outcome: TaskTransitionOutcome
  resolvedAt: string
}

export interface TaskQuestionState {
  id: string
  prompt: string
  required: boolean
  answered: boolean
  value?: string
  recognized?: boolean
}

export interface OnboardingProfilePreview {
  name: string
  instructions: string
  taskRevision: number
}

export interface TaskSnapshot extends TaskState {
  revision: number
  allowedTransitions: string[]
  pendingTransition: TaskPendingTransition | null
  lastTransition: TaskResolvedTransition | null
  questions: TaskQuestionState[]
  completed: boolean
  profilePreview?: OnboardingProfilePreview
}

export type TaskCommand =
  | { ok: true; action: 'start'; templateId: string; goal: string }
  | { ok: true; action: 'approve' | 'reject' | 'pause' | 'resume' | 'cancel' }
  | { ok: false; error: string }

export function getTaskTemplate(templateId: string): TaskTemplate | undefined {
  return TASK_TEMPLATES.find(template => template.id === templateId)
}

export function getTaskStage(task: Pick<TaskState, 'templateId' | 'stage'>): TaskStageDefinition | undefined {
  return getTaskTemplate(task.templateId)?.stages.find(stage => stage.id === task.stage)
}

export function getTemplateQuestions(templateId: string): TaskQuestion[] {
  return getTaskTemplate(templateId)?.stages.flatMap(stage => stage.questions ?? []) ?? []
}

export function normalizeTaskAnswer(questionId: string, answer: string): string | undefined {
  const value = answer.trim()
  const normalized = value.toLocaleLowerCase('ru-RU')
  if (questionId === 'level') {
    const values: Record<string, string> = {
      beginner: 'beginner',
      'новичок': 'beginner',
      'начинающий': 'beginner',
      intermediate: 'intermediate',
      'средний': 'intermediate',
      expert: 'expert',
      'эксперт': 'expert',
    }
    return values[normalized]
  }
  if (questionId === 'style') {
    const values: Record<string, string> = {
      brief: 'brief',
      'кратко': 'brief',
      'краткий': 'brief',
      detailed: 'detailed',
      'подробно': 'detailed',
      'подробный': 'detailed',
    }
    return values[normalized]
  }
  return value
}

export function isTaskOpen(task: Pick<TaskState, 'status'>): boolean {
  return task.status === 'active' || task.status === 'paused'
}

export function assertTransition(task: TaskState, to: string, summary: string): void {
  if (task.status === 'done' || task.status === 'cancelled') {
    throw new TaskError('TASK_FINISHED', 'task is already finished')
  }
  if (task.status === 'paused') {
    throw new TaskError('TASK_PAUSED', 'task is paused')
  }
  if (task.pendingStage !== undefined) {
    throw new TaskError('TRANSITION_PENDING', 'task already has a pending transition')
  }
  if (!summary.trim()) {
    throw new TaskError('SUMMARY_REQUIRED', 'transition summary is required')
  }
  const allowedNext = getTaskStage(task)?.next ?? []
  if (!allowedNext.includes(to)) {
    throw new TaskError('TRANSITION_NOT_ALLOWED', `transition to ${to} is not allowed`, allowedNext)
  }
  const missing = (getTaskStage(task)?.questions ?? [])
    .filter(question => !(task.answers[question.id] ?? '').trim())
    .map(question => question.id)
  if (missing.length > 0) {
    throw new TaskError('ANSWERS_MISSING', 'all questions must be answered before leaving the stage', undefined, missing)
  }
}

export function getExpectedAction(task: TaskState): string {
  if (task.status === 'paused') return '/task resume'
  if (task.pendingStage !== undefined) return '/task approve | /task reject'
  return getTaskStage(task)?.agentAction ?? ''
}

export function taskBlocksWrites(task: TaskState): boolean {
  if (!isTaskOpen(task)) return false
  return task.status === 'paused' || getTaskStage(task)?.allowWrites !== true
}

export function getTaskActiveTools(task: TaskState, toolNames: string[]): string[] | undefined {
  if (!isTaskOpen(task)) return undefined
  const stage = getTaskStage(task)
  if (stage?.tools !== undefined) {
    const alwaysAvailable = new Set(['get_task_state', 'cancel_task_transition'])
    return toolNames.filter(name => alwaysAvailable.has(name) || stage.tools!.includes(name))
  }
  if (taskBlocksWrites(task)) return toolNames.filter(name => name !== 'write_file')
  return undefined
}

export function parseTaskCommand(text: string): TaskCommand {
  const input = text.trim()
  if (!/^\/task(?:\s|$)/u.test(input)) return { ok: false, error: 'Команда должна начинаться с /task.' }
  const startMatch = input.match(/^\/task\s+start\s+(\S+)\s+([\s\S]+)$/u)
  if (startMatch) {
    const [, templateId, rawGoal] = startMatch
    const goal = rawGoal!.trim()
    if (!getTaskTemplate(templateId!)) return { ok: false, error: `Неизвестный шаблон задачи: ${templateId}.` }
    return {
      ok: true,
      action: 'start',
      templateId: templateId!,
      goal,
    }
  }
  if (/^\/task\s+start(?:\s|$)/u.test(input)) return { ok: false, error: 'Использование: /task start <шаблон> <цель>.' }
  const [, action] = input.split(/\s+/u)
  if (action && ['approve', 'reject', 'pause', 'resume', 'cancel'].includes(action)) {
    return { ok: true, action: action as 'approve' | 'reject' | 'pause' | 'resume' | 'cancel' }
  }
  return { ok: false, error: 'Неизвестная команда. Используйте: /task start, approve, reject, pause, resume или cancel.' }
}
