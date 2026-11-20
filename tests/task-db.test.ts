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

function addTurn(id: string, sessionId: string, taskId: string | null): void {
  db.prepare(`
    INSERT INTO turns (id, session_id, task_id, request_id, position, status, model_id,
      agent_config_json, started_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 'running', 'mock', '{}', ?, ?)
  `).run(id, sessionId, taskId, id, now, now)
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

  it('keeps command events in their own dialogue', () => {
    const sessions = createSessionRepository(db)
    const first = sessions.createSession()
    const second = sessions.createSession()
    addTask('first-task', first.id)
    const addCommand = db.prepare(`
      INSERT INTO task_commands (operation_id, session_id, actor, input_hash, phase, receipt_json, created_at, updated_at)
      VALUES (?, ?, 'user', 'hash', 'completed', '{}', ?, ?)
    `)
    addCommand.run('first-command', first.id, now, now)
    addCommand.run('second-command', second.id, now, now)
    const addEvent = db.prepare(`
      INSERT INTO task_events (id, session_id, task_id, operation_id, actor, type, phase, created_at)
      VALUES ('first-event', ?, 'first-task', ?, 'user', 'create', 'completed', ?)
    `)
    expect(() => addEvent.run(first.id, 'second-command', now)).toThrow()
    addEvent.run(first.id, 'first-command', now)
    expect(() => db.prepare("UPDATE task_events SET operation_id = 'second-command' WHERE id = 'first-event'").run()).toThrow()

    db.prepare('DELETE FROM sessions WHERE id = ?').run(second.id)
    expect(db.prepare("SELECT operation_id FROM task_events WHERE id = 'first-event'").get()).toEqual({
      operation_id: 'first-command',
    })
  })

  it('allows a turn to link only to a task in its own dialogue', () => {
    const sessions = createSessionRepository(db)
    const first = sessions.createSession()
    const second = sessions.createSession()
    addTask('first-task', first.id)
    addTask('second-task', second.id, 'done')

    expect(() => addTurn('first-turn', first.id, 'second-task')).toThrow()
    addTurn('first-turn', first.id, null)
    const linkTask = db.prepare("UPDATE turns SET task_id = ? WHERE id = 'first-turn'")
    expect(() => linkTask.run('second-task')).toThrow()
    linkTask.run('first-task')
    expect(() => db.prepare("UPDATE turns SET session_id = ? WHERE id = 'first-turn'").run(second.id)).toThrow()
    expect(() => db.prepare("UPDATE tasks SET session_id = ? WHERE id = 'first-task'").run(second.id)).toThrow()
  })

  it('requires populated execution, turn, and operation links to agree', () => {
    const sessions = createSessionRepository(db)
    const first = sessions.createSession()
    const second = sessions.createSession()
    addTask('first-task', first.id, 'done')
    addTask('other-task', first.id)
    addTask('remote-task', second.id)
    addTurn('first-turn', first.id, null)
    const addOperation = db.prepare(`
      INSERT INTO task_tool_operations (id, task_id, action_key, tool_name, input_hash, status, created_at, updated_at)
      VALUES (?, ?, 'write-report', 'write_file', 'hash', 'running', ?, ?)
    `)
    addOperation.run('first-intent', 'first-task', now, now)
    addOperation.run('other-intent', 'other-task', now, now)
    addOperation.run('remote-intent', 'remote-task', now, now)

    const addExecution = db.prepare(`
      INSERT INTO tool_executions (id, turn_id, task_id, task_operation_id, step_index,
        tool_call_id, tool_name, status, input_json, created_at, updated_at)
      VALUES ('execution', 'first-turn', ?, ?, 0, 'call', 'write_file', 'running', '{}', ?, ?)
    `)
    expect(() => addExecution.run('first-task', 'other-intent', now, now)).toThrow()
    expect(() => addExecution.run('remote-task', null, now, now)).toThrow()
    expect(() => addExecution.run(null, 'remote-intent', now, now)).toThrow()
    addExecution.run('first-task', 'first-intent', now, now)
    expect(() => db.prepare("UPDATE tool_executions SET task_operation_id = 'other-intent' WHERE id = 'execution'").run()).toThrow()
    expect(() => db.prepare(`
      UPDATE task_tool_operations SET task_id = 'other-task', action_key = 'other-report' WHERE id = 'first-intent'
    `).run()).toThrow()

    const bindTurn = db.prepare("UPDATE turns SET task_id = ? WHERE id = 'first-turn'")
    expect(() => bindTurn.run('other-task')).toThrow()
    bindTurn.run('first-task')

    db.prepare("DELETE FROM tasks WHERE id = 'first-task'").run()
    expect(db.prepare("SELECT task_id FROM turns WHERE id = 'first-turn'").get()).toEqual({ task_id: null })
    expect(db.prepare("SELECT task_id, task_operation_id FROM tool_executions WHERE id = 'execution'").get()).toEqual({
      task_id: null,
      task_operation_id: null,
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
