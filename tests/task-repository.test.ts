import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTaskRepository } from '../server/persistence/task-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { createTaskMetrics } from '../server/tasks/metrics'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createWorkingMemoryRepository } from '../server/memory/working-repository'
import { createLongTermMemoryRepository } from '../server/memory/long-term-repository'
import { listMemoryChanges } from '../server/memory/change-log'
import { TASK_TEMPLATES, type TaskState } from '../shared/task'

const databases: ReturnType<typeof openChatDatabase>[] = []
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  const index = TASK_TEMPLATES.findIndex(template => template.id === 'release-test')
  if (index >= 0) TASK_TEMPLATES.splice(index, 1)
})

function createDb() {
  const db = openChatDatabase(':memory:')
  databases.push(db)
  return db
}

function startTask(db: ReturnType<typeof createDb>, sessionId: string, templateId = 'dev') {
  return createTaskRepository(db).start(sessionId, { templateId, goal: 'Сделать отчёт' })
}

function reserveTurn(db: ReturnType<typeof createDb>, sessionId: string): string {
  const requestId = randomUUID()
  return createTurnRepository(db).beginUserTurn({
    sessionId,
    requestId,
    modelId: 'mock-model',
    message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Работаем над задачей' }] },
    agentConfig: {},
  }).turnId
}

