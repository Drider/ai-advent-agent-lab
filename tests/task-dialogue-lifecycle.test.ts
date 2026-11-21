import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createBranchRepository } from '../server/persistence/branch-repository'
import { createHistoryClearRepository } from '../server/memory/clear-repository'
import { createHistoryClearService } from '../server/memory/clear-service'
import { createTaskService } from '../server/tasks/commands'
import { createTaskRepository } from '../server/tasks/repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import type { ChatUIMessage } from '../shared/chat'

const databases: ReturnType<typeof openChatDatabase>[] = []
const directories: string[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function saveAssistant(db: ReturnType<typeof openChatDatabase>, sessionId: string, id = randomUUID()): string {
  const userId = randomUUID()
  const at = new Date().toISOString()
  const rows: ChatUIMessage[] = [
    { id: userId, role: 'user', parts: [{ type: 'text', text: 'Начало' }] },
    { id, role: 'assistant', parts: [{ type: 'text', text: 'Ответ' }] },
  ]
  for (const [position, message] of rows.entries()) {
    db.prepare(`
      INSERT INTO messages (id, session_id, turn_id, position, role, status, payload_json, storage_version, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, 'complete', ?, 1, ?, ?)
    `).run(message.id, sessionId, position, message.role, JSON.stringify(message), at, at)
  }
  return id
}

describe('task state across the dialogue lifecycle', () => {
  it('branches conversation context without inheriting task authority', async () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const parent = createSessionRepository(db).createSession()
    const task = createTaskService(db).create({ sessionId: parent.id, task: 'Parent task', operationId: 'parent-create' },
      { sessionId: parent.id, role: 'user' })
    expect(task.ok).toBe(true)
    const point = saveAssistant(db, parent.id)

    const child = createBranchRepository(db).createBranch({ parentSessionId: parent.id, throughMessageId: point })
    const sessions = createSessionRepository(db)
    const childDetail = await sessions.getSession(child.id)
    expect(childDetail?.messages).toHaveLength(2)
    expect(childDetail?.taskView).toEqual({ task: null, actions: [], approvals: [], validations: [], recoveryOperations: [] })
    expect(childDetail?.taskHistory).toEqual([])
    expect(createTaskRepository(db).getUnfinished(child.id)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_approvals WHERE task_id IN (SELECT id FROM tasks WHERE session_id = ?)').get(child.id))
      .toEqual({ count: 0 })
  })

  it('clears task-owned rows and tombstones command and resume identifiers', async () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskService(db)
    const created = tasks.create({ sessionId: session.id, task: 'Clear me', operationId: 'create-old' }, { sessionId: session.id, role: 'user' })
    if (!created.ok) throw new Error(created.error.message)
    const paused = await tasks.apply(created.task.id, { operationId: 'pause-old', expectedRevision: created.task.revision, command: { type: 'pause' } },
      { sessionId: session.id, role: 'user' })
    if (!paused.ok) throw new Error(paused.error.message)
    const resumed = await tasks.apply(created.task.id, { operationId: 'resume-old', expectedRevision: paused.task.revision, command: { type: 'resume' } },
      { sessionId: session.id, role: 'user' })
    if (!resumed.ok || !resumed.resumeRequestId) throw new Error('resume receipt was not saved')
    const oldRequestIds = ['create-old', 'pause-old', 'resume-old', resumed.resumeRequestId]

    const result = await createHistoryClearService(db, { deleteLog: async () => undefined }).clear(session.id, 'clear-task-state')
    expect(result.status).toBe('completed')
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE session_id = ?').get(session.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_artifacts').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE session_id = ?').get(session.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_commands WHERE session_id = ?').get(session.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_approvals').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_validations').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_tool_operations').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT request_id FROM cleared_requests WHERE session_id = ? ORDER BY request_id').all(session.id))
      .toEqual(oldRequestIds.sort().map(request_id => ({ request_id })))
    expect(tasks.create({ sessionId: session.id, task: 'Reuse', operationId: 'create-old' }, { sessionId: session.id, role: 'user' }))
      .toMatchObject({ ok: false, error: { code: 'OPERATION_CONFLICT' } })
  })

  it.each([
    ['running task command', (db: ReturnType<typeof openChatDatabase>, sessionId: string, taskId: string) => {
      const at = new Date().toISOString()
      db.prepare(`INSERT INTO task_commands (operation_id, session_id, task_id, actor, input_hash, phase, created_at, updated_at)
        VALUES ('running-command', ?, ?, 'agent', 'hash', 'running', ?, ?)`).run(sessionId, taskId, at, at)
    }],
    ['uncertain tool operation', (db: ReturnType<typeof openChatDatabase>, _sessionId: string, taskId: string) => {
      const at = new Date().toISOString()
      db.prepare(`INSERT INTO task_tool_operations (id, task_id, action_key, tool_name, input_hash, status, created_at, updated_at)
        VALUES ('uncertain-operation', ?, 'write', 'write_file', 'hash', 'uncertain', ?, ?)`).run(taskId, at, at)
    }],
    ['recovery review', (db: ReturnType<typeof openChatDatabase>, _sessionId: string, taskId: string) => {
      db.prepare("UPDATE tasks SET recovery = 'needs_review' WHERE id = ?").run(taskId)
    }],
  ] as const)('blocks cleanup with %s', async (_label, seed) => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const session = createSessionRepository(db).createSession()
    const created = createTaskService(db).create({ sessionId: session.id, task: 'Busy', operationId: randomUUID() }, { sessionId: session.id, role: 'user' })
    if (!created.ok) throw new Error(created.error.message)
    seed(db, session.id, created.task.id)
    await expect(createHistoryClearService(db, { deleteLog: async () => undefined }).clear(session.id, randomUUID()))
      .rejects.toMatchObject({ code: 'SESSION_RUNNING' })
    expect(createTaskRepository(db).get(created.task.id)).not.toBeNull()
  })

  it('restores a paused task view after SQLite reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'task-dialogue-lifecycle-'))
    directories.push(directory)
    const path = join(directory, 'chat.sqlite')
    let db = openChatDatabase(path)
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskService(db)
    const created = tasks.create({ sessionId: session.id, task: 'Persisted', operationId: 'persist-create' }, { sessionId: session.id, role: 'user' })
    if (!created.ok) throw new Error(created.error.message)
    const paused = await tasks.apply(created.task.id, { operationId: 'persist-pause', expectedRevision: 0, command: { type: 'pause' } },
      { sessionId: session.id, role: 'user' })
    if (!paused.ok) throw new Error(paused.error.message)
    db.close()
    db = openChatDatabase(path)
    databases.push(db)
    const detail = await createSessionRepository(db).getSession(session.id)
    expect(detail?.taskView.task).toMatchObject({ id: created.task.id, status: 'paused' })
    expect(detail?.taskHistory.map(item => item.id)).toEqual([created.task.id])
    expect(detail?.taskView.actions).toContainEqual({ type: 'resume', label: 'Продолжить задачу' })
  })
})
