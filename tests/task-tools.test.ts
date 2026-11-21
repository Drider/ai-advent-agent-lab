import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { createChatAgent } from '../server/agent/chat-agent'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTaskRepository } from '../server/persistence/task-repository'
import { createTaskTools } from '../server/tools/tasks'
import { createTurnRepository } from '../server/persistence/turn-repository'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function database() {
  const db = openChatDatabase(':memory:')
  databases.push(db)
  return db
}

function invoke(tool: any, input: unknown = {}) {
  if (!tool.execute) throw new Error('tool has no execute function')
  return tool.execute(input, { toolCallId: randomUUID(), messages: [], context: {} })
}

function reserveTurn(db: ReturnType<typeof database>, sessionId: string): string {
  const requestId = randomUUID()
  return createTurnRepository(db).beginUserTurn({
    sessionId,
    requestId,
    modelId: 'mock-model',
    message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'План' }] },
    agentConfig: {},
  }).turnId
}

function finishTurn(db: ReturnType<typeof database>, turnId: string): void {
  createTurnRepository(db).finishTurn({
    turnId,
    message: { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Готово' }] },
    status: 'completed',
  })
}

describe('task tools', () => {
  it('returns a structured transition error and leaves the database unchanged', async () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    createTaskRepository(db).start(session.id, { templateId: 'dev', goal: 'Отчёт' })
    const turnId = reserveTurn(db, session.id)
    const tools = createTaskTools({ db, sessionId: session.id, turnId })

    await expect(invoke(tools.request_task_transition, { to: 'done', summary: 'Сразу финал' })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'TRANSITION_NOT_ALLOWED',
        message: expect.any(String),
        allowedNext: ['execution'],
        allowedTransitions: ['execution'],
        task: { stage: 'planning', revision: 0 },
      },
    })
    expect(createTaskRepository(db).getForSession(session.id)).toMatchObject({ stage: 'planning' })
    expect(createTaskRepository(db).getForSession(session.id)).not.toHaveProperty('pendingStage')
    finishTurn(db, turnId)
  })

  it('updates the current step and requests a valid transition', async () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    createTaskRepository(db).start(session.id, { templateId: 'dev', goal: 'Отчёт' })
    const turnId = reserveTurn(db, session.id)
    const tools = createTaskTools({ db, sessionId: session.id, turnId })

    await expect(invoke(tools.update_task_step, { step: 'Собрать источники' })).resolves.toMatchObject({
      ok: true,
      step: 'Собрать источники',
      task: { step: 'Собрать источники', revision: 1 },
    })
    await expect(invoke(tools.request_task_transition, { to: 'execution', summary: 'План утверждения' })).resolves.toMatchObject({
      ok: true,
      applied: false,
      from: 'planning',
      to: 'execution',
      revision: 2,
      pendingTransitionId: expect.any(String),
      allowedTransitions: ['execution'],
      awaitingUserConfirmation: true,
      confirmationHint: { kind: 'button', label: 'Подтвердить', command: '/task approve' },
      task: { stage: 'planning', revision: 2, pendingTransition: { to: 'execution' } },
    })
  })

  it('returns the same pending transition for an identical request', async () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    createTaskRepository(db).start(session.id, { templateId: 'dev', goal: 'Отчёт' })
    const turnId = reserveTurn(db, session.id)
    const tools = createTaskTools({ db, sessionId: session.id, turnId })

    const first = await invoke(tools.request_task_transition, { to: 'execution', summary: 'План' }) as any
    const repeated = await invoke(tools.request_task_transition, {
      to: 'execution',
      summary: 'План',
      expectedRevision: 0,
    }) as any

    expect(repeated).toMatchObject({
      ok: true,
      applied: false,
      pendingTransitionId: first.pendingTransitionId,
      revision: first.revision,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_transitions').get()).toEqual({ count: 1 })
    finishTurn(db, turnId)
  })

  it('records an answer and reports remaining questions', async () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    createTaskRepository(db).start(session.id, { templateId: 'onboarding', goal: 'Знакомство' })
    const turnId = reserveTurn(db, session.id)
    const tools = createTaskTools({ db, sessionId: session.id, turnId })

    await expect(invoke(tools.record_task_answer, { questionId: 'name', answer: 'Игорь' })).resolves.toMatchObject({
      ok: true,
      questionId: 'name',
      recordedValue: 'Игорь',
      remainingCount: 4,
      remaining: ['role', 'goal', 'level', 'style'],
      task: {
        revision: 1,
        questions: expect.arrayContaining([
          expect.objectContaining({ id: 'name', answered: true, value: 'Игорь' }),
        ]),
      },
    })
    finishTurn(db, turnId)
  })

  it('normalizes only unambiguous typed questionnaire answers', async () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    createTaskRepository(db).start(session.id, { templateId: 'onboarding', goal: 'Знакомство' })
    const turnId = reserveTurn(db, session.id)
    const tools = createTaskTools({ db, sessionId: session.id, turnId })

    await expect(invoke(tools.record_task_answer, { questionId: 'level', answer: 'средний' })).resolves.toMatchObject({
      ok: true,
      recordedValue: 'intermediate',
      remainingCount: 4,
      task: { answers: { level: 'intermediate' } },
    })
    await expect(invoke(tools.record_task_answer, { questionId: 'style', answer: 'кратко или подробно' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('brief, detailed') },
    })
    expect(createTaskRepository(db).getSnapshot(session.id)?.answers).not.toHaveProperty('style')
    finishTurn(db, turnId)
  })

  it('reads the persisted task snapshot without a turn and without mutating the database', async () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    createTaskRepository(db).start(session.id, { templateId: 'onboarding', goal: 'Знакомство' })
    const turnId = reserveTurn(db, session.id)
    const writer = createTaskTools({ db, sessionId: session.id, turnId })
    await invoke(writer.record_task_answer, { questionId: 'name', answer: 'Игорь' })
    finishTurn(db, turnId)

    const before = db.prepare('SELECT * FROM tasks WHERE session_id = ?').get(session.id)
    const transitionCountBefore = db.prepare('SELECT COUNT(*) AS count FROM task_transitions').get()
    const reader = createTaskTools({ db, sessionId: session.id })

    await expect(invoke(reader.get_task_state)).resolves.toMatchObject({
      ok: true,
      task: {
        sessionId: session.id,
        stage: 'interview',
        revision: 1,
        questions: expect.arrayContaining([
          expect.objectContaining({ id: 'name', answered: true, value: 'Игорь' }),
        ]),
      },
    })
    expect(db.prepare('SELECT * FROM tasks WHERE session_id = ?').get(session.id)).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_transitions').get()).toEqual(transitionCountBefore)
  })

  it('cancels the correlated pending transition and returns a fresh snapshot', async () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    createTaskRepository(db).start(session.id, { templateId: 'dev', goal: 'Отчёт' })
    const turnId = reserveTurn(db, session.id)
    const tools = createTaskTools({ db, sessionId: session.id, turnId })
    const requested = await invoke(tools.request_task_transition, { to: 'execution', summary: 'План' }) as any

    await expect(invoke(tools.cancel_task_transition, {
      pendingTransitionId: requested.pendingTransitionId,
    })).resolves.toMatchObject({
      ok: true,
      pendingTransitionId: requested.pendingTransitionId,
      task: {
        stage: 'planning',
        revision: 2,
        pendingTransition: null,
        lastTransition: { id: requested.pendingTransitionId, outcome: 'cancelled' },
      },
    })
    finishTurn(db, turnId)
  })

  it('amends an onboarding answer on review and returns the updated preview', async () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    tasks.start(session.id, { templateId: 'onboarding', goal: 'Знакомство' })
    const answers = { name: 'Игорь', role: 'Разработчик', goal: 'Учёба', level: 'средний', style: 'кратко' }
    const interviewTurn = reserveTurn(db, session.id)
    for (const [questionId, answer] of Object.entries(answers)) {
      tasks.recordAnswer(session.id, { questionId, answer }, { turnId: interviewTurn })
    }
    const pending = tasks.requestTransition(session.id, { to: 'review', summary: 'Ответы' }, { turnId: interviewTurn })
    finishTurn(db, interviewTurn)
    const review = tasks.approve(session.id, {
      pendingTransitionId: pending.pendingTransition!.id,
      expectedRevision: pending.revision,
    })
    const amendTurn = reserveTurn(db, session.id)
    const tools = createTaskTools({ db, sessionId: session.id, turnId: amendTurn })

    await expect(invoke(tools.amend_task_answer, {
      questionId: 'style',
      answer: 'подробно',
      expectedRevision: review.revision,
    })).resolves.toMatchObject({
      ok: true,
      questionId: 'style',
      task: {
        stage: 'review',
        answers: { style: 'подробно' },
        profilePreview: { instructions: expect.stringContaining('Стиль ответов - подробно') },
      },
    })
    finishTurn(db, amendTurn)
  })

  it('returns ANSWERS_MISSING with missing ids when the transition is requested too early', async () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    createTaskRepository(db).start(session.id, { templateId: 'onboarding', goal: 'Знакомство' })
    const turnId = reserveTurn(db, session.id)
    const tools = createTaskTools({ db, sessionId: session.id, turnId })

    await expect(invoke(tools.request_task_transition, { to: 'review', summary: 'x' })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'ANSWERS_MISSING',
        message: expect.any(String),
        missing: ['name', 'role', 'goal', 'level', 'style'],
        allowedTransitions: ['review'],
        task: { stage: 'interview', revision: 0 },
      },
    })
    finishTurn(db, turnId)
  })

  it('removes write_file before execution and keeps it for the execution stage', async () => {
    const response = {
      content: [{ type: 'text' as const, text: 'Готово' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }
    const planningModel = new MockLanguageModelV3({ doGenerate: response })
    const baseTask = {
      id: 'task-1', sessionId: 'session-1', templateId: 'dev', goal: 'Отчёт', step: '', status: 'active' as const,
      artifacts: {}, answers: {}, createdAt: '', updatedAt: '',
    }
    const planningAgent = createChatAgent(planningModel, undefined, { task: { ...baseTask, stage: 'planning' } })
    await planningAgent.generate({ prompt: 'Продолжай' })
    expect(planningModel.doGenerateCalls[0]?.tools?.map(tool => tool.name)).not.toContain('write_file')

    const executionModel = new MockLanguageModelV3({ doGenerate: response })
    const executionAgent = createChatAgent(executionModel, undefined, { task: { ...baseTask, stage: 'execution' } })
    await executionAgent.generate({ prompt: 'Продолжай' })
    expect(executionModel.doGenerateCalls[0]?.tools?.map(tool => tool.name)).toContain('write_file')
  })

  it('exposes only questionnaire tools during the interview', async () => {
    const response = {
      content: [{ type: 'text' as const, text: 'Как к вам обращаться?' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }
    const model = new MockLanguageModelV3({ doGenerate: response })
    const task = {
      id: 'task-1', sessionId: 'session-1', templateId: 'onboarding', goal: 'Знакомство', stage: 'interview',
      step: '', status: 'active' as const, artifacts: {}, answers: { name: 'Игорь' }, createdAt: '', updatedAt: '',
    }

    await createChatAgent(model, undefined, { task }).generate({ prompt: 'Продолжим' })

    expect(model.doGenerateCalls[0]?.tools?.map(tool => tool.name).sort()).toEqual([
      'cancel_task_transition', 'get_task_state', 'record_task_answer', 'request_task_transition', 'update_task_step',
    ])
  })
})
