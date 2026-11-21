import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  assertTransition,
  getTemplateQuestions,
  normalizeTaskAnswer,
  getTaskStage,
  getTaskTemplate,
  TaskError,
  type TaskSnapshot,
  type TaskState,
  type TaskStatus,
  type TaskTransitionOutcome,
} from '../../shared/task'
import { buildOnboardingPreview, completeOnboarding } from '../tasks/onboarding'

const PENDING_TRANSITION_TTL_MS = 7 * 24 * 60 * 60 * 1_000

type TransitionActionInput = string | {
  pendingTransitionId?: string
  stage?: string
  expectedRevision?: number
  expectedProfileName?: string
}

interface TaskRow {
  id: string
  session_id: string
  template_id: string
  goal: string
  stage: string
  step: string
  status: TaskStatus
  pending_stage: string | null
  pending_summary: string | null
  artifacts_json: string
  answers_json: string
  created_at: string
  updated_at: string
  revision: number
}

interface TaskTransitionRow {
  id: string
  task_id: string
  from_stage: string
  to_stage: string
  summary: string
  requested_at: string
  expires_at: string
  outcome: TaskTransitionOutcome | null
  resolved_at: string | null
  requested_revision: number
  resolved_revision: number | null
  repeat_count: number
}

function now(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStringRecord(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json) as unknown
    return isRecord(parsed)
      ? Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => typeof value === 'string' ? [[key, value] as [string, string]] : []))
      : {}
  } catch {
    return {}
  }
}

function parseTask(row: TaskRow): TaskState {
  return {
    id: row.id,
    sessionId: row.session_id,
    templateId: row.template_id,
    goal: row.goal,
    stage: row.stage,
    step: row.step,
    status: row.status,
    artifacts: parseStringRecord(row.artifacts_json),
    answers: parseStringRecord(row.answers_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.pending_stage === null ? {} : { pendingStage: row.pending_stage }),
    ...(row.pending_summary === null ? {} : { pendingSummary: row.pending_summary }),
  }
}

function validateGoal(input: unknown): string {
  if (typeof input !== 'string') throw new TaskError('INVALID_INPUT', 'task goal must be a string')
  const goal = input.trim()
  if (goal.length < 1 || goal.length > 2_000) throw new TaskError('INVALID_INPUT', 'task goal must be 1 to 2000 characters')
  return goal
}

function validateStep(step: unknown): string {
  if (typeof step !== 'string') throw new TaskError('INVALID_INPUT', 'task step must be a string')
  const value = step.trim()
  if (value.length < 1 || value.length > 500) throw new TaskError('INVALID_INPUT', 'task step must be 1 to 500 characters')
  return value
}

function validateSummary(summary: unknown): string {
  if (typeof summary !== 'string') throw new TaskError('INVALID_INPUT', 'transition summary must be a string')
  const value = summary.trim()
  if (value.length < 1 || value.length > 8_000) throw new TaskError('INVALID_INPUT', 'transition summary must be 1 to 8000 characters')
  return value
}

function validateAnswer(answer: unknown): string {
  const value = typeof answer === 'string' ? answer.trim() : ''
  if (value.length < 1 || value.length > 500) {
    throw new TaskError('INVALID_INPUT', 'task answer must be 1 to 500 characters')
  }
  return value
}