function finishTurn(db: ReturnType<typeof createDb>, turnId: string): void {
  createTurnRepository(db).finishTurn({
    turnId,
    message: { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Готово' }] },
    status: 'completed',
  })
}

const onboardingAnswers = {
  name: 'Игорь',
  role: 'Разработчик',
  goal: 'Учёба',
  level: 'средний',
  style: 'кратко',
}

function startOnboardingReview(db: ReturnType<typeof createDb>, sessionId: string) {
  const tasks = createTaskRepository(db)
  startTask(db, sessionId, 'onboarding')
  const interviewTurn = reserveTurn(db, sessionId)
  for (const [questionId, answer] of Object.entries(onboardingAnswers)) {
    tasks.recordAnswer(sessionId, { questionId, answer }, { turnId: interviewTurn })
  }
  const pending = tasks.requestTransition(sessionId, { to: 'review', summary: 'Ответы собраны' }, { turnId: interviewTurn })
  finishTurn(db, interviewTurn)
  return tasks.approve(sessionId, {
    pendingTransitionId: pending.pendingTransition!.id,
    expectedRevision: pending.revision,
  })
}

describe('task repository', () => {
  it('starts a task and permits only one open task per session', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)

    expect(startTask(db, session.id)).toMatchObject({ sessionId: session.id, templateId: 'dev', stage: 'planning', status: 'active' })
    expect(() => startTask(db, session.id)).toThrowError(expect.objectContaining({ code: 'TASK_EXISTS' }))
    expect(tasks.getForSession(session.id)?.goal).toBe('Сделать отчёт')
  })

  it('records an agent proposal and applies it on user approval with the stage artifact', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id)
    const turnId = reserveTurn(db, session.id)

    expect(tasks.requestTransition(session.id, { to: 'execution', summary: 'План: собрать данные и записать отчёт' }, { turnId }))
      .toMatchObject({ pendingStage: 'execution', pendingSummary: 'План: собрать данные и записать отчёт' })
    finishTurn(db, turnId)

    const approved = tasks.approve(session.id, 'execution')
    expect(approved).toMatchObject({ stage: 'execution', step: '' })
    expect(approved).not.toHaveProperty('pendingStage')
    expect(tasks.getForSession(session.id)?.artifacts).toEqual({ planning: 'План: собрать данные и записать отчёт' })
  })

  it('reuses an identical pending request and refuses a competing request', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id)
    const turnId = reserveTurn(db, session.id)

    const first = tasks.requestTransition(session.id, {
      to: 'execution',
      summary: 'План готов',
      expectedRevision: 0,
    }, { turnId })
    const repeated = tasks.requestTransition(session.id, {
      to: 'execution',
      summary: 'План готов',
      expectedRevision: 0,
    }, { turnId })

    expect(repeated.pendingTransition?.id).toBe(first.pendingTransition?.id)
    expect(repeated.revision).toBe(first.revision)
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_transitions').get()).toEqual({ count: 1 })
    expect(createTaskMetrics(db).summarize(first.id)).toMatchObject({
      requestedCount: 1,
      repeatedRequestCount: 1,
      repeatRequestRate: 0.5,
    })
    expect(() => tasks.requestTransition(session.id, {
      to: 'execution',
      summary: 'Другой план',
      expectedRevision: first.revision,
    }, { turnId })).toThrowError(expect.objectContaining({
      code: 'TRANSITION_PENDING',
      snapshot: expect.objectContaining({ pendingTransition: expect.objectContaining({ id: first.pendingTransition?.id }) }),
    }))
    finishTurn(db, turnId)
  })

  it('treats a request for the current stage as already applied', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id)
    const firstTurn = reserveTurn(db, session.id)
    const pending = tasks.requestTransition(session.id, { to: 'execution', summary: 'План' }, { turnId: firstTurn })
    finishTurn(db, firstTurn)
    tasks.approve(session.id, {
      pendingTransitionId: pending.pendingTransition!.id,
      expectedRevision: pending.revision,
    })
    const probeTurn = reserveTurn(db, session.id)

    const probed = tasks.requestTransition(session.id, {
      to: 'execution',
      summary: 'Проверяю этап',
      expectedRevision: 2,
    }, { turnId: probeTurn })

    expect(probed).toMatchObject({ stage: 'execution', revision: 2, pendingTransition: null })
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_transitions').get()).toEqual({ count: 1 })
    finishTurn(db, probeTurn)
  })

  it('makes approval idempotent by transition id and rejects stale concurrency data', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id)
    const turnId = reserveTurn(db, session.id)
    const pending = tasks.requestTransition(session.id, { to: 'execution', summary: 'План' }, { turnId })
    finishTurn(db, turnId)
    const pendingId = pending.pendingTransition!.id

    expect(() => tasks.approve(session.id, {
      pendingTransitionId: randomUUID(),
      expectedRevision: pending.revision,
    })).toThrowError(expect.objectContaining({ code: 'STAGE_MISMATCH', snapshot: expect.any(Object) }))
    expect(() => tasks.approve(session.id, {
      pendingTransitionId: pendingId,
      expectedRevision: pending.revision - 1,
    })).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT', snapshot: expect.any(Object) }))

    const approved = tasks.approve(session.id, {
      pendingTransitionId: pendingId,
      expectedRevision: pending.revision,
    })
    const repeated = tasks.approve(session.id, {
      pendingTransitionId: pendingId,
      expectedRevision: pending.revision,
    })

    expect(approved).toMatchObject({ stage: 'execution', revision: 2, lastTransition: { id: pendingId, outcome: 'approved' } })
    expect(repeated).toEqual(approved)
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_transitions WHERE outcome = 'approved'").get()).toEqual({ count: 1 })
    expect(createTaskMetrics(db).listEvents(approved.id)).toEqual([
      expect.objectContaining({ taskId: approved.id, pendingTransitionId: pendingId, action: 'requested', revision: 1 }),
      expect.objectContaining({ taskId: approved.id, pendingTransitionId: pendingId, action: 'approved', revision: 2 }),
    ])
  })

  it('rebuilds transition timing and outcome metrics after reopening the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'task-metrics-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'chat.sqlite')
    const db = openChatDatabase(filePath)
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id)
    const turnId = reserveTurn(db, session.id)
    const pending = tasks.requestTransition(session.id, { to: 'execution', summary: 'План' }, { turnId })
    const requestedAt = new Date(Date.now() - 60_000).toISOString()
    db.prepare('UPDATE task_transitions SET requested_at = ? WHERE id = ?').run(requestedAt, pending.pendingTransition!.id)
    finishTurn(db, turnId)
    const rejected = tasks.reject(session.id, {
      pendingTransitionId: pending.pendingTransition!.id,
      expectedRevision: pending.revision,
    })
    db.close()

    const reopened = openChatDatabase(filePath)
    const metrics = createTaskMetrics(reopened)
    const events = metrics.listEvents(rejected.id)
    const summary = metrics.summarize(rejected.id)

    expect(events).toEqual([
      expect.objectContaining({ action: 'requested', at: requestedAt, revision: 1 }),
      expect.objectContaining({ action: 'rejected', revision: 2 }),
    ])
    expect(summary.confirmationCount).toBe(1)
    expect(summary.averageConfirmationWaitMs).toBe(Date.parse(events[1]!.at) - Date.parse(requestedAt))
    expect(summary.turnCount).toBe(1)
    reopened.close()
  })

  it('expires a stale pending request on the next mutation and creates a replacement', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id)
    const turnId = reserveTurn(db, session.id)
    const first = tasks.requestTransition(session.id, { to: 'execution', summary: 'Старый план' }, { turnId })
    const firstId = first.pendingTransition!.id
    db.prepare("UPDATE task_transitions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(firstId)

    const replacement = tasks.requestTransition(session.id, {
      to: 'execution',
      summary: 'Новый план',
      expectedRevision: first.revision,
    }, { turnId })

    expect(replacement.pendingTransition).toMatchObject({ to: 'execution', summary: 'Новый план' })
    expect(replacement.pendingTransition?.id).not.toBe(firstId)
    expect(db.prepare('SELECT outcome, resolved_at FROM task_transitions WHERE id = ?').get(firstId)).toEqual({
      outcome: 'expired',
      resolved_at: '2020-01-01T00:00:00.000Z',
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_transitions').get()).toEqual({ count: 2 })
    finishTurn(db, turnId)
  })

  it('records answers only for questions of the current stage', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id, 'onboarding')
    const turnId = reserveTurn(db, session.id)

    expect(() => tasks.recordAnswer(session.id, { questionId: 'age', answer: '30' }, { turnId }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => tasks.recordAnswer(session.id, { questionId: 'name', answer: '   ' }, { turnId }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => tasks.recordAnswer(session.id, { questionId: 'name', answer: 'x'.repeat(501) }, { turnId }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(tasks.recordAnswer(session.id, { questionId: 'name', answer: '  Игорь ' }, { turnId }).answers).toEqual({ name: 'Игорь' })
    finishTurn(db, turnId)
  })

  it('amends one answer on review without rolling back or losing other answers', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    const review = startOnboardingReview(db, session.id)
    const turnId = reserveTurn(db, session.id)

    const amended = tasks.amendAnswer(session.id, {
      questionId: 'style',
      answer: 'подробно',
      expectedRevision: review.revision,
    }, { turnId })

    expect(amended).toMatchObject({
      stage: 'review',
      revision: review.revision + 1,
      answers: { ...onboardingAnswers, style: 'подробно' },
      profilePreview: {
        name: 'Профиль - Игорь',
        instructions: expect.stringContaining('Стиль ответов - подробно'),
        taskRevision: review.revision + 1,
      },
    })
    finishTurn(db, turnId)
  })

  it('saves all onboarding answers atomically with canonical enum values', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id, 'onboarding')

    const saved = tasks.saveAnswers(session.id, {
      answers: {
        name: 'Игорь',
        role: 'Разработчик',
        goal: 'Учёба',
        level: 'intermediate',
        style: 'brief',
      },
      expectedRevision: 0,
    })

    expect(saved).toMatchObject({
      revision: 1,
      answers: { name: 'Игорь', role: 'Разработчик', goal: 'Учёба', level: 'intermediate', style: 'brief' },
    })
  })

  it('rejects an invalid bulk enum without changing any answer', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id, 'onboarding')
    const before = tasks.getSnapshot(session.id)

    expect(() => tasks.saveAnswers(session.id, {
      answers: { name: 'Игорь', role: 'Разработчик', goal: 'Учёба', level: 'продвинутый', style: 'brief' },
      expectedRevision: 0,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(tasks.getSnapshot(session.id)).toEqual(before)
  })

  it('keeps unknown legacy enum text unchanged and marks it for review', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id, 'onboarding')
    const turnId = reserveTurn(db, session.id)
    tasks.recordAnswer(session.id, { questionId: 'level', answer: 'Почти эксперт' }, { turnId })

    expect(tasks.getSnapshot(session.id)).toMatchObject({
      answers: { level: 'Почти эксперт' },
      questions: expect.arrayContaining([
        expect.objectContaining({ id: 'level', value: 'Почти эксперт', recognized: false }),
      ]),
    })
    finishTurn(db, turnId)
  })

  it('rejects answer amendments while a transition is pending', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    const review = startOnboardingReview(db, session.id)
    const turnId = reserveTurn(db, session.id)
    const pending = tasks.requestTransition(session.id, {
      to: 'done',
      summary: 'Профиль готов',
      expectedRevision: review.revision,
    }, { turnId })

    expect(() => tasks.amendAnswer(session.id, {
      questionId: 'name',
      answer: 'Новое имя',
      expectedRevision: pending.revision,
    }, { turnId })).toThrowError(expect.objectContaining({ code: 'TRANSITION_PENDING' }))
    finishTurn(db, turnId)
  })

  it('returns a complete read-only snapshot of questionnaire state', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    const started = startTask(db, session.id, 'onboarding')
    const turnId = reserveTurn(db, session.id)
    tasks.recordAnswer(session.id, { questionId: 'name', answer: 'Игорь' }, { turnId })
    tasks.recordAnswer(session.id, { questionId: 'role', answer: 'Разработчик' }, { turnId })
    finishTurn(db, turnId)
    const before = db.prepare('SELECT revision, updated_at FROM tasks WHERE id = ?').get(started.id)

    const first = tasks.getSnapshot(session.id)
    const second = tasks.getSnapshot(session.id)

    expect(first).toMatchObject({
      id: started.id,
      stage: 'interview',
      status: 'active',
      revision: 2,
      allowedTransitions: ['review'],
      pendingTransition: null,
      lastTransition: null,
      completed: false,
      questions: [
        { id: 'name', prompt: 'Как к вам обращаться?', required: true, answered: true, value: 'Игорь' },
        { id: 'role', prompt: 'Чем вы занимаетесь?', required: true, answered: true, value: 'Разработчик' },
        { id: 'goal', prompt: expect.any(String), required: true, answered: false },
        { id: 'level', prompt: expect.any(String), required: true, answered: false },
        { id: 'style', prompt: expect.any(String), required: true, answered: false },
      ],
    })
    expect(second).toEqual(first)
    expect(db.prepare('SELECT revision, updated_at FROM tasks WHERE id = ?').get(started.id)).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_transitions').get()).toEqual({ count: 0 })
  })

  it('rejects answers while paused, pending, finished, or outside the running turn', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id, 'onboarding')

    expect(() => tasks.recordAnswer(session.id, { questionId: 'name', answer: 'Игорь' }, { turnId: randomUUID() }))
      .toThrowError(expect.objectContaining({ code: 'TURN_NOT_ACTIVE' }))

    const firstTurn = reserveTurn(db, session.id)
    finishTurn(db, firstTurn)
    tasks.pause(session.id)
    const pausedTurn = reserveTurn(db, session.id)
    expect(() => tasks.recordAnswer(session.id, { questionId: 'name', answer: 'Игорь' }, { turnId: pausedTurn }))
      .toThrowError(expect.objectContaining({ code: 'TASK_PAUSED' }))
    finishTurn(db, pausedTurn)

    tasks.resume(session.id)
    const pendingTurn = reserveTurn(db, session.id)
    for (const [questionId, answer] of Object.entries(onboardingAnswers)) {
      tasks.recordAnswer(session.id, { questionId, answer }, { turnId: pendingTurn })
    }
    tasks.requestTransition(session.id, { to: 'review', summary: 'Ответы собраны' }, { turnId: pendingTurn })
    expect(() => tasks.recordAnswer(session.id, { questionId: 'name', answer: 'Новое имя' }, { turnId: pendingTurn }))
      .toThrowError(expect.objectContaining({ code: 'TRANSITION_PENDING' }))
    finishTurn(db, pendingTurn)

    tasks.cancel(session.id)
    const finishedTurn = reserveTurn(db, session.id)
    expect(() => tasks.recordAnswer(session.id, { questionId: 'name', answer: 'Ещё имя' }, { turnId: finishedTurn }))
      .toThrowError(expect.objectContaining({ code: 'TASK_FINISHED' }))
    finishTurn(db, finishedTurn)
  })

  it('refuses interview to review until all answers are saved', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id, 'onboarding')
    const turnId = reserveTurn(db, session.id)
    tasks.recordAnswer(session.id, { questionId: 'name', answer: 'Игорь' }, { turnId })
    tasks.recordAnswer(session.id, { questionId: 'role', answer: 'Разработчик' }, { turnId })
    expect(() => tasks.requestTransition(session.id, { to: 'review', summary: 'Готово' }, { turnId }))
      .toThrowError(expect.objectContaining({ code: 'ANSWERS_MISSING', missing: ['goal', 'level', 'style'] }))
    expect(tasks.getForSession(session.id)).not.toHaveProperty('pendingStage')
    finishTurn(db, turnId)
  })

  it('rejects a proposal without changing the current stage', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id)
    const turnId = reserveTurn(db, session.id)
    tasks.requestTransition(session.id, { to: 'execution', summary: 'План' }, { turnId })
    finishTurn(db, turnId)

    const rejected = tasks.reject(session.id, 'execution')
    expect(rejected).toMatchObject({ stage: 'planning' })
    expect(rejected).not.toHaveProperty('pendingStage')
  })

  it('preserves a pending proposal across pause and resume', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id)
    const turnId = reserveTurn(db, session.id)
    tasks.requestTransition(session.id, { to: 'execution', summary: 'План сохраняется' }, { turnId })
    finishTurn(db, turnId)

    expect(tasks.pause(session.id)).toMatchObject({ status: 'paused', pendingStage: 'execution' })
    expect(tasks.resume(session.id)).toMatchObject({ status: 'active', pendingStage: 'execution', pendingSummary: 'План сохраняется' })
  })

  it('validates approval stage and missing proposals', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id)

    expect(() => tasks.approve(session.id, 'execution')).toThrowError(expect.objectContaining({ code: 'NO_PENDING_TRANSITION' }))
    const turnId = reserveTurn(db, session.id)
    tasks.requestTransition(session.id, { to: 'execution', summary: 'План' }, { turnId })
    finishTurn(db, turnId)
    expect(() => tasks.approve(session.id, 'validation')).toThrowError(expect.objectContaining({ code: 'STAGE_MISMATCH' }))
  })

  it('pauses and resumes an open task on each stage', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    const current = startTask(db, session.id)

    for (const stage of ['planning', 'execution', 'validation'] as const) {
      const paused = tasks.pause(session.id)
      expect(paused).toMatchObject({ stage, status: 'paused' })
      expect(tasks.resume(session.id)).toMatchObject({ stage, status: 'active' })
      if (stage !== 'validation') {
        const turnId = reserveTurn(db, session.id)
        tasks.requestTransition(session.id, {
          to: stage === 'planning' ? 'execution' : 'validation',
          summary: `Переход из ${stage}`,
        }, { turnId })
        finishTurn(db, turnId)
        tasks.approve(session.id, stage === 'planning' ? 'execution' : 'validation')
      }
    }
    expect(current.id).toBe(tasks.getForSession(session.id)?.id)
  })

  it('rejects user actions during a running turn and agent actions without its active turn', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id)
    const turnId = reserveTurn(db, session.id)

    expect(() => tasks.pause(session.id)).toThrowError(expect.objectContaining({ code: 'SESSION_RUNNING' }))
    expect(() => tasks.requestTransition(session.id, { to: 'execution', summary: 'План' }, { turnId: randomUUID() }))
      .toThrowError(expect.objectContaining({ code: 'TURN_NOT_ACTIVE' }))
    finishTurn(db, turnId)
  })

  it('does not start a task while a chat turn is running', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const turnId = reserveTurn(db, session.id)
    const tasks = createTaskRepository(db)

    expect(() => tasks.start(session.id, { templateId: 'dev', goal: 'Занятая задача' })).toThrowError(
      expect.objectContaining({ code: 'SESSION_RUNNING' }),
    )
    finishTurn(db, turnId)
  })

  it('cascades tasks when a session is deleted', () => {
    const db = createDb()
    const sessions = createSessionRepository(db)
    const session = sessions.createSession()
    startTask(db, session.id)
    sessions.deleteSession(session.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
  })

  it('cancels a task and allows a later task to start', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    tasks.start(session.id, { templateId: 'dev', goal: 'Первая' })
    expect(tasks.cancel(session.id).status).toBe('cancelled')
    expect(tasks.start(session.id, { templateId: 'bugfix', goal: 'Вторая' })).toMatchObject({ templateId: 'bugfix', status: 'active' })
  })

  it.each([
    { target: 'done', status: 'done' },
    { target: 'execution', status: 'active' },
  ] as const)('sets validation → $target to $status', ({ target, status }) => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    startTask(db, session.id)

    const planningTurnId = reserveTurn(db, session.id)
    tasks.requestTransition(session.id, { to: 'execution', summary: 'План готов' }, { turnId: planningTurnId })
    finishTurn(db, planningTurnId)
    tasks.approve(session.id, 'execution')

    const executionTurnId = reserveTurn(db, session.id)
    tasks.requestTransition(session.id, { to: 'validation', summary: 'Реализация готова' }, { turnId: executionTurnId })
    finishTurn(db, executionTurnId)
    tasks.approve(session.id, 'validation')

    const validationTurnId = reserveTurn(db, session.id)
    tasks.requestTransition(session.id, { to: target, summary: 'Проверка завершена' }, { turnId: validationTurnId })
    finishTurn(db, validationTurnId)

    expect(tasks.approve(session.id, target)).toMatchObject({ stage: target, status })
  })

  it('marks a transition to a custom terminal stage as done', () => {
    TASK_TEMPLATES.push({
      id: 'release-test',
      name: 'Release test',
      stages: [
        { id: 'draft', title: 'Draft', agentAction: 'Draft', next: ['released'] },
        { id: 'released', title: 'Released', agentAction: '', next: [] },
      ],
    })
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    tasks.start(session.id, { templateId: 'release-test', goal: 'Выпустить' })
    const turnId = reserveTurn(db, session.id)
    tasks.requestTransition(session.id, { to: 'released', summary: 'Релиз готов' }, { turnId })
    finishTurn(db, turnId)

    expect(tasks.approve(session.id, 'released')).toMatchObject({ stage: 'released', status: 'done' })
  })

  it('cleans project working memory on done and cancelled tasks but keeps long-term facts', () => {
    TASK_TEMPLATES.push({
      id: 'memory-cleanup-test',
      name: 'Memory cleanup test',
      stages: [
        { id: 'draft', title: 'Draft', agentAction: 'Draft', next: ['released'] },
        { id: 'released', title: 'Released', agentAction: '', next: [] },
      ],
    })
    const db = createDb()
    const project = createProjectRepository(db).create('Memory project')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    const tasks = createTaskRepository(db)
    const working = createWorkingMemoryRepository(db)
    const longTerm = createLongTermMemoryRepository(db)
    tasks.start(session.id, { templateId: 'memory-cleanup-test', goal: 'Проверить очистку' })
    working.create({ projectId: project.id, category: 'state', key: 'status', value: 'active' })
    const fact = longTerm.create({ category: 'decision', key: 'database', value: 'SQLite', projectIds: [project.id] })
    const turnId = reserveTurn(db, session.id)
    const pending = tasks.requestTransition(session.id, { to: 'released', summary: 'Готово' }, { turnId })
    finishTurn(db, turnId)

    expect(tasks.approve(session.id, { pendingTransitionId: pending.pendingTransition!.id, expectedRevision: pending.revision })).toMatchObject({ status: 'done' })
    expect(working.list(project.id).items).toEqual([])
    expect(longTerm.list({ projectId: project.id }).items).toEqual([fact])
    expect(listMemoryChanges(db, { projectId: project.id, limit: 10 })).toEqual([
      expect.objectContaining({ action: 'task_cleanup', oldValue: 'active', sourceSessionId: session.id }),
    ])

    const cancelledSession = createSessionRepository(db).createSession({ projectId: project.id })
    tasks.start(cancelledSession.id, { templateId: 'memory-cleanup-test', goal: 'Отменить' })
    working.create({ projectId: project.id, category: 'state', key: 'cancelled', value: 'yes' })
    expect(tasks.cancel(cancelledSession.id).status).toBe('cancelled')
    expect(working.list(project.id).items).toEqual([])
    expect(listMemoryChanges(db, { projectId: project.id, limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'task_cleanup', oldValue: 'yes', sourceSessionId: cancelledSession.id }),
    ]))
  })

  it('finishes a task without a project without touching memory or throwing', () => {
    const db = createDb()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    tasks.start(session.id, { templateId: 'dev', goal: 'Без проекта' })

    expect(tasks.cancel(session.id)).toMatchObject({ status: 'cancelled' })
  })
})
