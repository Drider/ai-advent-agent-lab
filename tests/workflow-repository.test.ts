import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createWorkflowRepository } from '../server/workflows/repository'
import type { WorkflowDefinition } from '../shared/workflow'

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  entryNodeId: 'done',
  resultArtifactKey: 'result',
  artifactSlots: [{ key: 'result', type: 'result' }],
  nodes: [{
    id: 'done',
    kind: 'success',
    stage: 'done',
    label: 'Завершить',
    expected: { actor: 'agent', kind: 'result', label: 'Завершить' },
    allowedTools: [],
    writableArtifacts: [],
    requiredApprovalKeys: [],
    checkIds: [],
  }],
  transitions: [],
  checks: [{ id: 'result_exists', kind: 'fields', artifactKeys: ['result'], options: { fields: [] } }],
  completionCheckIds: ['result_exists'],
  contextExports: [],
}

const changedDefinition = { ...definition, contextExports: ['result'] }

let db: Database.Database

beforeEach(() => {
  db = openChatDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

describe('workflow repository', () => {
  it('does not rewrite a published workflow version or rebind a pinned task', () => {
    const workflows = createWorkflowRepository(db)
    const v1 = workflows.create('Аналитика', definition)
    const { id: sessionId } = createSessionRepository(db).createSession()
    db.prepare(`
      INSERT INTO tasks (id, session_id, task, status, workflow_id, workflow_version, node_id, node_visit_id,
        stage, step, expected_json, created_at, updated_at)
      VALUES ('pinned', ?, 'Отчёт', 'active', ?, 1, 'done', 'visit', 'done', 'Завершить', ?, ?, ?)
    `).run(sessionId, v1.workflowId, JSON.stringify(definition.nodes[0]!.expected), v1.createdAt, v1.createdAt)

    const v2 = workflows.publish(v1.workflowId, 1, changedDefinition)
    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
    expect(v2.hash).not.toBe(v1.hash)
    expect(workflows.get(v1.workflowId, 1)).toEqual(v1)
    expect(workflows.get(v1.workflowId)).toEqual(v2)
    expect(workflows.get(v1.workflowId, 3)).toBeNull()
    expect(workflows.list()).toEqual([{ id: v1.workflowId, name: 'Аналитика', latestVersion: 2 }])
    expect(db.prepare('SELECT workflow_version FROM tasks WHERE id = ?').get('pinned')).toEqual({ workflow_version: 1 })
    expect(() => db.prepare('UPDATE workflow_versions SET hash = ? WHERE workflow_id = ? AND version = 1').run('modified', v1.workflowId)).toThrow()
    expect(() => db.prepare(`
      INSERT OR REPLACE INTO workflow_versions (workflow_id, version, definition_json, hash, created_at)
      VALUES (?, 1, '{}', 'replacement', ?)
    `).run(v1.workflowId, v1.createdAt)).toThrow()
  })

  it('preserves the library after stale, missing, or invalid publication requests', () => {
    const workflows = createWorkflowRepository(db)
    const v1 = workflows.create('Аналитика', definition)
    expect(() => workflows.publish('missing', 1, definition)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => workflows.publish(v1.workflowId, 0, definition)).toThrow(expect.objectContaining({ code: 'OPERATION_CONFLICT' }))
    expect(() => workflows.publish(v1.workflowId, 1, { ...definition, entryNodeId: 'missing' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(workflows.get('missing')).toBeNull()
    expect(workflows.get(v1.workflowId)).toEqual(v1)
  })
})