export function createTaskRepository(db: Database.Database) {
  const transaction = <T>(callback: () => T): T => db.transaction(callback).immediate()

  function getRowForSession(sessionId: string): TaskRow | undefined {
    return db.prepare(`
      SELECT id, session_id, template_id, goal, stage, step, status,
             pending_stage, pending_summary, artifacts_json, answers_json,
             created_at, updated_at, revision
      FROM tasks
      WHERE session_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(sessionId) as TaskRow | undefined
  }

  function assertSession(sessionId: string): void {
    if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) {
      throw new TaskError('NOT_FOUND', `session ${sessionId} was not found`)
    }
  }

  function getForSession(sessionId: string): TaskState | undefined {
    const row = getRowForSession(sessionId)
    return row === undefined ? undefined : parseTask(row)
  }

  function getSnapshot(sessionId: string): TaskSnapshot | null {
    const row = getRowForSession(sessionId)
    if (!row) return null
    const task = parseTask(row)
    const pending = db.prepare(`
      SELECT id, task_id, from_stage, to_stage, summary, requested_at, expires_at, outcome, resolved_at,
             requested_revision, resolved_revision, repeat_count
      FROM task_transitions
      WHERE task_id = ? AND outcome IS NULL
      ORDER BY rowid DESC
      LIMIT 1
    `).get(task.id) as TaskTransitionRow | undefined
    const expired = pending !== undefined && Date.parse(pending.expires_at) <= Date.now()
    const resolved = expired
      ? undefined
      : db.prepare(`
          SELECT id, task_id, from_stage, to_stage, summary, requested_at, expires_at, outcome, resolved_at,
                 requested_revision, resolved_revision, repeat_count
          FROM task_transitions
          WHERE task_id = ? AND outcome IS NOT NULL
          ORDER BY resolved_at DESC, rowid DESC
          LIMIT 1
        `).get(task.id) as TaskTransitionRow | undefined
    const baseTask = expired
      ? (({ pendingStage: _pendingStage, pendingSummary: _pendingSummary, ...current }) => current)(task)
      : task
    const questions = getTaskTemplate(task.templateId)?.stages.flatMap(stage => stage.questions ?? []) ?? []
    const lastTransition = expired && pending
      ? {
          id: pending.id,
          to: pending.to_stage,
          outcome: 'expired' as const,
          resolvedAt: pending.expires_at,
        }
      : resolved?.outcome && resolved.resolved_at
        ? {
            id: resolved.id,
            to: resolved.to_stage,
            outcome: resolved.outcome,
            resolvedAt: resolved.resolved_at,
          }
        : null
    const snapshot: TaskSnapshot = {
      ...baseTask,
      revision: row.revision,
      allowedTransitions: getTaskStage(task)?.next ?? [],
      pendingTransition: pending && !expired
        ? {
            id: pending.id,
            to: pending.to_stage,
            summary: pending.summary,
            requestedAt: pending.requested_at,
            expiresAt: pending.expires_at,
          }
        : null,
      lastTransition,
      questions: questions.map((question) => {
        const value = task.answers[question.id]?.trim()
        const recognized = value && question.options ? normalizeTaskAnswer(question.id, value) !== undefined : undefined
        return {
          id: question.id,
          prompt: question.label,
          required: true,
          answered: Boolean(value),
          ...(value ? { value } : {}),
          ...(recognized === undefined ? {} : { recognized }),
        }
      }),
      completed: task.status === 'done',
    }
    if (snapshot.templateId === 'onboarding' && snapshot.stage === 'review') {
      snapshot.profilePreview = buildOnboardingPreview(db, snapshot)
    }
    return snapshot
  }

  function getTransition(id: string): TaskTransitionRow | undefined {
    return db.prepare(`
      SELECT id, task_id, from_stage, to_stage, summary, requested_at, expires_at, outcome, resolved_at,
             requested_revision, resolved_revision, repeat_count
      FROM task_transitions
      WHERE id = ?
    `).get(id) as TaskTransitionRow | undefined
  }

  function getPendingTransition(taskId: string): TaskTransitionRow | undefined {
    return db.prepare(`
      SELECT id, task_id, from_stage, to_stage, summary, requested_at, expires_at, outcome, resolved_at,
             requested_revision, resolved_revision, repeat_count
      FROM task_transitions
      WHERE task_id = ? AND outcome IS NULL
      ORDER BY rowid DESC
      LIMIT 1
    `).get(taskId) as TaskTransitionRow | undefined
  }

  function conflict(
    sessionId: string,
    code: 'TRANSITION_PENDING' | 'NO_PENDING_TRANSITION' | 'STAGE_MISMATCH' | 'REVISION_CONFLICT' | 'PROFILE_PREVIEW_CONFLICT',
    message: string,
  ): TaskError {
    const snapshot = getSnapshot(sessionId) ?? undefined
    return new TaskError(code, message, snapshot?.allowedTransitions, undefined, snapshot)
  }

  function assertExpectedRevision(sessionId: string, expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return
    const snapshot = getSnapshot(sessionId)
    if (!snapshot || snapshot.revision !== expectedRevision) {
      throw conflict(sessionId, 'REVISION_CONFLICT', 'task revision does not match the current state')
    }
  }

  function normalizeActionInput(input: TransitionActionInput): Exclude<TransitionActionInput, string> {
    return typeof input === 'string' ? { stage: input } : input
  }

  function getRequired(sessionId: string): TaskState {
    const task = getForSession(sessionId)
    if (!task) throw new TaskError('NOT_FOUND', 'task was not found')
    return task
  }

  function assertActiveTurn(sessionId: string, turnId: string): void {
    if (!db.prepare("SELECT 1 FROM turns WHERE id = ? AND session_id = ? AND status = 'running'").get(turnId, sessionId)) {
      throw new TaskError('TURN_NOT_ACTIVE', 'task changes require the current running turn')
    }
  }

  function assertUserActionAllowed(sessionId: string): void {
    assertSession(sessionId)
    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as { status: string }
    if (session.status === 'running' || db.prepare("SELECT 1 FROM turns WHERE session_id = ? AND status = 'running'").get(sessionId)) {
      throw new TaskError('SESSION_RUNNING', 'task actions cannot be changed while the session is running')
    }
  }

  function updateTask(task: TaskState, patch: {
    stage?: string
    step?: string
    status?: TaskStatus
    pendingStage?: string | null
    pendingSummary?: string | null
    artifacts?: Record<string, string>
    answers?: Record<string, string>
  }): TaskState {
    const updatedAt = now()
    db.prepare(`
      UPDATE tasks
      SET stage = ?, step = ?, status = ?, pending_stage = ?, pending_summary = ?, artifacts_json = ?, answers_json = ?,
          revision = revision + 1, updated_at = ?
      WHERE id = ?
    `).run(
      patch.stage ?? task.stage,
      patch.step ?? task.step,
      patch.status ?? task.status,
      patch.pendingStage === undefined ? task.pendingStage ?? null : patch.pendingStage,
      patch.pendingSummary === undefined ? task.pendingSummary ?? null : patch.pendingSummary,
      JSON.stringify(patch.artifacts ?? task.artifacts),
      JSON.stringify(patch.answers ?? task.answers),
      updatedAt,
      task.id,
    )
    return getRequired(task.sessionId)
  }

  function resolveExpiredPending(task: TaskState): TaskState {
    const pending = getPendingTransition(task.id)
    if (!pending || Date.parse(pending.expires_at) > Date.now()) return task
    db.prepare(`
      UPDATE task_transitions
      SET outcome = 'expired', resolved_at = expires_at, resolved_revision = ?
      WHERE id = ? AND outcome IS NULL
    `).run((getRowForSession(task.sessionId)?.revision ?? 0) + 1, pending.id)
    return updateTask(task, { pendingStage: null, pendingSummary: null })
  }

  function start(sessionId: string, input: unknown): TaskState {
    return transaction(() => {
      assertUserActionAllowed(sessionId)
      if (!isRecord(input) || Object.keys(input).length !== 2 || typeof input.templateId !== 'string') {
        throw new TaskError('INVALID_INPUT', 'task start requires templateId and goal')
      }
      const template = getTaskTemplate(input.templateId)
      if (!template) throw new TaskError('INVALID_INPUT', `unknown task template: ${input.templateId}`)
      const goal = validateGoal(input.goal)
      const existing = db.prepare("SELECT 1 FROM tasks WHERE session_id = ? AND status IN ('active', 'paused')").get(sessionId)
      if (existing) throw new TaskError('TASK_EXISTS', 'session already has an open task')
      const timestamp = now()
      const id = randomUUID()
      db.prepare(`
        INSERT INTO tasks (id, session_id, template_id, goal, stage, step, status, artifacts_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '', 'active', '{}', ?, ?)
      `).run(id, sessionId, template.id, goal, template.stages[0]!.id, timestamp, timestamp)
      return getRequired(sessionId)
    })
  }

  function requestTransition(
    sessionId: string,
    input: { to: string; summary: string; expectedRevision?: number },
    options: { turnId: string },
  ): TaskSnapshot {
    return transaction(() => {
      assertActiveTurn(sessionId, options.turnId)
      let task = getRequired(sessionId)
      const summary = validateSummary(input.summary)
      const pending = getPendingTransition(task.id)
      if (pending && Date.parse(pending.expires_at) > Date.now()) {
        if (pending.to_stage === input.to && pending.summary === summary) {
          db.prepare('UPDATE task_transitions SET repeat_count = repeat_count + 1 WHERE id = ?').run(pending.id)
          return getSnapshot(sessionId)!
        }
        throw conflict(sessionId, 'TRANSITION_PENDING', 'task already has a pending transition')
      }
      assertExpectedRevision(sessionId, input.expectedRevision)
      task = resolveExpiredPending(task)
      if (task.status === 'done' || task.status === 'cancelled') throw new TaskError('TASK_FINISHED', 'task is already finished')
      if (task.status === 'paused') throw new TaskError('TASK_PAUSED', 'task is paused')
      if (task.stage === input.to) return getSnapshot(sessionId)!
      assertTransition(task, input.to, summary)
      const requestedAt = now()
      const expiresAt = new Date(Date.parse(requestedAt) + PENDING_TRANSITION_TTL_MS).toISOString()
      const pendingTransitionId = randomUUID()
      const requestedRevision = (getRowForSession(sessionId)?.revision ?? 0) + 1
      db.prepare(`
        INSERT INTO task_transitions
          (id, task_id, from_stage, to_stage, summary, requested_at, expires_at, requested_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(pendingTransitionId, task.id, task.stage, input.to, summary, requestedAt, expiresAt, requestedRevision)
      updateTask(task, { pendingStage: input.to, pendingSummary: summary })
      return getSnapshot(sessionId)!
    })
  }

  function recordAnswer(sessionId: string, input: { questionId: string; answer: string }, options: { turnId: string }): TaskState {
    return transaction(() => {
      assertActiveTurn(sessionId, options.turnId)
      const task = resolveExpiredPending(getRequired(sessionId))
      if (task.status === 'done' || task.status === 'cancelled') {
        throw new TaskError('TASK_FINISHED', 'task is already finished')
      }
      if (task.status === 'paused') throw new TaskError('TASK_PAUSED', 'task is paused')
      if (task.pendingStage !== undefined) {
        throw new TaskError('TRANSITION_PENDING', 'task already has a pending transition')
      }
      const question = getTaskStage(task)?.questions?.find(candidate => candidate.id === input.questionId)
      if (!question) throw new TaskError('INVALID_INPUT', 'unknown question for the current stage')
      const answer = validateAnswer(input.answer)
      return updateTask(task, { answers: { ...task.answers, [question.id]: answer } })
    })
  }

  function amendAnswer(
    sessionId: string,
    input: { questionId: string; answer: string; expectedRevision: number },
    options: { turnId: string },
  ): TaskSnapshot {
    return transaction(() => {
      assertActiveTurn(sessionId, options.turnId)
      let task = resolveExpiredPending(getRequired(sessionId))
      if (task.status === 'done' || task.status === 'cancelled') throw new TaskError('TASK_FINISHED', 'task is already finished')
      if (task.status === 'paused') throw new TaskError('TASK_PAUSED', 'task is paused')
      if (task.pendingStage !== undefined) throw conflict(sessionId, 'TRANSITION_PENDING', 'task already has a pending transition')
      if (task.templateId !== 'onboarding' || task.stage !== 'review') {
        throw new TaskError('INVALID_INPUT', 'answers can only be amended during onboarding review')
      }
      assertExpectedRevision(sessionId, input.expectedRevision)
      task = getRequired(sessionId)
      const question = getTemplateQuestions(task.templateId).find(candidate => candidate.id === input.questionId)
      if (!question) throw new TaskError('INVALID_INPUT', 'unknown onboarding question')
      const answer = validateAnswer(input.answer)
      updateTask(task, { answers: { ...task.answers, [question.id]: answer } })
      return getSnapshot(sessionId)!
    })
  }

  function saveAnswers(
    sessionId: string,
    input: { answers: Record<string, string>; expectedRevision: number },
  ): TaskSnapshot {
    return transaction(() => {
      assertUserActionAllowed(sessionId)
      let task = resolveExpiredPending(getRequired(sessionId))
      if (task.status === 'done' || task.status === 'cancelled') throw new TaskError('TASK_FINISHED', 'task is already finished')
      if (task.status === 'paused') throw new TaskError('TASK_PAUSED', 'task is paused')
      if (task.pendingStage !== undefined) throw conflict(sessionId, 'TRANSITION_PENDING', 'task already has a pending transition')
      if (task.templateId !== 'onboarding' || !['interview', 'review'].includes(task.stage)) {
        throw new TaskError('INVALID_INPUT', 'bulk answers are only available during onboarding')
      }
      assertExpectedRevision(sessionId, input.expectedRevision)
      const questions = getTemplateQuestions(task.templateId)
      const expectedIds = questions.map(question => question.id)
      if (!isRecord(input.answers)
        || Object.keys(input.answers).length !== expectedIds.length
        || Object.keys(input.answers).some(id => !expectedIds.includes(id))) {
        throw new TaskError('INVALID_INPUT', 'bulk answers must contain every onboarding question exactly once')
      }
      const answers = Object.fromEntries(questions.map((question) => {
        const answer = validateAnswer(input.answers[question.id])
        if (question.options && !question.options.some(option => option.value === answer)) {
          throw new TaskError('INVALID_INPUT', `${question.id} must be one of: ${question.options.map(option => option.value).join(', ')}`)
        }
        return [question.id, answer]
      }))
      task = getRequired(sessionId)
      updateTask(task, { answers })
      return getSnapshot(sessionId)!
    })
  }

  function updateStep(sessionId: string, step: unknown, options: { turnId: string }): TaskState {
    return transaction(() => {
      assertActiveTurn(sessionId, options.turnId)
      const task = resolveExpiredPending(getRequired(sessionId))
      if (task.status === 'paused') throw new TaskError('TASK_PAUSED', 'task is paused')
      if (task.status === 'done' || task.status === 'cancelled') throw new TaskError('TASK_FINISHED', 'task is already finished')
      return updateTask(task, { step: validateStep(step) })
    })
  }

  function approve(sessionId: string, input: TransitionActionInput): TaskSnapshot {
    return transaction(() => {
      assertUserActionAllowed(sessionId)
      const action = normalizeActionInput(input)
      if (action.pendingTransitionId) {
        const previous = getTransition(action.pendingTransitionId)
        if (previous?.outcome === 'approved') return getSnapshot(sessionId)!
        if (previous?.outcome !== null && previous !== undefined) {
          throw conflict(sessionId, 'STAGE_MISMATCH', 'transition was resolved with a different outcome')
        }
      }
      let task = getRequired(sessionId)
      assertExpectedRevision(sessionId, action.expectedRevision)
      task = resolveExpiredPending(task)
      const pending = getPendingTransition(task.id)
      if (!pending || task.pendingStage === undefined || task.pendingSummary === undefined) {
        throw conflict(sessionId, 'NO_PENDING_TRANSITION', 'task has no pending transition')
      }
      if (action.pendingTransitionId && action.pendingTransitionId !== pending.id) {
        throw conflict(sessionId, 'STAGE_MISMATCH', 'requested transition does not match the pending transition')
      }
      if (action.stage && action.stage !== pending.to_stage) {
        throw conflict(sessionId, 'STAGE_MISMATCH', 'requested stage does not match the pending transition')
      }
      // Re-run the same guard against a transition-shaped snapshot. The pending
      // marker itself is intentionally removed so approval can pass the guard.
      const stage = pending.to_stage
      const pendingSummary = pending.summary
      const candidate: TaskState = { ...task, pendingStage: undefined, pendingSummary: undefined }
      assertTransition(candidate, stage, pendingSummary)
      const artifacts = { ...task.artifacts, [task.stage]: pendingSummary }
      const terminal = getTaskStage({ templateId: task.templateId, stage })?.next.length === 0
      if (terminal && task.templateId === 'onboarding') {
        const preview = buildOnboardingPreview(db, getSnapshot(sessionId)!)
        if (action.expectedProfileName !== undefined && action.expectedProfileName !== preview.name) {
          throw conflict(sessionId, 'PROFILE_PREVIEW_CONFLICT', 'onboarding profile preview changed; confirm the updated preview')
        }
        completeOnboarding(db, task, preview)
      }
      db.prepare(`
        UPDATE task_transitions
        SET outcome = 'approved', resolved_at = ?, resolved_revision = ?
        WHERE id = ? AND outcome IS NULL
      `).run(now(), (getRowForSession(sessionId)?.revision ?? 0) + 1, pending.id)
      updateTask(task, {
        stage,
        step: '',
        status: terminal ? 'done' : 'active',
        pendingStage: null,
        pendingSummary: null,
        artifacts,
      })
      return getSnapshot(sessionId)!
    })
  }

  function reject(sessionId: string, input: TransitionActionInput): TaskSnapshot {
    return transaction(() => {
      assertUserActionAllowed(sessionId)
      const action = normalizeActionInput(input)
      if (action.pendingTransitionId) {
        const previous = getTransition(action.pendingTransitionId)
        if (previous?.outcome === 'rejected') return getSnapshot(sessionId)!
        if (previous?.outcome !== null && previous !== undefined) {
          throw conflict(sessionId, 'STAGE_MISMATCH', 'transition was resolved with a different outcome')
        }
      }
      let task = getRequired(sessionId)
      assertExpectedRevision(sessionId, action.expectedRevision)
      task = resolveExpiredPending(task)
      const pending = getPendingTransition(task.id)
      if (!pending || task.pendingStage === undefined) throw conflict(sessionId, 'NO_PENDING_TRANSITION', 'task has no pending transition')
      if (action.pendingTransitionId && action.pendingTransitionId !== pending.id) {
        throw conflict(sessionId, 'STAGE_MISMATCH', 'requested transition does not match the pending transition')
      }
      if (action.stage && action.stage !== pending.to_stage) {
        throw conflict(sessionId, 'STAGE_MISMATCH', 'requested stage does not match the pending transition')
      }
      db.prepare(`
        UPDATE task_transitions
        SET outcome = 'rejected', resolved_at = ?, resolved_revision = ?
        WHERE id = ? AND outcome IS NULL
      `).run(now(), (getRowForSession(sessionId)?.revision ?? 0) + 1, pending.id)
      updateTask(task, { pendingStage: null, pendingSummary: null })
      return getSnapshot(sessionId)!
    })
  }

  function cancelPending(sessionId: string, pendingTransitionId: string, options: { turnId: string }): TaskSnapshot {
    return transaction(() => {
      assertActiveTurn(sessionId, options.turnId)
      const task = resolveExpiredPending(getRequired(sessionId))
      const previous = getTransition(pendingTransitionId)
      if (previous?.outcome === 'cancelled') return getSnapshot(sessionId)!
      const pending = getPendingTransition(task.id)
      if (!pending || pending.id !== pendingTransitionId) {
        throw conflict(sessionId, 'STAGE_MISMATCH', 'requested transition does not match the pending transition')
      }
      db.prepare(`
        UPDATE task_transitions
        SET outcome = 'cancelled', resolved_at = ?, resolved_revision = ?
        WHERE id = ? AND outcome IS NULL
      `).run(now(), (getRowForSession(sessionId)?.revision ?? 0) + 1, pending.id)
      updateTask(task, { pendingStage: null, pendingSummary: null })
      return getSnapshot(sessionId)!
    })
  }

  function pause(sessionId: string): TaskState {
    return transaction(() => {
      assertUserActionAllowed(sessionId)
      const task = resolveExpiredPending(getRequired(sessionId))
      if (task.status === 'done' || task.status === 'cancelled') throw new TaskError('TASK_FINISHED', 'task is already finished')
      if (task.status === 'paused') throw new TaskError('TASK_PAUSED', 'task is already paused')
      return updateTask(task, { status: 'paused' })
    })
  }

  function resume(sessionId: string): TaskState {
    return transaction(() => {
      assertUserActionAllowed(sessionId)
      const task = resolveExpiredPending(getRequired(sessionId))
      if (task.status === 'done' || task.status === 'cancelled') throw new TaskError('TASK_FINISHED', 'task is already finished')
      if (task.status !== 'paused') throw new TaskError('INVALID_INPUT', 'task is not paused')
      return updateTask(task, { status: 'active' })
    })
  }

  function cancel(sessionId: string): TaskState {
    return transaction(() => {
      assertUserActionAllowed(sessionId)
      const task = resolveExpiredPending(getRequired(sessionId))
      if (task.status === 'done' || task.status === 'cancelled') throw new TaskError('TASK_FINISHED', 'task is already finished')
      const pending = getPendingTransition(task.id)
      if (pending) {
        db.prepare(`
          UPDATE task_transitions
          SET outcome = 'cancelled', resolved_at = ?, resolved_revision = ?
          WHERE id = ? AND outcome IS NULL
        `).run(now(), (getRowForSession(sessionId)?.revision ?? 0) + 1, pending.id)
      }
      return updateTask(task, { status: 'cancelled', pendingStage: null, pendingSummary: null })
    })
  }

  return {
    getForSession,
    getSnapshot,
    start,
    requestTransition,
    recordAnswer,
    amendAnswer,
    saveAnswers,
    updateStep,
    approve,
    reject,
    cancelPending,
    pause,
    resume,
    cancel,
  }
}
