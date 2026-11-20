import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

// A worker identity changes on process/module restart. Other workers honor the durable lease.
export const validationWorker = randomUUID()
export const activeValidationRuns = new Set<string>()

export function validationAbandoned(token: string, worker: string | null, leaseUntil: number | null) {
  if (worker === validationWorker) return !activeValidationRuns.has(token)
  return (leaseUntil ?? 0) <= Date.now()
}

// The validation_requested event and the execution get the same fresh attempt ID before I/O.
// Earlier versions only recorded the command's turn and, sometimes, a failed call ID.
export function reconcileValidationReceipts(db: Database.Database, turnId: string, scope: { reservationId?: string; executionId?: string } = {}) {
  db.transaction(() => {
    const candidates = db.prepare<[string, string | null, string | null], {
      token: string; execution: string; worker: string | null; lease: number | null; legacyFailure: string | null
    }>(`
      SELECT v.id AS token, e.id AS execution, json_extract(v.details_json, '$.worker') AS worker,
        json_extract(v.details_json, '$.leaseUntil') AS lease, json_extract(v.details_json, '$.toolError') AS legacyFailure
      FROM task_events v JOIN task_commands c ON c.operation_id = v.operation_id AND c.phase = 'running'
      JOIN tool_executions e ON e.turn_id = v.source_turn_id AND e.task_id = v.task_id
        AND json_extract(e.input_json, '$.operationId') = v.operation_id AND e.task_operation_id IS NULL
        AND e.tool_name IN ('run_task_checks', 'request_task_transition', 'finish_task')
      WHERE v.source_turn_id = ? AND v.type = 'validation_requested'
        AND v.id = COALESCE(?, v.id) AND e.id = COALESCE(?, e.id)
        AND json_extract(v.details_json, '$.abandoned') IS NOT 1
        AND (e.id = v.id OR (json_extract(v.details_json, '$.worker') IS NULL
          AND e.tool_call_id = COALESCE(json_extract(v.details_json, '$.failedToolCallId'), e.tool_call_id)))
        AND (e.status = 'running' OR json_extract(v.details_json, '$.failedToolCallId') IS NOT NULL)
    `).all(turnId, scope.reservationId ?? null, scope.executionId ?? null)
    for (const row of candidates) {
      if (!row.legacyFailure && !validationAbandoned(row.token, row.worker, row.lease)) continue
      db.prepare(`UPDATE tool_executions SET status = 'failed', error_json = ?, updated_at = ?
        WHERE id = ? AND status = 'running'`).run(JSON.stringify(row.legacyFailure ?? 'Validation did not commit'), new Date().toISOString(), row.execution)
      db.prepare(`UPDATE task_events SET details_json = json_set(json_remove(details_json, '$.failedToolCallId', '$.toolError'),
        '$.leaseUntil', 0, '$.abandoned', 1) WHERE id = ?`).run(row.token)
    }
  }).deferred()
}
