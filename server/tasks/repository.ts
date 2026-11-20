import type Database from 'better-sqlite3'
import type { ArtifactRef, JsonValue, TaskActorContext, TaskArtifact, TaskCommandResult, TaskSnapshot, TaskView, ValidationResult } from '../../shared/task'

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

type NewTask = Omit<TaskSnapshot, 'artifacts' | 'result' | 'recovery' | 'revision'>
type UpdateTask = Pick<TaskSnapshot, 'task' | 'status' | 'stage' | 'step' | 'expected' | 'progress' | 'updatedAt'
  | 'workflowId' | 'workflowVersion' | 'nodeId' | 'nodeVisitId'> & {
  resultArtifactId: string | null
}

interface CommandReceipt {
  session_id: string
  task_id: string | null
  actor: TaskActorContext['role']
  input_hash: string
  receipt_json: string | null
}

interface ToolOperationRow {
  id: string
  toolName: string
  status: string
  path: string | null
  expectedHash: string | null
  observedHash: string | null
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

  function insert(task: NewTask): void {
    db.prepare(`
      INSERT INTO tasks (id, session_id, task, status, workflow_id, workflow_version, node_id, node_visit_id,
        stage, step, expected_json, progress, created_at, updated_at)
      VALUES (@id, @sessionId, @task, @status, @workflowId, @workflowVersion, @nodeId, @nodeVisitId,
        @stage, @step, @expectedJson, @progress, @createdAt, @updatedAt)
    `).run({ ...task, expectedJson: JSON.stringify(task.expected) })
  }

  function update(id: string, revision: number, state: UpdateTask): void {
    const { changes } = db.prepare(`
      UPDATE tasks SET task = @task, status = @status, stage = @stage, step = @step, expected_json = @expectedJson,
        workflow_id = @workflowId, workflow_version = @workflowVersion, node_id = @nodeId, node_visit_id = @nodeVisitId,
        progress = @progress, result_artifact_id = @resultArtifactId, updated_at = @updatedAt, revision = revision + 1
      WHERE id = @id AND revision = @revision
    `).run({ ...state, id, revision, expectedJson: JSON.stringify(state.expected) })
    if (changes !== 1) throw new Error('Task revision changed inside the command transaction')
  }

  function getCommand(operationId: string): CommandReceipt | undefined {
    return db.prepare<[string], CommandReceipt>(`
      SELECT session_id, task_id, actor, input_hash, receipt_json FROM task_commands WHERE operation_id = ?
    `).get(operationId)
  }

