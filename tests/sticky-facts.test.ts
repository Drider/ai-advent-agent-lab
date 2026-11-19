import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatUIMessage } from '../shared/chat'
import { updateFacts } from '../server/context-compaction/facts'
import { openChatDatabase } from '../server/persistence/db'
import { createFactsRepository } from '../server/context-compaction/facts-repository'

const directories: string[] = []

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 4, text: 4, reasoning: undefined },
    },
    warnings: [],
  }
}

function userMessage(id: string, text: string): ChatUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('sticky facts', () => {
  it('extracts a validated key-value object from the user message', async () => {
    const model = new MockLanguageModelV3({ doGenerate: [textResult('{"owner":"Ирина Белова","budget":"480 000 рублей"}')] })
    const result = await updateFacts({
      model,
      previousFacts: { deadline: '18 декабря 2026 года' },
      userMessage: userMessage('m1', 'Ответственная — Ирина Белова, бюджет 480 000 рублей.'),
    })
    expect(result.facts).toEqual({ owner: 'Ирина Белова', budget: '480 000 рублей' })
    expect(result.usage?.totalTokens).toBe(14)
  })

  it('keeps previous facts when a provider returns no visible text', async () => {
    const model = new MockLanguageModelV3({ doGenerate: [textResult('')] })
    const previousFacts = { owner: 'Ирина Белова' }
    const result = await updateFacts({
      model,
      previousFacts,
      userMessage: userMessage('m1', 'Для чего нужен журнал рисков?'),
    })
    expect(result.facts).toEqual(previousFacts)
  })

  it('persists facts snapshots idempotently by source message', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-chat-facts-'))
    directories.push(directory)
    const db = openChatDatabase(join(directory, 'chat.sqlite'))
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const { default_profile_id: defaultProfileId } = db.prepare('SELECT default_profile_id FROM user_profile_settings WHERE id = 1').get() as { default_profile_id: string }
    db.prepare('INSERT INTO sessions (id, run_log_id, title, created_at, updated_at, status, revision, user_profile_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, 'run-facts', 'Facts', new Date().toISOString(), new Date().toISOString(), 'idle', 0, defaultProfileId)
    const repository = createFactsRepository(db)
    repository.saveFactsUpdate({
      sessionId,
      sourceMessageId: 'm1',
      throughMessagePosition: 0,
      facts: { owner: 'Ирина Белова' },
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    })
    repository.saveFactsUpdate({
      sessionId,
      sourceMessageId: 'm1',
      throughMessagePosition: 0,
      facts: { owner: 'Другое имя' },
    })
    expect(repository.latestFacts(sessionId, 0)).toEqual({ owner: 'Ирина Белова' })
    expect(repository.listFactsUpdates(sessionId)).toHaveLength(1)
    db.close()
  })
})
