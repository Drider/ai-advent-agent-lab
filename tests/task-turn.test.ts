import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { startMemoryAwareTurn } from '../server/memory/start-turn'
import { createTaskService } from '../server/tasks/commands'
import { createTaskRuntime, startTaskAwareTurn } from '../server/tasks/turn-runtime'

const message = (sessionId: string, text: string) => ({
  kind: 'message' as const, requestId: randomUUID(), sessionId,
  message: { id: randomUUID(), role: 'user' as const, parts: [{ type: 'text' as const, text }] },
})

it('binds a basic task and the new turn atomically, including budget rollback', () => {
  const db = openChatDatabase(':memory:')
  const sessionId = createSessionRepository(db).createSession().id
  const request = message(sessionId, 'Подготовь отчет')
  expect(() => startTaskAwareTurn(db, { request, modelId: 'mock', agentConfig: { contextCompaction: { contextWindowTokens: 20 } } })).toThrow()
  expect(db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })
  const start = startTaskAwareTurn(db, { request, modelId: 'mock', agentConfig: {} })
  expect(start.taskContext?.task).toMatchObject({ task: 'Подготовь отчет', workflowId: null, status: 'active' })
  expect(db.prepare('SELECT task_id FROM turns WHERE id=?').get(start.turnId)).toEqual({ task_id: start.taskContext!.task.id })
  db.close()
})

it('keeps a question open, accepts the answer on a later turn, and restricts post-commit continuation to text', async () => {
  const db = openChatDatabase(':memory:')
  const sessionId = createSessionRepository(db).createSession().id
  const service = createTaskService(db)
  const turns = createTurnRepository(db)
  const start = () => startTaskAwareTurn(db, { request: message(sessionId, 'More details'), modelId: 'mock', agentConfig: {} })
  const first = start()
  const task = first.taskContext!.task
  const runtime = createTaskRuntime({ db, sessionId, turnId: first.turnId, taskId: task.id })
  const waiting = await service.apply(task.id, { operationId: 'question', expectedRevision: task.revision, command: {
    type: 'update_progress', progress: 'Waiting', expected: { actor: 'user', kind: 'input', label: 'Choose audience' },
  } }, runtime.prepareStep(0).actor, { toolCallId: 'ask' })
  expect(waiting).toMatchObject({ ok: true, task: { status: 'active', expected: { actor: 'user' } } })
  turns.markStopped(first.turnId)
  expect(createTaskService(db).view(task.id, sessionId).task?.status).toBe('active')
  const second = start()
  expect(second.taskContext!.task).toMatchObject({ id: task.id, expected: { actor: 'agent' } })
  const finished = await service.apply(task.id, { operationId: 'done', expectedRevision: second.taskContext!.task.revision,
    command: { type: 'finish', resultText: 'canonical result' } },
    createTaskRuntime({ db, sessionId, turnId: second.turnId, taskId: task.id }).prepareStep(0).actor, { toolCallId: 'finish' })
  expect(finished).toMatchObject({ ok: true, task: { status: 'done' } })
  turns.markStopped(second.turnId)
  const continued = startTaskAwareTurn(db, { modelId: 'mock', agentConfig: {}, request: { ...message(sessionId, 'Continue'),
    kind: 'continue', sourceTurnId: second.turnId } })
  expect(continued.taskContext!.requiredArtifacts[0]?.content).toBe('canonical result')
  expect(createTaskRuntime({ db, sessionId, turnId: continued.turnId, taskId: task.id }).prepareStep(0).activeTools).toEqual([])
  turns.markStopped(continued.turnId)
  expect(start().taskContext!.task.id).not.toBe(task.id)
  db.close()
})

it('leaves an interrupted legacy turn unbound and rejects duplicate requests before task creation', () => {
  const db = openChatDatabase(':memory:')
  const sessionId = createSessionRepository(db).createSession().id
  const input = { request: message(sessionId, 'Old task'), modelId: 'mock', agentConfig: {} }
  const legacy = startMemoryAwareTurn(db, input)
  expect(() => startTaskAwareTurn(db, input)).toThrow(/TURN_ALREADY_EXISTS/)
  createTurnRepository(db).markStopped(legacy.turnId)
  const continued = startTaskAwareTurn(db, { ...input, request: { ...message(sessionId, 'Continue'), kind: 'continue', sourceTurnId: legacy.turnId } })
  expect(continued.taskContext).toBeNull()
  expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 })
  db.close()
})
