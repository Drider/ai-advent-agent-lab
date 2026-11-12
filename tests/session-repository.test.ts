import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatUIMessage } from '../shared/chat'
import { openChatDatabase } from '../server/persistence/db'
import { ChatStorageError, createSessionRepository } from '../server/persistence/session-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'

const temporaryDirectories: string[] = []

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-sessions-'))
  temporaryDirectories.push(directory)
  return join(directory, 'chat.sqlite')
}

function saveMessage(db: Database.Database, sessionId: string, message: ChatUIMessage, position: number): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO messages
      (id, session_id, turn_id, position, role, status, payload_json, storage_version, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `).run(message.id, sessionId, position, message.role, 'complete', JSON.stringify(message), 1, now, now)
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('session repository', () => {
  it('shows a legacy timeout reason from the matching diagnostic entry', async () => {
    const filePath = await createDatabasePath()
    const db = openChatDatabase(filePath)
    const repository = createSessionRepository(db)
    const session = repository.createSession()
    const turnId = randomUUID()
    const turns = createTurnRepository(db)
    turns.beginUserTurn({
      sessionId: session.id,
      requestId: turnId,
      modelId: 'mock-model',
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Дальше' }] },
      agentConfig: {},
    })
    turns.finishTurn({
      turnId,
      message: { id: randomUUID(), role: 'assistant', parts: [] },
      status: 'interrupted',
    })
    const runsDirectory = join(dirname(filePath), 'runs')
    await mkdir(runsDirectory)
    await writeFile(join(runsDirectory, `run-${session.runLogId}.json`), JSON.stringify({
      requests: [{ turnId, status: 'aborted', errorDetails: { name: 'TimeoutError', message: 'The operation was aborted due to timeout' } }],
    }))

    expect((await repository.getSession(session.id))?.lastTurn?.stopReason).toBe('timeout')
    db.close()
  })

  it('refines a generic saved failure when its log identifies an invalid prompt', async () => {
    const filePath = await createDatabasePath()
    const db = openChatDatabase(filePath)
    const repository = createSessionRepository(db)
    const session = repository.createSession()
    const turnId = randomUUID()
    const turns = createTurnRepository(db)
    turns.beginUserTurn({
      sessionId: session.id,
      requestId: turnId,
      modelId: 'mock-model',
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Дальше' }] },
      agentConfig: {},
    })
    turns.finishTurn({ turnId, message: { id: randomUUID(), role: 'assistant', parts: [] }, status: 'failed', stopReason: 'agent_error' })
    const runsDirectory = join(dirname(filePath), 'runs')
    await mkdir(runsDirectory)
    await writeFile(join(runsDirectory, `run-${session.runLogId}.json`), JSON.stringify({
      requests: [{ turnId, status: 'failed', errorDetails: { name: 'AI_InvalidPromptError' } }],
    }))

    expect((await repository.getSession(session.id))?.lastTurn?.stopReason).toBe('invalid_prompt')
    db.close()
  })

  it('deletes one dialogue and its history while keeping other history and its diagnostic log', async () => {
    const filePath = await createDatabasePath()
    const db = openChatDatabase(filePath)
    const repository = createSessionRepository(db)
    const deleted = repository.createSession()
    const retained = repository.createSession()
    const turnId = randomUUID()
    const toolCallId = randomUUID()
    const timestamp = new Date().toISOString()

    saveMessage(db, deleted.id, { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Удалить' }] }, 0)
    saveMessage(db, retained.id, { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Оставить' }] }, 0)
    db.prepare(`
      INSERT INTO turns (id, session_id, request_id, position, status, model_id, agent_config_json, started_at, finished_at, updated_at)
      VALUES (?, ?, ?, 0, 'completed', 'mock-model', '{}', ?, ?, ?)
    `).run(turnId, deleted.id, turnId, timestamp, timestamp, timestamp)
    db.prepare(`
      INSERT INTO tool_executions (id, turn_id, step_index, tool_call_id, tool_name, status, input_json, created_at, updated_at)
      VALUES (?, ?, 0, ?, 'rollDice', 'completed', '{}', ?, ?)
    `).run(randomUUID(), turnId, toolCallId, timestamp, timestamp)
    db.prepare(`
      INSERT INTO dice_rolls (tool_call_id, sides, result, rolled_at)
      VALUES (?, 6, 4, ?)
    `).run(toolCallId, timestamp)
    const logPath = join(dirname(filePath), `run-${deleted.runLogId}.json`)
    await writeFile(logPath, '{"requests":[{"question":"Удалить"}]}')

    repository.deleteSession(deleted.id)

    expect(repository.listSessions().items.map(item => item.id)).toEqual([retained.id])
    expect(await repository.getSession(deleted.id)).toBeNull()
    expect((await repository.getSession(retained.id))?.messages).toHaveLength(1)
    for (const table of ['messages', 'turns', 'tool_executions', 'dice_rolls']) {
      const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
      expect(count.count, table).toBe(table === 'messages' ? 1 : 0)
    }
    expect(await readFile(logPath, 'utf8')).toContain('Удалить')
    db.close()
  })

  it('rejects deletion of a running dialogue or an unknown dialogue', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const repository = createSessionRepository(db)
    const session = repository.createSession()
    const turn = createTurnRepository(db)
    turn.beginUserTurn({
      sessionId: session.id,
      requestId: randomUUID(),
      modelId: 'mock-model',
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'В работе' }] },
      agentConfig: {},
    })

    expect(() => repository.deleteSession(session.id)).toThrowError(
      expect.objectContaining({ code: 'SESSION_RUNNING' }) as ChatStorageError,
    )
    expect(() => repository.deleteSession(randomUUID())).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' }) as ChatStorageError,
    )
    expect((await repository.getSession(session.id))?.messages).toHaveLength(1)
    db.close()
  })

  it('restores the selected model for one dialogue after reopening the database', async () => {
    const filePath = await createDatabasePath()
    const db = openChatDatabase(filePath)
    const repository = createSessionRepository(db)
    const selected = repository.createSession()
    const other = repository.createSession()

    repository.setModelId(selected.id, 'qwen/qwen3.5-9b')
    db.close()

    const reopenedDb = openChatDatabase(filePath)
    const reopened = createSessionRepository(reopenedDb)
    expect((await reopened.getSession(selected.id))?.modelId).toBe('qwen/qwen3.5-9b')
    expect((await reopened.getSession(other.id))?.modelId).toBeNull()
    reopenedDb.close()
  })

  it('uses the model from the latest request when it differs from the saved selection', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const repository = createSessionRepository(db)
    const session = repository.createSession()
    repository.setModelId(session.id, 'model-a')

    createTurnRepository(db).beginUserTurn({
      sessionId: session.id,
      requestId: randomUUID(),
      modelId: 'model-b',
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Привет' }] },
      agentConfig: { version: 1 },
    })

    expect((await repository.getSession(session.id))?.modelId).toBe('model-b')
    db.close()
  })

  it('creates unique sessions and collision-free diagnostic run IDs at one clock tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'))
    const db = openChatDatabase(await createDatabasePath())
    const repository = createSessionRepository(db)

    const first = repository.createSession()
    const second = repository.createSession()

    expect(first.id).not.toBe(second.id)
    expect(first.runLogId).not.toBe(second.runLogId)
    expect(first.runLogId).toMatch(/^2026-11-10T12:00:00\.000Z$/)
    expect(second.runLogId).toMatch(/^2026-11-10T12:00:00\.001Z$/)
    db.close()
  })

  it('reopens messages in order with complete parts and metadata', async () => {
    const filePath = await createDatabasePath()
    const db = openChatDatabase(filePath)
    const repository = createSessionRepository(db)
    const session = repository.createSession()
    const savedMessages: ChatUIMessage[] = [
      {
        id: randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text: 'Привет' }],
      },
      {
        id: randomUUID(),
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Ответ' },
          { type: 'reasoning', text: 'Проверяю контекст' },
        ],
        metadata: {
          durationMs: 123,
          usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
        },
      },
    ]
    savedMessages.forEach((message, position) => saveMessage(db, session.id, message, position))
    db.close()

    const reopened = createSessionRepository(openChatDatabase(filePath))
    await expect(reopened.getSession(session.id)).resolves.toMatchObject({
      id: session.id,
      messages: savedMessages,
    })
  })

  it('paginates stably and returns a preferred session outside the first page', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'))
    const db = openChatDatabase(await createDatabasePath())
    const repository = createSessionRepository(db)
    const sessions = [repository.createSession(), repository.createSession(), repository.createSession()]
    repository.activateSession(sessions[0]!.id)

    const firstPage = repository.listSessions({ limit: 2 })
    const secondPage = repository.listSessions({ limit: 2, cursor: firstPage.nextCursor })

    expect(firstPage.items).toHaveLength(2)
    expect(secondPage.items).toHaveLength(1)
    expect(new Set([...firstPage.items, ...secondPage.items].map(item => item.id))).toEqual(
      new Set(sessions.map(session => session.id)),
    )
    expect(firstPage.preferredSessionId).toBe(sessions[0]!.id)
    db.close()
  })

  it('raises a typed storage error for malformed JSON and unsupported versions', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const repository = createSessionRepository(db)
    const session = repository.createSession()
    const message: ChatUIMessage = {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: 'Сохрани меня' }],
    }
    saveMessage(db, session.id, message, 0)

    db.pragma('ignore_check_constraints = ON')
    db.prepare('UPDATE messages SET payload_json = ? WHERE id = ?').run('{bad-json', message.id)
    db.pragma('ignore_check_constraints = OFF')
    await expect(repository.getSession(session.id)).rejects.toMatchObject({ code: 'INVALID_STORED_MESSAGE' })

    db.prepare('UPDATE messages SET payload_json = ?, storage_version = ? WHERE id = ?')
      .run(JSON.stringify(message), 99, message.id)
    await expect(repository.getSession(session.id)).rejects.toMatchObject({ code: 'UNSUPPORTED_STORAGE_VERSION' })
    db.close()
  })
})
