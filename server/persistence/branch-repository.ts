import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { validateContextStrategySettings, type ChatSessionStatus, type SessionSummary } from '../../shared/chat'
import { assertHistoryAvailable } from '../memory/clear-repository'

export class BranchRepositoryError extends Error {
  constructor(public readonly code: 'SESSION_NOT_FOUND' | 'SESSION_RUNNING' | 'HISTORY_CLEAR_PENDING' | 'INVALID_POINT', message: string) {
    super(message)
    this.name = 'BranchRepositoryError'
  }
}

function now(): string {
  return new Date().toISOString()
}

function makeRunLogId(db: Database.Database, timestamp = Date.now()): string {
  let cursor = timestamp
  let value = new Date(cursor).toISOString()
  while (db.prepare('SELECT 1 FROM sessions WHERE run_log_id = ?').get(value)) {
    cursor += 1
    value = new Date(cursor).toISOString()
  }
  return value
}

export function createBranchRepository(db: Database.Database) {
  function createBranch(input: { parentSessionId: string; throughMessageId: string }): SessionSummary {
    return db.transaction(() => {
      const parent = db.prepare('SELECT * FROM sessions WHERE id = ?').get(input.parentSessionId) as {
        id: string
        run_log_id: string
        title: string
        created_at: string
        model_id: string | null
        context_strategy_json: string
        status: ChatSessionStatus
        project_id: string | null
      } | undefined
      if (!parent) throw new BranchRepositoryError('SESSION_NOT_FOUND', 'parent session was not found')
      try {
        assertHistoryAvailable(db, parent.id)
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'HISTORY_CLEAR_PENDING') {
          throw new BranchRepositoryError('HISTORY_CLEAR_PENDING', error.message)
        }
        throw error
      }
      if (parent.status === 'running' || db.prepare("SELECT 1 FROM turns WHERE session_id = ? AND status = 'running'").get(parent.id)) {
        throw new BranchRepositoryError('SESSION_RUNNING', 'cannot branch while the parent is running')
      }

      const point = db.prepare(`
        SELECT id, position, role, status, payload_json, storage_version
        FROM messages
        WHERE session_id = ? AND id = ?
      `).get(parent.id, input.throughMessageId) as {
        id: string
        position: number
        role: 'user' | 'assistant' | 'system'
        status: 'complete' | 'partial' | 'interrupted'
        payload_json: string
        storage_version: number
      } | undefined
      if (!point || point.role !== 'assistant' || point.status !== 'complete') {
        throw new BranchRepositoryError('INVALID_POINT', 'branch point must be a completed assistant message')
      }

      const childId = randomUUID()
      const timestamp = now()
      const runLogId = makeRunLogId(db)
      const contextStrategy = validateContextStrategySettings(JSON.parse(parent.context_strategy_json))
      const title = `Ветка · ${parent.title}`.slice(0, 120)
      db.prepare(`
        INSERT INTO sessions
          (id, run_log_id, title, created_at, updated_at, status, revision, model_id,
           context_strategy_json, parent_session_id, branch_source_message_id, project_id)
        VALUES (?, ?, ?, ?, ?, 'idle', 0, ?, ?, ?, ?, ?)
      `).run(childId, runLogId, title, timestamp, timestamp, parent.model_id, JSON.stringify(contextStrategy), parent.id, point.id, parent.project_id)

      const messages = db.prepare(`
        SELECT id, position, role, status, payload_json, storage_version, created_at, updated_at
        FROM messages
        WHERE session_id = ? AND position <= ?
        ORDER BY position ASC
      `).all(parent.id, point.position) as Array<{
        id: string
        position: number
        role: 'user' | 'assistant' | 'system'
        status: 'complete' | 'partial' | 'interrupted'
        payload_json: string
        storage_version: number
        created_at: string
        updated_at: string
      }>
      const messageIds = new Map<string, string>()
      const insertMessage = db.prepare(`
        INSERT INTO messages
          (id, session_id, turn_id, position, role, status, payload_json, storage_version, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const message of messages) {
        const newId = randomUUID()
        messageIds.set(message.id, newId)
        const payload = { ...(JSON.parse(message.payload_json) as Record<string, unknown>), id: newId }
        insertMessage.run(newId, childId, message.position, message.role, message.status, JSON.stringify(payload), message.storage_version, message.created_at, message.updated_at)
      }

      const checkpoints = db.prepare(`
        SELECT from_message_position, through_message_position, summary, format_version, prompt_version, model_id, created_at
        FROM context_checkpoints
        WHERE session_id = ? AND through_message_position <= ?
        ORDER BY through_message_position ASC
      `).all(parent.id, point.position) as Array<{
        from_message_position: number
        through_message_position: number
        summary: string
        format_version: number
        prompt_version: number
        model_id: string
        created_at: string
      }>
      const insertCheckpoint = db.prepare(`
        INSERT INTO context_checkpoints
          (id, session_id, from_message_position, through_message_position, summary, format_version, prompt_version, model_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const checkpoint of checkpoints) {
        insertCheckpoint.run(randomUUID(), childId, checkpoint.from_message_position, checkpoint.through_message_position, checkpoint.summary, checkpoint.format_version, checkpoint.prompt_version, checkpoint.model_id, checkpoint.created_at)
      }

      const facts = db.prepare(`
        SELECT source_message_id, through_message_position, facts_json, usage_json, cost_json, status, error, created_at
        FROM facts_updates
        WHERE session_id = ? AND through_message_position <= ?
        ORDER BY through_message_position ASC
      `).all(parent.id, point.position) as Array<{
        source_message_id: string
        through_message_position: number
        facts_json: string
        usage_json: string | null
        cost_json: string | null
        status: 'completed' | 'failed'
        error: string | null
        created_at: string
      }>
      const insertFacts = db.prepare(`
        INSERT INTO facts_updates
          (id, session_id, source_message_id, through_message_position, facts_json, usage_json, cost_json, status, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const fact of facts) {
        const sourceMessageId = messageIds.get(fact.source_message_id)
        if (!sourceMessageId) continue
        insertFacts.run(randomUUID(), childId, sourceMessageId, fact.through_message_position, fact.facts_json, fact.usage_json, fact.cost_json, fact.status, fact.error, fact.created_at)
      }

      return {
        id: childId,
        runLogId,
        title,
        createdAt: timestamp,
        updatedAt: timestamp,
        status: 'idle' as const,
        revision: 0,
        ...(parent.project_id === null ? {} : { projectId: parent.project_id }),
        parentSessionId: parent.id,
        branchSourceMessageId: point.id,
      }
    }).immediate()
  }

  return { createBranch }
}
