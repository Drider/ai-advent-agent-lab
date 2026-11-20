import type Database from 'better-sqlite3'
import type { ArtifactRef, TaskSnapshot } from '../../shared/task'

interface TaskRow {
  id: string
  session_id: string
  task: string
  status: TaskSnapshot['status']
  workflow_id: string | null
  workflow_version: number | null
  node_id: string | null
  node_visit_id: string | null
  stage: string
  step: string
  expected_json: string
  progress: string
  revision: number
  artifacts_json: string
  result_json: string | null
  recovery: TaskSnapshot['recovery']
  created_at: string
  updated_at: string
}

const artifactReference = "json_object('id', artifact.id, 'key', artifact.key, 'type', artifact.type, 'version', artifact.version, 'hash', artifact.hash)"

const snapshots = `
  SELECT tasks.*,
    (
      SELECT json_group_array(${artifactReference} ORDER BY artifact.key)
      FROM task_artifacts artifact
      WHERE artifact.task_id = tasks.id AND artifact.version = (
        SELECT MAX(version) FROM task_artifacts WHERE task_id = artifact.task_id AND key = artifact.key
      )
    ) AS artifacts_json,
    (
      SELECT ${artifactReference}
      FROM task_artifacts artifact WHERE artifact.id = tasks.result_artifact_id
    ) AS result_json
  FROM tasks
`

function toSnapshot(row: TaskRow): TaskSnapshot {
  return {
    id: row.id,
    sessionId: row.session_id,
    task: row.task,
    status: row.status,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    nodeId: row.node_id,
    nodeVisitId: row.node_visit_id,
    stage: row.stage,
    step: row.step,
    expected: JSON.parse(row.expected_json) as TaskSnapshot['expected'],
    progress: row.progress,
    revision: row.revision,
    artifacts: JSON.parse(row.artifacts_json) as ArtifactRef[],
    result: row.result_json === null ? null : JSON.parse(row.result_json) as ArtifactRef,
    recovery: row.recovery,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createTaskRepository(db: Database.Database) {
  const byId = db.prepare<[string], TaskRow>(`${snapshots} WHERE tasks.id = ?`)
  const unfinished = db.prepare<[string], TaskRow>(`${snapshots} WHERE session_id = ? AND status IN ('active', 'paused')`)
  const bySession = db.prepare<[string], TaskRow>(`${snapshots} WHERE session_id = ? ORDER BY created_at DESC, id DESC`)

  function get(id: string): TaskSnapshot | null {
    const row = byId.get(id)
    return row ? toSnapshot(row) : null
  }

  function getUnfinished(sessionId: string): TaskSnapshot | null {
    const row = unfinished.get(sessionId)
    return row ? toSnapshot(row) : null
  }

  function list(sessionId: string): TaskSnapshot[] {
    return bySession.all(sessionId).map(toSnapshot)
  }

  return { get, getUnfinished, list }
}