  function saveCommand(input: {
    operationId: string
    taskId: string | null
    actor: TaskActorContext
    inputHash: string
    result: TaskCommandResult
    timestamp: string
  }): void {
    db.prepare(`
      INSERT INTO task_commands (operation_id, session_id, task_id, actor, input_hash, phase,
        receipt_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.operationId, input.actor.sessionId, input.taskId, input.actor.role, input.inputHash,
      input.result.ok ? 'completed' : 'rejected', JSON.stringify(input.result), input.timestamp, input.timestamp)
  }

  function appendEvent(input: {
    id: string
    task: TaskSnapshot
    operationId: string
    actor: TaskActorContext
    type: string
    details?: Record<string, JsonValue>
  }): void {
    db.prepare(`
      INSERT INTO task_events (id, session_id, task_id, operation_id, source_turn_id, actor, type, phase,
        revision, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
    `).run(input.id, input.task.sessionId, input.task.id, input.operationId, input.actor.turnId ?? null,
      input.actor.role, input.type, input.task.revision, JSON.stringify(input.details ?? {}), input.task.updatedAt)
  }

  function insertArtifact(artifact: Omit<TaskArtifact, 'version'>, contentJson: string): void {
    db.prepare(`
      INSERT INTO task_artifacts (id, task_id, key, type, version, hash, content_json, source_message_ids_json,
        source_tool_call_ids_json, created_at)
      SELECT @id, @taskId, @key, @type, COALESCE(MAX(version), 0) + 1, @hash, @contentJson,
        @sourceMessageIdsJson, @sourceToolCallIdsJson, @createdAt
      FROM task_artifacts WHERE task_id = @taskId AND key = @key
    `).run({
      ...artifact,
      contentJson,
      sourceMessageIdsJson: JSON.stringify(artifact.sourceMessageIds),
      sourceToolCallIdsJson: JSON.stringify(artifact.sourceToolCallIds),
    })
  }

  function getArtifact(taskId: string, artifactId: string) {
    const row = db.prepare<[string, string], {
      content_json: string
      source_message_ids_json: string
      source_tool_call_ids_json: string
    }>(`
      SELECT content_json, source_message_ids_json, source_tool_call_ids_json FROM task_artifacts
      WHERE task_id = ? AND id = ?
    `).get(taskId, artifactId)
    return row && {
      content: JSON.parse(row.content_json) as JsonValue,
      sourceMessageIds: JSON.parse(row.source_message_ids_json) as string[],
      sourceToolCallIds: JSON.parse(row.source_tool_call_ids_json) as string[],
    }
  }

  function hasArtifactSources(task: TaskSnapshot, messageIds: string[], toolCallIds: string[]): boolean {
    const message = db.prepare('SELECT 1 FROM messages WHERE id = ? AND session_id = ?')
    const toolCall = db.prepare(`
      SELECT 1 FROM tool_executions execution JOIN turns turn ON turn.id = execution.turn_id
      WHERE execution.tool_call_id = ? AND turn.session_id = ? AND turn.task_id = ?
    `)
    return messageIds.every(id => message.get(id, task.sessionId) !== undefined)
      && toolCallIds.every(id => toolCall.get(id, task.sessionId, task.id) !== undefined)
  }

  function isCleared(requestId: string): boolean {
    return db.prepare('SELECT 1 FROM cleared_requests WHERE request_id = ?').get(requestId) !== undefined
  }

  function getSession(id: string) {
    return db.prepare<[string], { status: string }>('SELECT status FROM sessions WHERE id = ?').get(id)
  }

  function hasPendingClear(sessionId: string): boolean {
    return db.prepare("SELECT 1 FROM history_clear_operations WHERE session_id = ? AND status <> 'completed' LIMIT 1")
      .get(sessionId) !== undefined
  }

  function lastTurnPosition(sessionId: string): number {
    return db.prepare<[string], { position: number }>(
      'SELECT COALESCE(MAX(position), -1) AS position FROM turns WHERE session_id = ?',
    ).get(sessionId)!.position
  }

  function hasRunningTurn(sessionId: string): boolean {
    return db.prepare("SELECT 1 FROM turns WHERE session_id = ? AND status = 'running' LIMIT 1").get(sessionId) !== undefined
  }

  function hasUnresolvedOperations(sessionId: string): boolean {
    return db.prepare(`
      SELECT 1 FROM task_tool_operations operation JOIN tasks task ON task.id = operation.task_id
      WHERE task.session_id = ? AND operation.status IN ('running', 'uncertain')
      LIMIT 1
    `).get(sessionId) !== undefined
  }

  function getTurn(id: string, sessionId: string) {
    return db.prepare<[string, string], { task_id: string | null; status: string }>(`
      SELECT task_id, status FROM turns WHERE id = ? AND session_id = ?
    `).get(id, sessionId)
  }

  function isAwaitingGoal(task: TaskSnapshot): boolean {
    return db.prepare(`
      SELECT 1 FROM task_events
      WHERE session_id = @sessionId AND task_id = @id
        AND type = 'created' AND json_extract(details_json, '$.awaitingGoal') = 1
        AND NOT EXISTS (
          SELECT 1 FROM task_events WHERE session_id = @sessionId AND task_id = @id AND type = 'input_received'
        )
    `).get({ sessionId: task.sessionId, id: task.id }) !== undefined
  }

  function listValidations(taskId: string): ValidationResult[] {
    const rows = db.prepare<[string], Omit<ValidationResult, 'inputs' | 'details'> & { inputsJson: string; detailsJson: string }>(`
      SELECT id, task_id AS taskId, check_id AS checkId, checker_version AS checkerVersion,
        node_visit_id AS nodeVisitId, inputs_json AS inputsJson, outcome, details_json AS detailsJson, created_at AS createdAt
      FROM task_validations WHERE task_id = ? ORDER BY rowid
    `).all(taskId)
    return rows.map(({ inputsJson, detailsJson, ...row }) => ({
      ...row, inputs: JSON.parse(inputsJson), details: JSON.parse(detailsJson),
    }))
  }

  function listRecoveryOperations(taskId: string): TaskView['recoveryOperations'] {
    const rows = db.prepare<[string], ToolOperationRow>(`
      SELECT id, tool_name AS toolName, status, path, expected_hash AS expectedHash, observed_hash AS observedHash
      FROM task_tool_operations WHERE task_id = ? AND status IN ('running', 'uncertain') ORDER BY created_at, id
    `).all(taskId)
    return rows.map(({ path, expectedHash, observedHash, ...operation }) => ({
      ...operation,
      ...(path !== null && { path }),
      ...(expectedHash !== null && { expectedHash }),
      ...(observedHash !== null && { observedHash }),
    }))
  }

  return { get, getUnfinished, list, insert, update, getCommand, saveCommand, appendEvent, insertArtifact,
    getArtifact, hasArtifactSources, isCleared, getSession, hasPendingClear, hasRunningTurn, hasUnresolvedOperations,
    getTurn, lastTurnPosition, isAwaitingGoal, listValidations, listRecoveryOperations }
}
