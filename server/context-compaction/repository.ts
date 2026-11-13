import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { validateUIMessages } from 'ai'
import {
  CHAT_MESSAGE_STORAGE_VERSION,
  type ChatUIMessage,
} from '../../shared/chat'
import type {
  BeginCompactionAttemptInput,
  CompactionAttempt,
  ContextCheckpoint,
  FinishCompactionAttemptInput,
  StoredContextMessage,
} from './types'

interface MessageRow {
  id: string
  position: number
  role: ChatUIMessage['role']
  status: StoredContextMessage['status']
  payload_json: string
  storage_version: number
}

interface CheckpointRow {
  id: string
  session_id: string
  from_message_position: number
  through_message_position: number
  summary: string
  format_version: number
  prompt_version: number
  model_id: string
  created_at: string
}

interface AttemptRow {
  id: string
  session_id: string
  turn_id: string
  trigger: CompactionAttempt['trigger']
  status: CompactionAttempt['status']
  model_id: string
  from_message_position: number
  through_message_position: number
  estimated_before_tokens: number
  estimated_after_tokens: number
  usage_json: string | null
  cost_json: string | null
  checkpoint_id: string | null
  error: string | null
  started_at: string
  finished_at: string | null
}

const CHECKPOINT_FORMAT_VERSION = 1
const SUMMARY_PROMPT_VERSION = 1

function now(): string {
  return new Date().toISOString()
}

function decodeJson<T>(value: string | null): T | undefined {
  if (value === null) return undefined
  return JSON.parse(value) as T
}

function toCheckpoint(row: CheckpointRow): ContextCheckpoint {
  return {
    id: row.id,
    sessionId: row.session_id,
    fromMessagePosition: row.from_message_position,
    throughMessagePosition: row.through_message_position,
    summary: row.summary,
    formatVersion: row.format_version,
    promptVersion: row.prompt_version,
    modelId: row.model_id,
    createdAt: row.created_at,
  }
}

function toAttempt(row: AttemptRow): CompactionAttempt {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    trigger: row.trigger,
    status: row.status,
    modelId: row.model_id,
    fromMessagePosition: row.from_message_position,
    throughMessagePosition: row.through_message_position,
    estimatedBeforeTokens: row.estimated_before_tokens,
    estimatedAfterTokens: row.estimated_after_tokens,
    ...(decodeJson<CompactionAttempt['usage']>(row.usage_json) === undefined ? {} : { usage: decodeJson<CompactionAttempt['usage']>(row.usage_json) }),
    ...(decodeJson<CompactionAttempt['costRub']>(row.cost_json) === undefined ? {} : { costRub: decodeJson<CompactionAttempt['costRub']>(row.cost_json) }),
    ...(row.checkpoint_id === null ? {} : { checkpointId: row.checkpoint_id }),
    ...(row.error === null ? {} : { error: row.error }),
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  }
}

async function decodeMessage(row: MessageRow): Promise<StoredContextMessage> {
  if (row.storage_version !== CHAT_MESSAGE_STORAGE_VERSION) {
    throw new Error(`stored message ${row.id} uses unsupported version ${row.storage_version}`)
  }
  const parsed = JSON.parse(row.payload_json) as unknown
  const [message] = await validateUIMessages<ChatUIMessage>({ messages: [parsed] })
  if (!message || message.id !== row.id || message.role !== row.role) {
    throw new Error(`stored message ${row.id} identity does not match its row`)
  }
  return { position: row.position, status: row.status, message }
}

