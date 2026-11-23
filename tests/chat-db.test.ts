import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createTaskRepository } from '../server/persistence/task-repository'

const temporaryDirectories: string[] = []

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-db-'))
  temporaryDirectories.push(directory)
  return join(directory, 'chat.sqlite')
}

function insertSession(db: Database.Database, id = randomUUID()): string {
  const now = '2026-11-10T12:00:00.000Z'
  const { default_profile_id: defaultProfileId } = db.prepare('SELECT default_profile_id FROM user_profile_settings WHERE id = 1').get() as { default_profile_id: string }
  db.prepare(`
    INSERT INTO sessions
      (id, run_log_id, title, created_at, updated_at, last_opened_at, status, revision, user_profile_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, now, 'Новый диалог', now, now, null, 'idle', 0, defaultProfileId)
  return id
}

function insertMessage(db: Database.Database, sessionId: string, position: number, payload = '{}'): void {
  const now = '2026-11-10T12:00:00.000Z'
  db.prepare(`
    INSERT INTO messages
      (id, session_id, turn_id, position, role, status, payload_json, storage_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), sessionId, null, position, 'user', 'complete', payload, 1, now, now)
}

function downgradeUserProfiles(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS sessions_user_profile_required_insert;
    DROP TRIGGER IF EXISTS sessions_user_profile_required_update;
    DROP INDEX IF EXISTS sessions_user_profile_idx;
    DROP TABLE IF EXISTS user_profile_settings;
    ALTER TABLE sessions DROP COLUMN user_profile_id;
    DROP TABLE IF EXISTS user_profiles;
  `)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('chat database', () => {
  it('opens, migrates, and reopens the same database idempotently', async () => {
    const filePath = await createDatabasePath()
    const first = openChatDatabase(filePath)

    expect(first.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(first.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(first.pragma('busy_timeout', { simple: true })).toBe(1000)
    expect(first.pragma('synchronous', { simple: true })).toBe(2)
    expect(first.pragma('user_version', { simple: true })).toBe(19)
    first.close()

    const second = openChatDatabase(filePath)
    expect(second.pragma('user_version', { simple: true })).toBe(19)
    expect(second.prepare('SELECT name, instructions FROM user_profiles').get()).toEqual({ name: 'Основной', instructions: '' })
    expect(second.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name").all()).toEqual([
      { name: 'cleared_requests' },
      { name: 'cleared_tool_calls' },
      { name: 'compaction_attempts' },
      { name: 'context_checkpoints' },
      { name: 'dice_rolls' },
      { name: 'facts_updates' },
      { name: 'history_clear_operations' },
      { name: 'invariant_changes' },
      { name: 'invariants' },
      { name: 'long_term_facts' },
      { name: 'memory_changes' },
      { name: 'memory_settings' },
      { name: 'memory_usage_events' },
      { name: 'messages' },
      { name: 'model_configurations' },
      { name: 'project_long_term_facts' },
      { name: 'projects' },
      { name: 'sessions' },
      { name: 'task_transitions' },
      { name: 'tasks' },
      { name: 'tool_executions' },
      { name: 'turns' },
      { name: 'user_profile_settings' },
      { name: 'user_profiles' },
      { name: 'working_memory_entries' },
    ])
    second.close()
  })

  it('adds empty answers to tasks created before v15', async () => {
    const filePath = await createDatabasePath()
    const oldDb = openChatDatabase(filePath)
    const sessionId = insertSession(oldDb)
    const now = '2026-11-10T12:00:00.000Z'
    oldDb.prepare(`
      INSERT INTO tasks
        (id, session_id, template_id, goal, stage, step, status, artifacts_json, answers_json, created_at, updated_at)
      VALUES (?, ?, 'onboarding', 'Знакомство', 'interview', '', 'active', '{}', '{}', ?, ?)
    `).run(randomUUID(), sessionId, now, now)
    oldDb.exec('ALTER TABLE tasks DROP COLUMN answers_json; PRAGMA user_version = 14;')
    oldDb.close()

    const upgraded = openChatDatabase(filePath)
    expect(createTaskRepository(upgraded).getForSession(sessionId)?.answers).toEqual({})
    upgraded.close()
  })

  it('migrates a version 15 pending transition into durable transition history', async () => {
    const filePath = await createDatabasePath()
    const oldDb = openChatDatabase(filePath)
    const sessionId = insertSession(oldDb)
    const taskId = randomUUID()
    const timestamp = '2026-11-21T10:00:00.000Z'
    oldDb.prepare(`
      INSERT INTO tasks
        (id, session_id, template_id, goal, stage, step, status, pending_stage,
         pending_summary, artifacts_json, answers_json, created_at, updated_at)
      VALUES (?, ?, 'dev', 'Отчёт', 'planning', '', 'active', 'execution',
              'План готов', '{}', '{}', ?, ?)
    `).run(taskId, sessionId, timestamp, timestamp)
    oldDb.exec('DROP TABLE IF EXISTS task_transitions')
    const taskColumns = oldDb.prepare("SELECT name FROM pragma_table_info('tasks')").all() as Array<{ name: string }>
    if (taskColumns.some(column => column.name === 'revision')) oldDb.exec('ALTER TABLE tasks DROP COLUMN revision')
    oldDb.pragma('user_version = 15')
    oldDb.close()

    const upgraded = openChatDatabase(filePath)
    const snapshot = createTaskRepository(upgraded).getSnapshot(sessionId)

    expect(upgraded.pragma('user_version', { simple: true })).toBe(19)
    expect(snapshot).toMatchObject({
      id: taskId,
      revision: 0,
      pendingTransition: {
        id: expect.any(String),
        to: 'execution',
        summary: 'План готов',
        requestedAt: expect.any(String),
        expiresAt: expect.any(String),
      },
    })
    expect(upgraded.prepare('SELECT task_id, from_stage, to_stage, summary, outcome FROM task_transitions').get()).toEqual({
      task_id: taskId,
      from_stage: 'planning',
      to_stage: 'execution',
      summary: 'План готов',
      outcome: null,
    })
    upgraded.close()
  })

  it('adds model selection to existing version 1 sessions', async () => {
    const filePath = await createDatabasePath()
    const oldDb = new Database(filePath)
    oldDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        run_log_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      INSERT INTO sessions VALUES (
        'old-session', 'old-run', 'Старый диалог',
        '2026-11-10T12:00:00.000Z', '2026-11-10T12:00:00.000Z',
        NULL, 'idle', 0
      );
      PRAGMA user_version = 1;
    `)
    oldDb.close()

    const upgraded = openChatDatabase(filePath)
    expect(upgraded.pragma('user_version', { simple: true })).toBe(19)
    expect(upgraded.prepare('SELECT model_id FROM sessions WHERE id = ?').get('old-session')).toEqual({ model_id: null })
    expect(upgraded.prepare(`SELECT s.user_profile_id, p.name FROM sessions s JOIN user_profiles p ON p.id = s.user_profile_id WHERE s.id = ?`).get('old-session'))
      .toMatchObject({ user_profile_id: expect.any(String), name: 'Основной' })
    expect(upgraded.prepare('SELECT default_profile_id FROM user_profile_settings WHERE id = 1').get())
      .toEqual(upgraded.prepare('SELECT user_profile_id AS default_profile_id FROM sessions WHERE id = ?').get('old-session'))
    upgraded.close()
  })

  it('adds stop reasons when upgrading a version 2 database', async () => {
    const filePath = await createDatabasePath()
    const oldDb = openChatDatabase(filePath)
    oldDb.exec('ALTER TABLE turns DROP COLUMN stop_reason; PRAGMA user_version = 2;')
    downgradeUserProfiles(oldDb)
    oldDb.pragma('user_version = 2')
    oldDb.close()

    const upgraded = openChatDatabase(filePath)
    expect(upgraded.pragma('user_version', { simple: true })).toBe(19)
    expect(upgraded.pragma('table_info(turns)')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'stop_reason' }),
    ]))
    upgraded.close()
  })

  it('preserves stop reasons when upgrading the version 3 constraint', async () => {
    const filePath = await createDatabasePath()
    const oldDb = openChatDatabase(filePath)
    oldDb.exec("ALTER TABLE turns DROP COLUMN stop_reason; ALTER TABLE turns ADD COLUMN stop_reason TEXT CHECK (stop_reason IN ('timeout', 'agent_error'));")
    const sessionId = insertSession(oldDb)
    const turnId = randomUUID()
    const now = '2026-11-10T12:00:00.000Z'
    oldDb.prepare(`
      INSERT INTO turns (id, session_id, request_id, position, status, model_id, agent_config_json, started_at, updated_at, stop_reason)
      VALUES (?, ?, ?, 0, 'interrupted', 'mock', '{}', ?, ?, 'timeout')
    `).run(turnId, sessionId, turnId, now, now)
    downgradeUserProfiles(oldDb)
    oldDb.pragma('user_version = 3')
    oldDb.close()

    const upgraded = openChatDatabase(filePath)
    expect(upgraded.pragma('user_version', { simple: true })).toBe(19)
    expect(upgraded.prepare('SELECT stop_reason FROM turns WHERE id = ?').get(turnId)).toEqual({ stop_reason: 'timeout' })
    upgraded.prepare("UPDATE turns SET stop_reason = 'rate_limit' WHERE id = ?").run(turnId)
    upgraded.close()
  })

  it('upgrades a version 8 copy without losing dialogue history', async () => {
    const filePath = await createDatabasePath()
    const db = openChatDatabase(filePath)
    const sessionId = insertSession(db)
    insertMessage(db, sessionId, 0, JSON.stringify({ id: 'version-8-message', role: 'user', parts: [{ type: 'text', text: 'Старое сообщение' }] }))

    db.pragma('foreign_keys = OFF')
    for (const table of [
      'memory_usage_events',
      'history_clear_operations',
      'cleared_requests',
      'cleared_tool_calls',
      'project_long_term_facts',
      'long_term_facts',
      'working_memory_entries',
      'memory_settings',
      'projects',
    ]) db.exec(`DROP TABLE ${table}`)
    db.exec('ALTER TABLE sessions DROP COLUMN project_id; PRAGMA user_version = 8')
    downgradeUserProfiles(db)
    db.pragma('user_version = 8')
    db.close()

    const upgraded = openChatDatabase(filePath)
    expect(upgraded.pragma('user_version', { simple: true })).toBe(19)
    expect(upgraded.prepare('SELECT payload_json FROM messages WHERE session_id = ?').get(sessionId)).toEqual({
      payload_json: JSON.stringify({ id: 'version-8-message', role: 'user', parts: [{ type: 'text', text: 'Старое сообщение' }] }),
    })
    expect(upgraded.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId)).toEqual({ project_id: null })
    expect(upgraded.prepare('SELECT working_tokens, long_term_tokens FROM memory_settings WHERE id = 1').get()).toEqual({
      working_tokens: 2000,
      long_term_tokens: 2000,
    })
    upgraded.close()
  })

  it('rejects malformed JSON, duplicate positions, and broken foreign keys', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessionId = insertSession(db)

    expect(() => insertMessage(db, sessionId, 0, '{not-json')).toThrow()
    insertMessage(db, sessionId, 0)
    expect(() => insertMessage(db, sessionId, 0)).toThrow()
    expect(() => db.prepare(`
      INSERT INTO turns
        (id, session_id, request_id, position, status, model_id, agent_config_json, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), randomUUID(), randomUUID(), 0, 'running', 'mock', '{}', '2026-11-10T12:00:00.000Z')).toThrow()
    db.close()
  })
})
