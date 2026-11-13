import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatUIMessage } from '../shared/chat'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { createCompactionRepository } from '../server/context-compaction/repository'

const temporaryDirectories: string[] = []

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-compaction-repository-'))
  temporaryDirectories.push(directory)
  return join(directory, 'chat.sqlite')
}

function insertMessage(
  db: ReturnType<typeof openChatDatabase>,
  sessionId: string,
  message: ChatUIMessage,
  position: number,
  status: 'complete' | 'partial' | 'interrupted' = 'complete',
): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO messages
      (id, session_id, turn_id, position, role, status, payload_json, storage_version, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, 1, ?, ?)
  `).run(message.id, sessionId, position, message.role, status, JSON.stringify(message), now, now)
}

async function createSessionWithTurn() {
  const db = openChatDatabase(await createDatabasePath())
  const sessions = createSessionRepository(db)
  const turns = createTurnRepository(db)
  const session = sessions.createSession()
  const userMessage: ChatUIMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Начать' }] }
  const turn = turns.beginUserTurn({
    sessionId: session.id,
    requestId: randomUUID(),
    modelId: 'mock-model',
    message: userMessage,
    agentConfig: { version: 1 },
  })
  return { db, session, turn, userMessage }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('context compaction repository', () => {
  it('loads validated messages with their durable positions and statuses', async () => {
    const { db, session, userMessage } = await createSessionWithTurn()
    insertMessage(db, session.id, { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Ответ' }] }, 1, 'partial')

    const messages = await createCompactionRepository(db).loadMessages(session.id)

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ position: 0, status: 'complete', message: userMessage })
    expect(messages[1]).toMatchObject({ position: 1, status: 'partial', message: { role: 'assistant' } })
    db.close()
  })

  it('keeps billed failed attempts without creating a checkpoint', async () => {
    const { db, session, turn } = await createSessionWithTurn()
    const repository = createCompactionRepository(db)
    const attemptId = repository.beginAttempt({
      sessionId: session.id,
      turnId: turn.turnId,
      trigger: 'message_count',
      modelId: 'mock-model',
      fromMessagePosition: 0,
      throughMessagePosition: 0,
      estimatedBeforeTokens: 1000,
      estimatedAfterTokens: 200,
    })

    expect(repository.finishAttempt({
      attemptId,
      status: 'failed',
      usage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 },
      error: 'summary refused',
    })).toBeNull()
    expect(repository.latestCheckpoint(session.id)).toBeNull()
    expect(repository.listAttempts(session.id)[0]).toMatchObject({
      id: attemptId,
      status: 'failed',
      usage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 },
      error: 'summary refused',
    })
    db.close()
  })

  it('commits a checkpoint and its successful attempt atomically', async () => {
    const { db, session, turn } = await createSessionWithTurn()
    const repository = createCompactionRepository(db)
    const attemptId = repository.beginAttempt({
      sessionId: session.id,
      turnId: turn.turnId,
      trigger: 'context_fraction',
      modelId: 'mock-model',
      fromMessagePosition: 0,
      throughMessagePosition: 9,
      estimatedBeforeTokens: 5000,
      estimatedAfterTokens: 1000,
    })

    const checkpoint = repository.finishAttempt({
      attemptId,
      status: 'completed',
      summary: 'Сводка диалога',
      usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
    })

    expect(checkpoint).toMatchObject({ sessionId: session.id, throughMessagePosition: 9, summary: 'Сводка диалога' })
    expect(repository.latestCheckpoint(session.id)).toMatchObject({ id: checkpoint?.id, summary: 'Сводка диалога' })
    expect(repository.listAttempts(session.id)[0]).toMatchObject({ id: attemptId, status: 'completed', checkpointId: checkpoint?.id })
    db.close()
  })

  it('deletes compaction records with their session and rejects stale checkpoint positions', async () => {
    const { db, session, turn } = await createSessionWithTurn()
    const repository = createCompactionRepository(db)
    const first = repository.beginAttempt({
      sessionId: session.id, turnId: turn.turnId, trigger: 'message_count', modelId: 'mock-model',
      fromMessagePosition: 0, throughMessagePosition: 4, estimatedBeforeTokens: 1000, estimatedAfterTokens: 300,
    })
    repository.finishAttempt({ attemptId: first, status: 'completed', summary: 'Первая' })
    const stale = repository.beginAttempt({
      sessionId: session.id, turnId: turn.turnId, trigger: 'message_count', modelId: 'mock-model',
      fromMessagePosition: 0, throughMessagePosition: 4, estimatedBeforeTokens: 1000, estimatedAfterTokens: 300,
    })
    expect(() => repository.finishAttempt({ attemptId: stale, status: 'completed', summary: 'Повтор' })).toThrow('checkpoint position must advance')

    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM context_checkpoints WHERE session_id = ?').get(session.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM compaction_attempts WHERE session_id = ?').get(session.id)).toEqual({ count: 0 })
    db.close()
  })
})
