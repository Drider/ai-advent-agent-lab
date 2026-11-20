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

  return {
    latest(taskId: string, key: string): TaskArtifact | null {
      const row = byKey.get(taskId, key)
      return row ? artifact(row) : null
    },
    workflowArtifacts(taskId: string): TaskArtifact[] {
      return current.all(taskId).map(artifact)
    },
  }
}
