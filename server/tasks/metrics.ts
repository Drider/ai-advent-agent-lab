import type Database from 'better-sqlite3'
import type { TaskTransitionOutcome } from '../../shared/task'

export type TaskTransitionEventAction = 'requested' | TaskTransitionOutcome

export interface TaskTransitionEvent {
  taskId: string
  pendingTransitionId: string
  action: TaskTransitionEventAction
  revision: number
  at: string
}

export interface TaskMetricsSummary {
  taskId: string
  templateId: string
  status: string
  turnCount: number
  requestedCount: number
  repeatedRequestCount: number
  repeatRequestRate: number
  confirmationCount: number
  averageConfirmationWaitMs: number | null
  durationMs: number | null
}

interface TransitionMetricRow {
  id: string
  task_id: string
  requested_at: string
  outcome: TaskTransitionOutcome | null
  resolved_at: string | null
  requested_revision: number
  resolved_revision: number | null
  repeat_count: number
}

export function createTaskMetrics(db: Database.Database) {
  function rows(taskId: string): TransitionMetricRow[] {
    return db.prepare(`
      SELECT id, task_id, requested_at, outcome, resolved_at,
             requested_revision, resolved_revision, repeat_count
      FROM task_transitions
      WHERE task_id = ?
      ORDER BY requested_at ASC, rowid ASC
    `).all(taskId) as TransitionMetricRow[]
  }

  function listEvents(taskId: string): TaskTransitionEvent[] {
    return rows(taskId).flatMap((row) => {
      const requested: TaskTransitionEvent = {
        taskId: row.task_id,
        pendingTransitionId: row.id,
        action: 'requested',
        revision: row.requested_revision,
        at: row.requested_at,
      }
      if (!row.outcome || !row.resolved_at || row.resolved_revision === null) return [requested]
      return [requested, {
        taskId: row.task_id,
        pendingTransitionId: row.id,
        action: row.outcome,
        revision: row.resolved_revision,
        at: row.resolved_at,
      }]
    })
  }

  function summarize(taskId: string): TaskMetricsSummary {
    const task = db.prepare(`
      SELECT id, session_id, template_id, status, created_at, updated_at
      FROM tasks WHERE id = ?
    `).get(taskId) as {
      id: string
      session_id: string
      template_id: string
      status: string
      created_at: string
      updated_at: string
    } | undefined
    if (!task) throw new Error(`task ${taskId} was not found`)
    const transitions = rows(taskId)
    const repeatedRequestCount = transitions.reduce((total, row) => total + row.repeat_count, 0)
    const totalRequests = transitions.length + repeatedRequestCount
    const confirmationWaits = transitions.flatMap(row => row.resolved_at && (row.outcome === 'approved' || row.outcome === 'rejected')
      ? [Math.max(0, Date.parse(row.resolved_at) - Date.parse(row.requested_at))]
      : [])
    const turnCount = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM turns
      WHERE session_id = ? AND started_at >= ? AND started_at <= ?
    `).get(task.session_id, task.created_at, task.updated_at) as { count: number }).count
    return {
      taskId: task.id,
      templateId: task.template_id,
      status: task.status,
      turnCount,
      requestedCount: transitions.length,
      repeatedRequestCount,
      repeatRequestRate: totalRequests === 0 ? 0 : repeatedRequestCount / totalRequests,
      confirmationCount: confirmationWaits.length,
      averageConfirmationWaitMs: confirmationWaits.length === 0
        ? null
        : confirmationWaits.reduce((total, wait) => total + wait, 0) / confirmationWaits.length,
      durationMs: task.status === 'done' ? Math.max(0, Date.parse(task.updated_at) - Date.parse(task.created_at)) : null,
    }
  }

  return { listEvents, summarize }
}
