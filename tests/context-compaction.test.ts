import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider'
import type { ChatUIMessage } from '../shared/chat'
import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareSessionContext } from '../server/context-compaction/prepare'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'

const temporaryDirectories: string[] = []

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-context-compaction-'))
  temporaryDirectories.push(directory)
  return join(directory, 'chat.sqlite')
}

function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 20, text: 20, reasoning: undefined },
    },
    warnings: [],
  }
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

async function createHistory(count = 20) {
  const db = openChatDatabase(await createDatabasePath())
  const sessions = createSessionRepository(db)
  const turns = createTurnRepository(db)
  const session = sessions.createSession()
  const firstMessage: ChatUIMessage = {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: 'message 0' }],
  }
  const turn = turns.beginUserTurn({
    sessionId: session.id,
    requestId: randomUUID(),
    modelId: 'mock-model',
    message: firstMessage,
    agentConfig: { version: 1 },
  })
  for (let position = 1; position < count; position += 1) {
    insertMessage(db, session.id, {
      id: randomUUID(),
      role: position % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: `message ${position}` }],
    }, position)
  }
  return { db, sessions, session, turn, firstMessage }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('prepareSessionContext', () => {
  it('isolates Off and Sliding Window from an existing Summary checkpoint', async () => {
    const { db, session, turn } = await createHistory()
    const model = new MockLanguageModelV3({ doGenerate: [textResult('Старая сводка')] })
    await prepareSessionContext({
      db,
      sessionId: session.id,
      turnId: turn.turnId,
      model,
      modelId: 'mock-model',
      settings: { enabled: true, messageThreshold: 12, contextWindowTokens: 100_000 },
      promptOverheadTokens: 0,
    })

    const off = await prepareSessionContext({
      db,
      sessionId: session.id,
      turnId: turn.turnId,
      model,
      modelId: 'mock-model',
      settings: { enabled: false, messageThreshold: 20, contextWindowTokens: 100_000 },
      contextStrategy: { strategy: 'off', windowSize: 10, messageThreshold: 20 },
      promptOverheadTokens: 0,
    })
    const sliding = await prepareSessionContext({
      db,
      sessionId: session.id,
      turnId: turn.turnId,
      model,
      modelId: 'mock-model',
      settings: { enabled: false, messageThreshold: 20, contextWindowTokens: 100_000 },
      contextStrategy: { strategy: 'sliding_window', windowSize: 10, messageThreshold: 20 },
      promptOverheadTokens: 0,
    })

    expect(off.modelMessages).toHaveLength(20)
    expect(off.modelMessages.some(message => message.parts.some(part => part.type === 'text' && part.text.includes('Старая сводка')))).toBe(false)
    expect(sliding.modelMessages).toHaveLength(10)
    expect(sliding.modelMessages.at(0)?.parts[0]).toMatchObject({ text: 'message 10' })
    db.close()
  })

  it('builds Sticky Facts from user messages and sends facts plus the window', async () => {
    const { db, session, turn } = await createHistory(6)
    const model = new MockLanguageModelV3({
      doGenerate: Array.from({ length: 3 }, (_, index) => textResult(JSON.stringify({ [`fact${index}`]: `value${index}` }))),
    })
    const prepared = await prepareSessionContext({
      db,
      sessionId: session.id,
      turnId: turn.turnId,
      model,
      modelId: 'mock-model',
      settings: { enabled: false, messageThreshold: 20, contextWindowTokens: 100_000 },
      contextStrategy: { strategy: 'sticky_facts', windowSize: 4, messageThreshold: 20 },
      promptOverheadTokens: 0,
    })

    expect(prepared.modelMessages[0]?.parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Sticky facts') })
    expect(prepared.modelMessages).toHaveLength(5)
    const updates = db.prepare('SELECT COUNT(*) AS count FROM facts_updates WHERE session_id = ?').get(session.id) as { count: number }
    expect(updates.count).toBe(3)
    db.close()
  })

  it('creates a checkpoint and keeps the full original history separate from model messages', async () => {
    const { db, sessions, session, turn } = await createHistory()
    const model = new MockLanguageModelV3({ doGenerate: [textResult('Сводка первых сообщений')] })

    const prepared = await prepareSessionContext({
      db,
      sessionId: session.id,
      turnId: turn.turnId,
      model,
      modelId: 'mock-model',
      settings: { enabled: true, messageThreshold: 12, contextWindowTokens: 100_000 },
      promptOverheadTokens: 0,
    })

    expect(prepared.modelMessages).toHaveLength(11)
    expect(prepared.modelMessages[0]?.role).toBe('user')
    expect(prepared.modelMessages[0]?.parts[0]).toMatchObject({ type: 'text' })
    expect(prepared.modelMessages[0]?.parts[0]).toMatchObject({ text: expect.stringContaining('Сводка первых сообщений') })
    expect(prepared.originalMessages).toHaveLength(20)
    expect(prepared.attempt?.status).toBe('completed')
    expect((await sessions.getSession(session.id))?.messages).toHaveLength(20)
    db.close()
  })

  it('reuses a checkpoint after a model change without resummarizing the old prefix', async () => {
    const { db, session, turn } = await createHistory()
    const firstModel = new MockLanguageModelV3({ doGenerate: [textResult('Первая сводка')] })
    await prepareSessionContext({
      db,
      sessionId: session.id,
      turnId: turn.turnId,
      model: firstModel,
      modelId: 'model-a',
      settings: { enabled: true, messageThreshold: 12, contextWindowTokens: 100_000 },
      promptOverheadTokens: 0,
    })

    const secondModel = new MockLanguageModelV3({ doGenerate: [textResult('Не должна появиться')] })
    const prepared = await prepareSessionContext({
      db,
      sessionId: session.id,
      turnId: turn.turnId,
      model: secondModel,
      modelId: 'model-b',
      settings: { enabled: true, messageThreshold: 12, contextWindowTokens: 100_000 },
      promptOverheadTokens: 0,
    })

    expect(secondModel.doGenerateCalls).toHaveLength(0)
    expect(prepared.modelMessages[0]?.parts[0]).toMatchObject({ text: expect.stringContaining('Первая сводка') })
    expect(prepared.originalMessages).toHaveLength(20)
    db.close()
  })

  it('creates and advances a rolling checkpoint using the previous summary', async () => {
    const { db, session, turn } = await createHistory()
    const firstModel = new MockLanguageModelV3({ doGenerate: [textResult('Первая сводка')] })
    await prepareSessionContext({
      db,
      sessionId: session.id,
      turnId: turn.turnId,
      model: firstModel,
      modelId: 'model-a',
      settings: { enabled: true, messageThreshold: 12, contextWindowTokens: 100_000 },
      promptOverheadTokens: 0,
    })
    for (let position = 20; position < 32; position += 1) {
      insertMessage(db, session.id, {
        id: randomUUID(),
        role: position % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `new message ${position}` }],
      }, position)
    }

    const secondModel = new MockLanguageModelV3({ doGenerate: [textResult('Вторая сводка')] })
    const prepared = await prepareSessionContext({
      db,
      sessionId: session.id,
      turnId: turn.turnId,
      model: secondModel,
      modelId: 'model-b',
      settings: { enabled: true, messageThreshold: 12, contextWindowTokens: 100_000 },
      promptOverheadTokens: 0,
    })
    const prompt = JSON.stringify(secondModel.doGenerateCalls[0]?.prompt)

    expect(prompt).toContain('Первая сводка')
    expect(prompt).not.toContain('message 0')
    expect(prepared.modelMessages[0]?.parts[0]).toMatchObject({ text: expect.stringContaining('Вторая сводка') })
    db.close()
  })

  it('bounds huge old tool output in the summarizer input while retaining it in SQLite', async () => {
    const { db, session, turn, sessions } = await createHistory()
    const hugeToolMessage: ChatUIMessage = {
      id: randomUUID(),
      role: 'assistant',
      parts: [{
        type: 'tool-read_pdf',
        toolCallId: 'pdf-1',
        state: 'output-available',
        input: { path: 'book.pdf' },
        output: { text: 'x'.repeat(200_000) },
      } as never],
    }
    db.prepare('DELETE FROM messages WHERE session_id = ? AND position = 1').run(session.id)
    insertMessage(db, session.id, hugeToolMessage, 1)
    const model = new MockLanguageModelV3({ doGenerate: [textResult('Сводка PDF')] })

    await prepareSessionContext({
      db,
      sessionId: session.id,
      turnId: turn.turnId,
      model,
      modelId: 'mock-model',
      settings: { enabled: true, messageThreshold: 12, contextWindowTokens: 100_000 },
      promptOverheadTokens: 0,
    })

    expect(JSON.stringify(model.doGenerateCalls[0]).length).toBeLessThan(110_000)
    expect(JSON.stringify(model.doGenerateCalls[0])).toContain('message content truncated')
    expect((await sessions.getSession(session.id))?.messages[1]?.parts).toEqual(hugeToolMessage.parts)
    db.close()
  })

  it('records a failed billed summarization attempt and does not create a checkpoint', async () => {
    const { db, session, turn } = await createHistory()
    const error = Object.assign(new Error('provider quota exceeded'), {
      usage: { inputTokens: 120, outputTokens: 3, totalTokens: 123 },
    })
    const model = new MockLanguageModelV3({ doGenerate: (async () => { throw error }) as never })

    await expect(prepareSessionContext({
      db,
      sessionId: session.id,
      turnId: turn.turnId,
      model,
      modelId: 'mock-model',
      settings: { enabled: true, messageThreshold: 12, contextWindowTokens: 100_000 },
      promptOverheadTokens: 0,
    })).rejects.toThrow('provider quota exceeded')

    const repository = (await import('../server/context-compaction/repository')).createCompactionRepository(db)
    expect(repository.latestCheckpoint(session.id)).toBeNull()
    expect(repository.listAttempts(session.id)[0]).toMatchObject({
      status: 'failed',
      usage: { inputTokens: 120, outputTokens: 3, totalTokens: 123 },
    })
    db.close()
  })

  it('removes only partial trailing assistant text and keeps confirmed tool parts', async () => {
    const { db, session, turn } = await createHistory(12)
    const partial: ChatUIMessage = {
      id: randomUUID(),
      role: 'assistant',
      parts: [
        { type: 'tool-read_file', toolCallId: 'file-1', state: 'output-available', input: { path: 'notes.md' }, output: { text: 'confirmed' } } as never,
        { type: 'text', text: 'partial text' },
      ],
    }
    db.prepare('DELETE FROM messages WHERE session_id = ? AND position = 11').run(session.id)
    insertMessage(db, session.id, partial, 11, 'interrupted')

    const prepared = await prepareSessionContext({
      db,
      sessionId: session.id,
      turnId: turn.turnId,
      model: new MockLanguageModelV3({ doGenerate: [textResult('unused')] }),
      modelId: 'mock-model',
      settings: { enabled: true, messageThreshold: 20, contextWindowTokens: 100_000 },
      promptOverheadTokens: 0,
    })

    expect(prepared.modelMessages.at(-1)?.parts).toEqual([partial.parts[0]])
    expect(prepared.originalMessages.at(-1)?.parts).toEqual([partial.parts[0]])
    db.close()
  })
})
