import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult } from '@ai-sdk/provider'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { streamChatAgent } from '../server/agent/chat-agent'
import { createTurnRepository } from '../server/persistence/turn-repository'
import type { ChatUIMessage } from '../shared/chat'

const temporaryDirectories: string[] = []
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-persisted-'))
  temporaryDirectories.push(directory)
  return join(directory, 'chat.sqlite')
}

function userMessage(text: string): ChatUIMessage {
  return { id: 'user-1', role: 'user', parts: [{ type: 'text', text }] }
}

function streamTextResult(text: string, extraChunks: LanguageModelV3StreamPart[] = []): LanguageModelV3StreamResult {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    ...extraChunks,
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ]
  return {
    stream: simulateReadableStream({ chunks }),
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('persisted chat stream', () => {
  it('persists the complete assistant UI message and survives database reopen', async () => {
    const filePath = await createDatabasePath()
    const db = openChatDatabase(filePath)
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()
    const message = userMessage('Привет')
    const turnId = '44444444-4444-4444-8444-444444444444'
    turns.beginUserTurn({ sessionId: session.id, requestId: turnId, modelId: 'mock-model', message, agentConfig: { version: 1 } })
    const model = new MockLanguageModelV3({ doStream: streamTextResult('Ответ') })

    const response = await streamChatAgent({
      model,
      modelId: 'mock-model',
      messages: [message],
      runId: session.runLogId,
      logLevel: 'off',
      pricing: { inputPerMillionRub: 10, outputPerMillionRub: 40 },
      sessionId: session.id,
      turnId,
      turnRepository: turns,
    })
    await response.text()
    db.close()

    const reopenedDb = openChatDatabase(filePath)
    const reopened = createSessionRepository(reopenedDb)
    const detail = await reopened.getSession(session.id)
    expect(detail?.messages.at(-1)?.parts.find(part => part.type === 'text')).toMatchObject({
      type: 'text',
      text: 'Ответ',
    })
    expect(detail?.messages.at(-1)?.metadata?.costRub?.input).toBeCloseTo(0.0001)
    expect(detail?.messages.at(-1)?.metadata?.costRub?.output).toBeCloseTo(0.0002)
    expect(detail?.messages.at(-1)?.metadata?.costRub?.total).toBeCloseTo(0.0003)
    expect(detail?.messages.at(-1)?.metadata?.usage).toMatchObject({
      inputTokenDetails: { noCacheTokens: 10 },
      outputTokenDetails: { textTokens: 5 },
    })
    expect(detail?.messages.at(-1)?.metadata?.steps).toEqual([{ usage: {
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
      inputTokenDetails: { noCacheTokens: 10 },
      outputTokenDetails: { textTokens: 5 },
    } }])
    expect(detail?.lastTurn?.status).toBe('completed')
    reopenedDb.close()
  })

  it('saves at most one best-effort partial snapshot per second of streamed text', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()
    const message = userMessage('Поток')
    const turnId = '55555555-5555-4555-8555-555555555555'
    turns.beginUserTurn({ sessionId: session.id, requestId: turnId, modelId: 'mock-model', message, agentConfig: { version: 1 } })
    const snapshot = vi.spyOn(turns, 'saveAssistantSnapshot')
    const model = new MockLanguageModelV3({
      doStream: streamTextResult('один', [
        { type: 'text-delta', id: 'text-1', delta: 'два' },
        { type: 'text-delta', id: 'text-1', delta: 'три' },
      ]),
    })

    const response = await streamChatAgent({
      model,
      modelId: 'mock-model',
      messages: [message],
      runId: session.runLogId,
      logLevel: 'off',
      sessionId: session.id,
      turnId,
      turnRepository: turns,
    })
    await response.text()

    expect(snapshot.mock.calls.filter(call => call[0].turnId === turnId).length).toBeLessThanOrEqual(3)
    db.close()
  })

  it('does not mark a turn completed when the final persistence write fails', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()
    const message = userMessage('Сбой записи')
    const turnId = '66666666-6666-4666-8666-666666666666'
    turns.beginUserTurn({ sessionId: session.id, requestId: turnId, modelId: 'mock-model', message, agentConfig: { version: 1 } })
    vi.spyOn(turns, 'finishTurn').mockImplementation(() => { throw new Error('final database failure') })
    const model = new MockLanguageModelV3({ doStream: streamTextResult('Ответ') })

    const response = await streamChatAgent({
      model,
      modelId: 'mock-model',
      messages: [message],
      runId: session.runLogId,
      logLevel: 'off',
      sessionId: session.id,
      turnId,
      turnRepository: turns,
    })
    await response.text()

    expect((await sessions.getSession(session.id))?.lastTurn?.status).not.toBe('completed')
    db.close()
  })
})
