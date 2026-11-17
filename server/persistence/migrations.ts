import type Database from 'better-sqlite3'

export const CHAT_SCHEMA_VERSION = 9

export function migrateChatDatabase(db: Database.Database): void {
  const currentVersion = Number(db.pragma('user_version', { simple: true }))

  if (currentVersion > CHAT_SCHEMA_VERSION) {
    throw new Error(`unsupported chat database schema version: ${currentVersion}`)
  }

  if (currentVersion === CHAT_SCHEMA_VERSION) {
    return
  }

  db.exec('BEGIN')
  try {
    if (currentVersion === 0) db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        run_log_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT,
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'running', 'completed', 'failed', 'stopped', 'interrupted', 'needs_review')),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL UNIQUE,
        source_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        status TEXT NOT NULL
          CHECK (status IN ('running', 'completed', 'failed', 'stopped', 'interrupted', 'needs_review')),
        model_id TEXT NOT NULL,
        agent_config_json TEXT NOT NULL CHECK (json_valid(agent_config_json)),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, position)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'interrupted')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        storage_version INTEGER NOT NULL DEFAULT 1 CHECK (storage_version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, position)
      );

      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL CHECK (step_index >= 0),
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        input_json TEXT NOT NULL CHECK (json_valid(input_json)),
        output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (turn_id, tool_call_id)
      );

      CREATE TABLE IF NOT EXISTS dice_rolls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_call_id TEXT NOT NULL UNIQUE,
        sides INTEGER NOT NULL CHECK (sides >= 2 AND sides <= 1000),
        result INTEGER NOT NULL CHECK (result >= 1 AND result <= sides),
        rolled_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'runtime',
        source_row_index INTEGER,
        UNIQUE (source, source_row_index)
      );

      CREATE INDEX IF NOT EXISTS sessions_updated_at_idx
        ON sessions (updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS sessions_last_opened_at_idx
        ON sessions (last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS messages_session_position_idx
        ON messages (session_id, position);
      CREATE INDEX IF NOT EXISTS turns_session_position_idx
        ON turns (session_id, position);
    `)
    if (currentVersion < 2) db.exec('ALTER TABLE sessions ADD COLUMN model_id TEXT')
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turns'").get()) {
      if (currentVersion < 3) {
        db.exec('ALTER TABLE turns ADD COLUMN stop_reason TEXT')
      } else if (currentVersion === 3) {
        const reasons = db.prepare('SELECT id, stop_reason FROM turns WHERE stop_reason IS NOT NULL')
          .all() as Array<{ id: string; stop_reason: string }>
        db.exec('ALTER TABLE turns DROP COLUMN stop_reason')
        db.exec('ALTER TABLE turns ADD COLUMN stop_reason TEXT')
        const restore = db.prepare('UPDATE turns SET stop_reason = ? WHERE id = ?')
        for (const reason of reasons) restore.run(reason.stop_reason, reason.id)
      }
    }
    if (currentVersion < 5) db.exec(`
      CREATE TABLE IF NOT EXISTS context_checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        from_message_position INTEGER NOT NULL CHECK (from_message_position >= 0),
        through_message_position INTEGER NOT NULL CHECK (through_message_position >= from_message_position),
        summary TEXT NOT NULL,
        format_version INTEGER NOT NULL CHECK (format_version >= 1),
        prompt_version INTEGER NOT NULL CHECK (prompt_version >= 1),
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, through_message_position)
      );

      CREATE TABLE IF NOT EXISTS compaction_attempts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK (trigger IN ('message_count', 'context_fraction', 'fallback_limit')),
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        model_id TEXT NOT NULL,
        from_message_position INTEGER NOT NULL CHECK (from_message_position >= 0),
        through_message_position INTEGER NOT NULL CHECK (through_message_position >= from_message_position),
        estimated_before_tokens INTEGER NOT NULL CHECK (estimated_before_tokens >= 0),
        estimated_after_tokens INTEGER NOT NULL CHECK (estimated_after_tokens >= 0),
        usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
        cost_json TEXT CHECK (cost_json IS NULL OR json_valid(cost_json)),
        checkpoint_id TEXT REFERENCES context_checkpoints(id) ON DELETE SET NULL,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS context_checkpoints_session_position_idx
        ON context_checkpoints (session_id, through_message_position DESC);
      CREATE INDEX IF NOT EXISTS compaction_attempts_session_started_idx
        ON compaction_attempts (session_id, started_at ASC);
    `)
    if (currentVersion < 6 && !db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'context_strategy_json'").get()) {
      db.exec(`
        ALTER TABLE sessions
        ADD COLUMN context_strategy_json TEXT NOT NULL
          DEFAULT '{"strategy":"summary","windowSize":10,"messageThreshold":20}'
          CHECK (json_valid(context_strategy_json));
      `)
    }
    if (currentVersion < 7) db.exec(`
      CREATE TABLE IF NOT EXISTS facts_updates (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_message_id TEXT NOT NULL,
        through_message_position INTEGER NOT NULL CHECK (through_message_position >= 0),
        facts_json TEXT NOT NULL CHECK (json_valid(facts_json)),
        usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
        cost_json TEXT CHECK (cost_json IS NULL OR json_valid(cost_json)),
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, source_message_id)
      );
      CREATE INDEX IF NOT EXISTS facts_updates_session_position_idx
        ON facts_updates (session_id, through_message_position DESC);
    `)
    if (currentVersion < 8 && !db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'parent_session_id'").get()) {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
        ALTER TABLE sessions ADD COLUMN branch_source_message_id TEXT;
        CREATE INDEX IF NOT EXISTS sessions_parent_idx ON sessions (parent_session_id);
      `)
    }
    if (currentVersion < 9 && !db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'project_id'").get()) {
      db.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL')
    }
    if (currentVersion < 9) db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS working_memory_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK (category IN ('goal', 'constraint', 'state', 'result', 'note')),
        memory_key TEXT NOT NULL,
        value TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS working_memory_project_idx
        ON working_memory_entries (project_id, enabled, category, memory_key, id);

      CREATE TABLE IF NOT EXISTS long_term_facts (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('profile', 'decision', 'knowledge')),
        memory_key TEXT NOT NULL,
        value TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        global_enabled INTEGER NOT NULL DEFAULT 0 CHECK (global_enabled IN (0, 1)),
        source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS long_term_facts_enabled_idx
        ON long_term_facts (enabled, global_enabled, category, memory_key, id);

      CREATE TABLE IF NOT EXISTS project_long_term_facts (
        fact_id TEXT NOT NULL REFERENCES long_term_facts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (fact_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS project_long_term_facts_project_idx
        ON project_long_term_facts (project_id, fact_id);

      CREATE TABLE IF NOT EXISTS memory_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        working_tokens INTEGER NOT NULL CHECK (working_tokens BETWEEN 100 AND 100000),
        long_term_tokens INTEGER NOT NULL CHECK (long_term_tokens BETWEEN 100 AND 100000),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO memory_settings (id, working_tokens, long_term_tokens, revision, updated_at)
      VALUES (1, 2000, 2000, 0, datetime('now'));

      CREATE TABLE IF NOT EXISTS memory_usage_events (
        id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL UNIQUE,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
        prepared_at TEXT NOT NULL,
        context_cleared INTEGER NOT NULL DEFAULT 0 CHECK (context_cleared IN (0, 1)),
        short_term_count INTEGER NOT NULL CHECK (short_term_count >= 0),
        short_term_bytes INTEGER NOT NULL CHECK (short_term_bytes >= 0),
        short_term_tokens INTEGER NOT NULL CHECK (short_term_tokens >= 0),
        working_count INTEGER NOT NULL CHECK (working_count >= 0),
        working_bytes INTEGER NOT NULL CHECK (working_bytes >= 0),
        working_tokens INTEGER NOT NULL CHECK (working_tokens >= 0),
        long_term_count INTEGER NOT NULL CHECK (long_term_count >= 0),
        long_term_bytes INTEGER NOT NULL CHECK (long_term_bytes >= 0),
        long_term_tokens INTEGER NOT NULL CHECK (long_term_tokens >= 0),
        working_refs_json TEXT NOT NULL CHECK (json_valid(working_refs_json)),
        long_term_refs_json TEXT NOT NULL CHECK (json_valid(long_term_refs_json))
      );
      CREATE INDEX IF NOT EXISTS memory_usage_events_scope_idx
        ON memory_usage_events (session_id, project_id, prepared_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS history_clear_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        old_run_log_id TEXT NOT NULL,
        new_run_log_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending_files', 'completed', 'failed')),
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS history_clear_pending_session_idx
        ON history_clear_operations (session_id) WHERE status = 'pending_files';

      CREATE TABLE IF NOT EXISTS cleared_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        cleared_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cleared_tool_calls (
        tool_call_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        cleared_at TEXT NOT NULL
      );
    `)
    db.pragma(`user_version = ${CHAT_SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