export function createCompactionRepository(db: Database.Database) {
  const transaction = <T>(callback: () => T): T => db.transaction(callback).immediate()

  async function loadMessages(sessionId: string): Promise<StoredContextMessage[]> {
    const rows = db.prepare(`
      SELECT id, position, role, status, payload_json, storage_version
      FROM messages
      WHERE session_id = ?
      ORDER BY position ASC
    `).all(sessionId) as MessageRow[]
    const messages: StoredContextMessage[] = []
    for (const row of rows) messages.push(await decodeMessage(row))
    return messages
  }

  function latestCheckpoint(sessionId: string): ContextCheckpoint | null {
    const row = db.prepare(`
      SELECT id, session_id, from_message_position, through_message_position, summary,
             format_version, prompt_version, model_id, created_at
      FROM context_checkpoints
      WHERE session_id = ?
      ORDER BY through_message_position DESC
      LIMIT 1
    `).get(sessionId) as CheckpointRow | undefined
    return row === undefined ? null : toCheckpoint(row)
  }

  function beginAttempt(input: BeginCompactionAttemptInput): string {
    const id = randomUUID()
    db.prepare(`
      INSERT INTO compaction_attempts
        (id, session_id, turn_id, trigger, status, model_id, from_message_position,
         through_message_position, estimated_before_tokens, estimated_after_tokens,
         started_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sessionId,
      input.turnId,
      input.trigger,
      input.modelId,
      input.fromMessagePosition,
      input.throughMessagePosition,
      input.estimatedBeforeTokens,
      input.estimatedAfterTokens,
      now(),
    )
    return id
  }

  function finishAttempt(input: FinishCompactionAttemptInput): ContextCheckpoint | null {
    return transaction(() => {
      const attempt = db.prepare('SELECT * FROM compaction_attempts WHERE id = ?').get(input.attemptId) as AttemptRow | undefined
      if (!attempt) throw new Error(`compaction attempt ${input.attemptId} was not found`)
      if (attempt.status !== 'running') throw new Error(`compaction attempt ${input.attemptId} is already finished`)
      const timestamp = now()

      if (input.status === 'failed') {
        db.prepare(`
          UPDATE compaction_attempts
          SET status = 'failed', usage_json = ?, cost_json = ?, error = ?, finished_at = ?
          WHERE id = ?
        `).run(
          input.usage === undefined ? null : JSON.stringify(input.usage),
          input.costRub === undefined ? null : JSON.stringify(input.costRub),
          input.error ?? 'compaction failed',
          timestamp,
          input.attemptId,
        )
        return null
      }

      const summary = input.summary?.trim()
      if (!summary) throw new Error('compaction summary must not be empty')
      const previous = db.prepare(`
        SELECT through_message_position
        FROM context_checkpoints
        WHERE session_id = ?
        ORDER BY through_message_position DESC
        LIMIT 1
      `).get(attempt.session_id) as { through_message_position: number } | undefined
      if (previous && attempt.through_message_position <= previous.through_message_position) {
        throw new Error('checkpoint position must advance')
      }

      const checkpointId = randomUUID()
      db.prepare(`
        INSERT INTO context_checkpoints
          (id, session_id, from_message_position, through_message_position, summary,
           format_version, prompt_version, model_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpointId,
        attempt.session_id,
        attempt.from_message_position,
        attempt.through_message_position,
        summary,
        CHECKPOINT_FORMAT_VERSION,
        SUMMARY_PROMPT_VERSION,
        attempt.model_id,
        timestamp,
      )
      db.prepare(`
        UPDATE compaction_attempts
        SET status = 'completed', usage_json = ?, cost_json = ?, checkpoint_id = ?, finished_at = ?
        WHERE id = ?
      `).run(
        input.usage === undefined ? null : JSON.stringify(input.usage),
        input.costRub === undefined ? null : JSON.stringify(input.costRub),
        checkpointId,
        timestamp,
        input.attemptId,
      )
      return toCheckpoint({
        id: checkpointId,
        session_id: attempt.session_id,
        from_message_position: attempt.from_message_position,
        through_message_position: attempt.through_message_position,
        summary,
        format_version: CHECKPOINT_FORMAT_VERSION,
        prompt_version: SUMMARY_PROMPT_VERSION,
        model_id: attempt.model_id,
        created_at: timestamp,
      })
    })
  }

  function listAttempts(sessionId: string): CompactionAttempt[] {
    const rows = db.prepare(`
      SELECT * FROM compaction_attempts
      WHERE session_id = ?
      ORDER BY started_at ASC, id ASC
    `).all(sessionId) as AttemptRow[]
    return rows.map(toAttempt)
  }

  return { loadMessages, latestCheckpoint, beginAttempt, finishAttempt, listAttempts }
}
