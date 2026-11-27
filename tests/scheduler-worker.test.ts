import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider'
import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSchedulerRepository } from '../server/scheduler/repository'
import { createSchedulerWorker } from '../server/scheduler/worker'

const directories: string[] = []

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

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('scheduler worker', () => {
  it('collects a due job created after the worker starts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scheduler-worker-'))
    directories.push(directory)
    const db = openChatDatabase(join(directory, 'chat.sqlite'))
    const repository = createSchedulerRepository(db)
    let now = new Date('2026-11-27T21:48:30.000Z')
    const worker = createSchedulerWorker({
      repository,
      clock: () => now,
      modelForReport: () => new MockLanguageModelV3({ doGenerate: [textResult('unused')] }),
      mcpRunnerFactory: () => ({
        getData: async () => ({ sourceId: 'clock', observedAt: now.toISOString(), payload: { now: now.toISOString() } }),
        saveResult: async input => repository.saveResult(input.runId, input.payload, input.observedAt),
        readPeriod: async () => ({ items: [] }),
        close: async () => {},
      }),
    })
    await worker.tick()
    const job = repository.createJob({
      name: 'Clock', sourceId: 'clock', sourceQuery: {}, collectCron: '*/2 * * * *', reportCron: '*/10 * * * *', timezone: 'Europe/Moscow', summaryInstruction: 'summarize',
      nextCollectAt: '2026-11-27T21:50:00.000Z', nextReportAt: '2026-11-27T22:00:00.000Z',
    })
    now = new Date('2026-11-27T21:50:10.000Z')
    await worker.tick()
    expect(repository.listRuns(job.id).map(run => run.status)).toEqual(['completed'])
    await worker.stop()
    db.close()
  })

  it('generates the scheduled report with the configured LLM', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scheduler-worker-'))
    directories.push(directory)
    const db = openChatDatabase(join(directory, 'chat.sqlite'))
    const repository = createSchedulerRepository(db)
    const now = new Date('2026-11-27T22:00:10.000Z')
    const model = new MockLanguageModelV3({ doGenerate: [textResult('GMST: 123.4567°')] })
    const worker = createSchedulerWorker({
      repository,
      clock: () => now,
      modelForReport: () => model,
      mcpRunnerFactory: () => ({
        getData: async () => ({ sourceId: 'clock', observedAt: now.toISOString(), payload: { now: now.toISOString() } }),
        saveResult: async input => repository.saveResult(input.runId, input.payload, input.observedAt),
        readPeriod: async input => ({ items: repository.readResults(input.jobId, input.from, input.to) }),
        close: async () => {},
      }),
    })
    const job = repository.createJob({
      name: 'GMST', sourceId: 'clock', sourceQuery: {}, collectCron: '*/2 * * * *', reportCron: '*/10 * * * *', timezone: 'Europe/Moscow', summaryInstruction: 'Вычисли GMST для каждой метки времени.', modelId: 'chosen-model',
      nextCollectAt: '2026-11-27T21:58:00.000Z', nextReportAt: '2026-11-27T22:00:00.000Z',
    })
    await worker.tick()
    expect(repository.listReports(job.id)[0]).toMatchObject({ status: 'completed', textStatus: 'completed', text: 'GMST: 123.4567°', resultCount: 1 })
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('Вычисли GMST')
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('2026-11-27T21:58:00.000Z')
    await worker.stop()
    db.close()
  })
})
