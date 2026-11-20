import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import type { JsonValue, TaskArtifact } from '../../shared/task'

export function nonempty(content: JsonValue): boolean {
  if (typeof content === 'string') return content.trim() !== ''
  if (Array.isArray(content)) return content.some(nonempty)
  if (content !== null && typeof content === 'object') return Object.values(content).some(nonempty)
  return content !== null
}

interface ArtifactRow {
  id: string
  taskId: string
  key: string
  type: TaskArtifact['type']
  version: number
  hash: string
  contentJson: string
  messageIdsJson: string
  toolIdsJson: string
  createdAt: string
}

const columns = `id, task_id AS taskId, key, type, version, hash, content_json AS contentJson,
  source_message_ids_json AS messageIdsJson, source_tool_call_ids_json AS toolIdsJson, created_at AS createdAt`

function artifact({ contentJson, messageIdsJson, toolIdsJson, ...ref }: ArtifactRow): TaskArtifact {
  return { ...ref, content: JSON.parse(contentJson), sourceMessageIds: JSON.parse(messageIdsJson),
    sourceToolCallIds: JSON.parse(toolIdsJson) }
}

export function createArtifactStore(db: Database.Database) {
  const byKey = db.prepare<[string, string], ArtifactRow>(`SELECT ${columns} FROM task_artifacts
    WHERE task_id = ? AND key = ? ORDER BY version DESC LIMIT 1`)
  const current = db.prepare<[string], ArtifactRow>(`SELECT ${columns} FROM task_artifacts AS a
    WHERE task_id = ? AND version = (SELECT MAX(version) FROM task_artifacts WHERE task_id = a.task_id AND key = a.key)
      AND NOT EXISTS (
        SELECT 1 FROM task_events AS e, json_each(e.details_json, '$.priorArtifactIds') AS prior
        WHERE e.task_id = a.task_id AND e.type = 'workflow_attached' AND prior.value = a.id
      ) ORDER BY key`)

  const priorCall = db.prepare<[string, string]>(`SELECT 1 FROM task_events attached
    JOIN turns turn ON turn.session_id = attached.session_id AND turn.task_id = attached.task_id
    JOIN tool_executions execution ON execution.turn_id = turn.id
    WHERE attached.task_id = ? AND attached.type = 'workflow_attached' AND execution.tool_call_id = ?
      AND CASE WHEN json_type(attached.details_json, '$.priorTurnPosition') IS NULL
        THEN turn.started_at <= attached.created_at
        ELSE turn.position <= json_extract(attached.details_json, '$.priorTurnPosition') END
    LIMIT 1`)

  function afterActivation(taskId: string, toolCallIds: string[]): boolean {
    // An ID shared with a prior turn is ambiguous as a workflow source.
    return toolCallIds.every(id => priorCall.get(taskId, id) === undefined)
  }

  // A tool-call ID is local to its turn. Resolve it only when it identifies one
  // execution in this task and a completed operation for the producing visit.
  function receipts(taskId: string, visitId: string, ids: string[]) {
    const query = db.prepare<[string, string], { name: string; visit: string | null; output: string | null;
      receipt: string | null; input: string; status: string; operationStatus: string | null }>(`
      SELECT e.tool_name AS name, e.status, e.input_json AS input, e.output_json AS output,
        o.node_visit_id AS visit, o.status AS operationStatus, o.receipt_json AS receipt
      FROM tool_executions e JOIN turns t ON t.id = e.turn_id
      LEFT JOIN task_tool_operations o ON o.id = e.task_operation_id AND o.task_id = t.task_id
        AND o.tool_name = e.tool_name AND e.task_id = t.task_id
      WHERE t.task_id = ? AND e.tool_call_id = ?
    `)
    return [...new Set(ids)].flatMap(toolCallId => {
      if (!afterActivation(taskId, [toolCallId])) return []
      const rows = query.all(taskId, toolCallId)
      const row = rows[0]
      if (rows.length !== 1 || !row || row.visit !== visitId || row.status !== 'completed'
        || row.operationStatus !== 'completed' || !row.output || !row.receipt) return []
      const output: JsonValue = JSON.parse(row.output)
      if (!isDeepStrictEqual(output, JSON.parse(row.receipt))) return []
      return [{ toolCallId, name: row.name, output, input: JSON.parse(row.input) as JsonValue }]
    })
  }

  function producingVisit(taskId: string, artifactId: string) {
    return db.prepare<[string, string], { visit: string | null }>(`
      SELECT json_extract(details_json, '$.nodeVisitId') AS visit FROM task_events
      WHERE task_id = ? AND type = 'artifact_submitted' AND json_extract(details_json, '$.artifactId') = ?
      ORDER BY revision LIMIT 1
    `).get(taskId, artifactId)?.visit
  }

  return {
    afterActivation, receipts, producingVisit,
    latest(taskId: string, key: string): TaskArtifact | null {
      const row = byKey.get(taskId, key)
      return row ? artifact(row) : null
    },
    workflowArtifacts(taskId: string): TaskArtifact[] {
      return current.all(taskId).map(artifact).filter(item => afterActivation(taskId, item.sourceToolCallIds))
    },
  }
}
