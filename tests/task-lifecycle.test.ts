import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHistoryClearRepository } from '../server/memory/clear-repository'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTaskService } from '../server/tasks/commands'
import { createWorkflowRepository } from '../server/workflows/repository'
import type { TaskActorContext, TaskCommand } from '../shared/task'

const now = '2026-11-20T12:00:00.000Z'

let db: Database.Database
let service: ReturnType<typeof createTaskService>
let user: TaskActorContext

beforeEach(() => {
  db = openChatDatabase(':memory:')
  const { id: sessionId } = createSessionRepository(db).createSession()
  user = { role: 'user', sessionId }
  service = createTaskService(db, { now: () => now })
})

afterEach(() => db.close())

function create(task = 'Подготовить отчёт', operationId = 'create') {
  const result = service.create({ sessionId: user.sessionId, task, operationId }, user)
  if (!result.ok) throw new Error(result.error.code)
  return result.task
}

function apply(taskId: string, command: TaskCommand, expectedRevision = 0, actor = user, operationId: string = command.type) {
  return service.apply(taskId, { operationId, expectedRevision, command }, actor)
}

describe('basic task lifecycle', () => {
  it('starts an empty goal by waiting for user input', () => {
    const task = create('  ')
    expect(task).toMatchObject({
      task: 'Новая задача', status: 'active', workflowId: null, nodeId: null,
      revision: 0, expected: { actor: 'user', kind: 'input' },
    })
    expect(service.view(task.id, user.sessionId).task).toEqual(task)
  })

  it('pauses and resumes with one durable request ID', async () => {
    const task = create()
    expect(service.create({ sessionId: user.sessionId, task: 'Другая задача', operationId: 'second' }, user))
      .toMatchObject({ ok: false, error: { code: 'TASK_ALREADY_ACTIVE' } })
    expect(await apply(task.id, { type: 'pause' })).toMatchObject({ ok: true, task: { status: 'paused', revision: 1 } })
    expect(service.create({ sessionId: user.sessionId, task: 'Другая задача', operationId: 'third' }, user))
      .toMatchObject({ ok: false, error: { code: 'TASK_ALREADY_ACTIVE' } })

    const resumed = await apply(task.id, { type: 'resume' }, 1)
    expect(resumed).toMatchObject({
      ok: true, task: { status: 'active', revision: 2, expected: task.expected }, resumeRequestId: expect.any(String),
    })
    expect(await apply(task.id, { type: 'resume' }, 1)).toEqual(resumed)
  })

  it.each(['active', 'paused'])('cancels a %s task and permits a new task', async (status) => {
    const task = create()
    if (status === 'paused') await apply(task.id, { type: 'pause' })
    const cancelled = await apply(task.id, { type: 'cancel' }, status === 'paused' ? 1 : 0)
    expect(cancelled).toMatchObject({ ok: true, task: { status: 'cancelled' } })
    expect(create('Другая задача', 'after-cancel').id).not.toBe(task.id)
  })

  it('completes a paused basic task manually and keeps its terminal state immutable', async () => {
    const task = create()
    await apply(task.id, { type: 'pause' })
    const completed = await apply(task.id, { type: 'complete_basic' }, 1)
    expect(completed).toMatchObject({ ok: true, task: { status: 'done', revision: 2, result: null } })
    expect(await apply(task.id, { type: 'resume' }, 2))
      .toMatchObject({ ok: false, error: { code: 'TASK_TERMINAL' }, task: completed.task })
    expect(service.view(task.id, user.sessionId)).toMatchObject({ task: completed.task, actions: [] })
  })

  it.each(['pause', 'resume', 'cancel', 'complete_basic'] as const)('rejects agent %s', async (type) => {
    const task = create()
    expect(await apply(task.id, { type }, 0, { ...user, role: 'agent' })).toMatchObject({
      ok: false, error: { code: 'TRANSITION_NOT_ALLOWED' }, task,
    })
  })

  it('saves basic materials as notes and an agent result as a result artifact', async () => {
    const task = create()
    const agent = { ...user, role: 'agent' } as const
    expect(await apply(task.id, {
      type: 'submit_artifact', key: 'report', content: { summary: 'Прогресс' }, sourceMessageIds: [], sourceToolCallIds: [],
    }, 0, agent)).toMatchObject({ ok: true, task: { artifacts: [{ key: 'report', type: 'note' }] } })
    expect(await apply(task.id, { type: 'finish', resultText: '  ' }, 1, agent, 'empty-result'))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' }, task: { revision: 1 } })
    expect(await apply(task.id, { type: 'finish', resultText: 'Готовый отчёт' }, 1, agent))
      .toMatchObject({ ok: true, task: { revision: 2, status: 'done', result: { key: 'result', type: 'result' } } })
    expect(db.prepare("SELECT content_json FROM task_artifacts WHERE type = 'result'").get())
      .toEqual({ content_json: '"Готовый отчёт"' })
  })

  it('blocks agent completion while waiting for user input', async () => {
    const task = create('')
    expect(await apply(task.id, { type: 'finish', resultText: 'Без ответа' }, 0, { ...user, role: 'agent' }))
      .toMatchObject({ ok: false, error: { code: 'TRANSITION_NOT_ALLOWED' }, task })
  })

  it('rejects workflow commands until the workflow engine is available', async () => {
    const task = create()
    for (const command of [
      { type: 'attach', workflowId: 'flow', version: 1 },
      { type: 'transition', transitionId: 'advance' },
      { type: 'validate' },
      { type: 'approve', approvalId: 'approval' },
      { type: 'resolve_recovery', operationId: 'tool-operation', outcome: 'completed' },
    ] satisfies TaskCommand[]) {
      expect(await apply(task.id, command)).toMatchObject({
        ok: false, error: { code: 'TRANSITION_NOT_ALLOWED' }, task,
      })
    }
  })

  it('pins a published workflow entry and blocks manual completion', async () => {
    const expected = { actor: 'agent', kind: 'result', label: 'Подготовить итог' } as const
    const version = createWorkflowRepository(db).create('Отчёт', {
      schemaVersion: 1,
      entryNodeId: 'done',
      resultArtifactKey: 'result',
      artifactSlots: [{ key: 'result', type: 'result' }],
      nodes: [{
        id: 'done', kind: 'success', stage: 'review', label: 'Итог', expected,
        allowedTools: [], writableArtifacts: [], requiredApprovalKeys: [], checkIds: [],
      }],
      transitions: [],
      checks: [{ id: 'fields', kind: 'fields', artifactKeys: ['result'], options: { fields: [] } }],
      completionCheckIds: ['fields'],
      contextExports: [],
    })
    const creation = service.create({
      sessionId: user.sessionId, task: 'Отчёт', operationId: 'create-pinned',
      workflow: { id: version.workflowId, version: version.version },
    }, user)
    expect(creation).toMatchObject({
      ok: true,
      task: {
        workflowId: version.workflowId, workflowVersion: 1, nodeId: 'done', nodeVisitId: expect.any(String),
        stage: 'review', step: 'Итог', expected,
      },
    })
    if (!creation.ok) throw new Error(creation.error.code)
    expect(await apply(creation.task.id, { type: 'complete_basic' })).toMatchObject({
      ok: false, error: { code: 'TRANSITION_NOT_ALLOWED' }, task: creation.task,
    })
  })

  it('binds an agent command to the task of its server-supplied turn', async () => {
    const task = create()
    const turnId = 'running-turn'
    db.prepare(`
      INSERT INTO turns (id, session_id, request_id, position, status, model_id, agent_config_json, started_at, updated_at)
      VALUES (?, ?, ?, 0, 'running', 'mock', '{}', ?, ?)
    `).run(turnId, user.sessionId, turnId, now, now)
    const actor = { ...user, role: 'agent', turnId } as const
    const command = { type: 'update_progress', progress: 'Черновик готов' } as const
    expect(await apply(task.id, command, 0, actor, 'before-binding')).toMatchObject({
      ok: false, error: { code: 'TRANSITION_NOT_ALLOWED' }, task,
    })
    db.prepare('UPDATE turns SET task_id = ? WHERE id = ?').run(task.id, turnId)
    expect(await apply(task.id, command, 0, actor)).toMatchObject({
      ok: true, task: { progress: 'Черновик готов', revision: 1 },
    })
    expect(db.prepare("SELECT source_turn_id FROM task_events WHERE type = 'progress_updated'").get())
      .toEqual({ source_turn_id: turnId })
  })

  it('blocks task creation during a running turn or pending history cleanup', () => {
    const { sessionId } = user
    const attempt = (operationId: string) => service.create({ sessionId, task: 'Отчёт', operationId }, user)
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(sessionId)
    expect(attempt('while-running')).toMatchObject({ ok: false, error: { code: 'SESSION_RUNNING' } })
    db.prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run(sessionId)
    createHistoryClearRepository(db).begin(sessionId, 'history-clear')
    expect(attempt('while-clearing')).toMatchObject({ ok: false, error: { code: 'SESSION_RUNNING' } })
  })

  it('blocks the next task while a cancelled task has an unresolved tool operation', async () => {
    const task = create()
    await apply(task.id, { type: 'cancel' })
    db.prepare(`
      INSERT INTO task_tool_operations (id, task_id, action_key, tool_name, input_hash, status, created_at, updated_at)
      VALUES ('pending', ?, 'write', 'write_file', 'hash', 'uncertain', ?, ?)
    `).run(task.id, now, now)
    expect(service.create({ sessionId: user.sessionId, task: 'Другая задача', operationId: 'blocked' }, user))
      .toMatchObject({ ok: false, error: { code: 'RECOVERY_REVIEW_REQUIRED' } })
  })

  it('reserves a normal message for the unfinished basic task and never creates a task for legacy continuation', () => {
    const { sessionId } = user
    const system = { ...user, role: 'system' } as const
    db.prepare(`
      INSERT INTO turns (id, session_id, request_id, position, status, model_id, agent_config_json, started_at, updated_at)
      VALUES ('old-turn', ?, 'old-turn', 0, 'interrupted', 'mock', '{}', ?, ?)
    `).run(sessionId, now, now)
    expect(service.reserveForTurn({
      sessionId, kind: 'continue', requestId: 'legacy', sourceTurnId: 'old-turn', messageText: '',
    }, system)).toBeNull()
    expect(db.prepare('SELECT id FROM tasks').all()).toHaveLength(0)
    const task = create('')
    const reserved = service.reserveForTurn({ sessionId, kind: 'message', requestId: 'new-turn', messageText: 'Отчёт' }, system)
    expect(reserved).toMatchObject({ id: task.id, task: 'Отчёт', revision: 1, expected: { actor: 'agent', kind: 'result' } })
    expect(service.reserveForTurn({ sessionId, kind: 'message', requestId: 'next-turn', messageText: 'Уточнение' }, system))
      .toEqual(reserved)
  })
})
