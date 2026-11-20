import type Database from 'better-sqlite3'

export function removeTaskSchema(db: Database.Database): void {
  const foreignKeys = db.pragma('foreign_keys', { simple: true })
  db.pragma('foreign_keys = OFF')
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS turns_task_owner_insert;
      DROP TRIGGER IF EXISTS turns_task_owner_update;
      DROP TRIGGER IF EXISTS turns_tool_execution_owner_update;
      DROP TRIGGER IF EXISTS tool_executions_task_owner_insert;
      DROP TRIGGER IF EXISTS tool_executions_task_owner_update;
    `)
    for (const [table, columns] of [
      ['turns', ['task_id']],
      ['tool_executions', ['task_id', 'task_operation_id']],
      ['user_profiles', ['default_workflow_id']],
    ] as const) {
      for (const column of columns) {
        if (db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column)) {
          db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
        }
      }
    }
    db.exec(`
      DROP TABLE IF EXISTS task_tool_operations;
      DROP TABLE IF EXISTS task_events;
      DROP TABLE IF EXISTS task_commands;
      DROP TABLE IF EXISTS task_validations;
      DROP TABLE IF EXISTS task_approvals;
      DROP TABLE IF EXISTS task_artifacts;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS workflow_versions;
      DROP TABLE IF EXISTS workflows;
    `)
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
  }
}
