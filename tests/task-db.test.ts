import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTaskRepository } from '../server/tasks/repository'
import type { TaskSnapshot } from '../shared/task'

const now = '2026-11-20T12:00:00.000Z'
const expected = { actor: 'agent', kind: 'result', label: 'Подготовить результат' }

let db: Database.Database

beforeEach(() => {
  db = openChatDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

function addTask(id: string, sessionId: string, status: TaskSnapshot['status'] = 'active'): void {
  db.prepare(`
    INSERT INTO tasks (id, session_id, task, status, stage, step, expected_json, created_at, updated_at)
    VALUES (?, ?, 'Подготовить отчёт', ?, 'execution', 'Подготовка', ?, ?, ?)
  `).run(id, sessionId, status, JSON.stringify(expected), now, now)
}

describe('task storage', () => {
  it.each(['active', 'paused'] as const)('treats %s as the only unfinished task in its dialogue', (status) => {
    const first = createSessionRepository(db).createSession()
    const second = createSessionRepository(db).createSession()
    db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('shared-project', 'Проект', now, now)
    db.prepare('UPDATE sessions SET project_id = ? WHERE id IN (?, ?)').run('shared-project', first.id, second.id)
    const repository = createTaskRepository(db)

    addTask('finished', first.id, 'done')
    addTask('first-task', first.id, status)
    expect(() => addTask('duplicate-active', first.id)).toThrow()
    expect(() => addTask('duplicate-paused', first.id, 'paused')).toThrow()
    addTask('second-task', second.id)

    expect(repository.getUnfinished(first.id)).toEqual({
      id: 'first-task', sessionId: first.id, task: 'Подготовить отчёт', status,
      workflowId: null, workflowVersion: null, nodeId: null, nodeVisitId: null,
      stage: 'execution', step: 'Подготовка', expected, progress: '', revision: 0,
      artifacts: [], result: null, recovery: 'clear', createdAt: now, updatedAt: now,
    })
    expect(repository.getUnfinished(second.id)?.id).toBe('second-task')
    expect(repository.list(first.id).map(task => task.id)).toEqual(['first-task', 'finished'])
    expect(repository.get('absent')).toBeNull()
  })

  it('keeps artifact versions immutable and projects the pinned result after a newer version', () => {
    const { id: sessionId } = createSessionRepository(db).createSession()
    addTask('task', sessionId)
    const insert = db.prepare(`
      INSERT INTO task_artifacts (id, task_id, key, type, version, hash, content_json, created_at)
      VALUES (?, 'task', 'report', 'report', ?, ?, ?, ?)
    `)
    insert.run('report-v1', 1, 'hash-v1', '{"report":1}', now)
    insert.run('report-v2', 2, 'hash-v2', '{"report":2}', now)
    expect(() => insert.run('duplicate-v1', 1, 'duplicate', '{}', now)).toThrow()
    expect(() => insert.run('invalid-json', 3, 'bad', '{broken', now)).toThrow()
    expect(() => db.prepare(`
      INSERT OR REPLACE INTO task_artifacts (id, task_id, key, type, version, hash, content_json, created_at)
      VALUES ('report-v1', 'task', 'report', 'report', 1, 'replacement', '{}', ?)
    `).run(now)).toThrow()
    expect(() => db.prepare("UPDATE task_artifacts SET content_json = '{}' WHERE id = ?").run('report-v1')).toThrow()
    db.prepare("UPDATE tasks SET status = 'done', result_artifact_id = 'report-v1' WHERE id = ?").run('task')

    const repository = createTaskRepository(db)
    expect(repository.getUnfinished(sessionId)).toBeNull()
    expect(repository.get('task')).toMatchObject({
      status: 'done',
      artifacts: [{ id: 'report-v2', key: 'report', type: 'report', version: 2, hash: 'hash-v2' }],
      result: { id: 'report-v1', key: 'report', type: 'report', version: 1, hash: 'hash-v1' },
    })
  })

  it('deduplicates basic tool intentions and cascades task and dialogue deletion', () => {
    const { id: sessionId } = createSessionRepository(db).createSession()
    addTask('task', sessionId)
    const addOperation = db.prepare(`
      INSERT INTO task_tool_operations (id, task_id, action_key, tool_name, input_hash, status, created_at, updated_at)
      VALUES (?, 'task', 'write-report', 'write_file', 'hash', 'running', ?, ?)
    `)
    addOperation.run('intent', now, now)
    expect(() => addOperation.run('different-intent-id', now, now)).toThrow()
    const addCommand = db.prepare(`
      INSERT INTO task_commands (operation_id, session_id, task_id, actor, input_hash, phase, created_at, updated_at)
      VALUES (?, ?, ?, 'user', 'hash', 'running', ?, ?)
    `)
    addCommand.run('task-command', sessionId, 'task', now, now)
    addCommand.run('dialogue-command', sessionId, null, now, now)
    expect(() => addCommand.run('task-command', sessionId, null, now, now)).toThrow()

    db.prepare('DELETE FROM tasks WHERE id = ?').run('task')
    expect(db.prepare('SELECT id FROM task_tool_operations').all()).toEqual([])
    expect(db.prepare('SELECT operation_id FROM task_commands').all()).toEqual([{ operation_id: 'dialogue-command' }])
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    expect(db.prepare('SELECT operation_id FROM task_commands').all()).toEqual([])
  })
})
