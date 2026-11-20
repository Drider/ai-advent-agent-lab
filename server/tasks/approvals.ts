import type Database from 'better-sqlite3'
import type { TaskView } from '../../shared/task'

type Approval = TaskView['approvals'][number]
type ApprovalRow = Approval['artifact'] & { requestId: string; status: Approval['status'] }

export function createApprovalStore(db: Database.Database) {
  const listRows = db.prepare<[string], ApprovalRow>(`SELECT r.id AS requestId, r.status,
    a.id, a.key, a.type, a.version, a.hash FROM task_approvals r
    JOIN task_artifacts a ON a.task_id = r.task_id AND a.id = r.artifact_id
    WHERE r.task_id = ? ORDER BY r.rowid`)

  function obsolete(taskId: string, key: string, at: string) {
    db.prepare(`UPDATE task_approvals SET status = 'obsolete', updated_at = ?
      WHERE task_id = ? AND status <> 'obsolete'
      AND artifact_id IN (SELECT id FROM task_artifacts WHERE task_id = ? AND key = ?)`).run(at, taskId, taskId, key)
  }

  return {
    list(taskId: string): Approval[] {
      return listRows.all(taskId).map(({ requestId, status, ...artifact }) => ({ id: requestId, status, artifact }))
    },
    obsolete,
    request(id: string, taskId: string, artifactId: string, key: string, visit: string, at: string) {
      // At most one non-obsolete request per task and slot. Its immutable artifact supplies version and hash.
      obsolete(taskId, key, at)
      db.prepare(`INSERT INTO task_approvals (id, task_id, artifact_id, node_visit_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run(id, taskId, artifactId, visit, at, at)
    },
    approve(id: string, taskId: string, artifactId: string, visit: string, turnId: string | undefined, at: string) {
      return db.prepare(`UPDATE task_approvals SET status = 'approved', updated_at = ?, source_turn_id = ?
        WHERE id = ? AND task_id = ? AND artifact_id = ? AND node_visit_id = ? AND status = 'pending'`)
        .run(at, turnId ?? null, id, taskId, artifactId, visit).changes === 1
    },
  }
}
