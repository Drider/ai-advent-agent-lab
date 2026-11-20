import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { WorkflowDefinition, WorkflowSummary, WorkflowVersion } from '../../shared/workflow'
import { TaskError } from '../tasks/errors'
import { validateWorkflowDefinition, workflowHash } from './schema'

interface WorkflowVersionRow {
  workflow_id: string
  version: number
  definition_json: string
  hash: string
  created_at: string
}

export function createWorkflowRepository(db: Database.Database) {
  const listWorkflows = db.prepare<[], WorkflowSummary>(`
    SELECT workflows.id, workflows.name, MAX(workflow_versions.version) AS latestVersion
    FROM workflows JOIN workflow_versions ON workflow_versions.workflow_id = workflows.id
    GROUP BY workflows.id
    ORDER BY workflows.name, workflows.id
  `)
  const latestVersion = db.prepare<[string], WorkflowVersionRow>(`
    SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1
  `)
  const specificVersion = db.prepare<[string, number], WorkflowVersionRow>(`
    SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?
  `)
  const insertWorkflow = db.prepare('INSERT INTO workflows (id, name, created_at) VALUES (?, ?, ?)')
  const insertVersion = db.prepare(`
    INSERT INTO workflow_versions (workflow_id, version, definition_json, hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)

  function list(): WorkflowSummary[] {
    return listWorkflows.all()
  }

  function get(id: string, version?: number): WorkflowVersion | null {
    const row = version === undefined ? latestVersion.get(id) : specificVersion.get(id, version)
    if (!row) return null
    return {
      workflowId: row.workflow_id,
      version: row.version,
      definition: JSON.parse(row.definition_json) as WorkflowDefinition,
      hash: row.hash,
      createdAt: row.created_at,
    }
  }

  function saveVersion(id: string, version: number, input: WorkflowDefinition, createdAt: string): WorkflowVersion {
    const definition = validateWorkflowDefinition(input)
    const hash = workflowHash(definition)
    insertVersion.run(id, version, JSON.stringify(definition), hash, createdAt)
    return { workflowId: id, version, definition, hash, createdAt }
  }

  const create = db.transaction((name: string, definition: WorkflowDefinition): WorkflowVersion => {
    const workflowId = randomUUID()
    const createdAt = new Date().toISOString()
    insertWorkflow.run(workflowId, name, createdAt)
    return saveVersion(workflowId, 1, definition, createdAt)
  })

  const publish = db.transaction((id: string, expectedVersion: number, definition: WorkflowDefinition): WorkflowVersion => {
    const current = latestVersion.get(id)
    if (!current) throw new TaskError('NOT_FOUND', 'workflow was not found')
    if (current.version !== expectedVersion) throw new TaskError('OPERATION_CONFLICT', 'workflow was changed by another request')
    return saveVersion(id, current.version + 1, definition, new Date().toISOString())
  })

  const seed = db.transaction((id: string, name: string, definition: WorkflowDefinition) => {
    if (latestVersion.get(id)) return
    const timestamp = new Date().toISOString()
    insertWorkflow.run(id, name, timestamp)
    saveVersion(id, 1, definition, timestamp)
  })
  return { list, get, seed: seed.immediate, create: create.immediate, publish: publish.immediate }
}
