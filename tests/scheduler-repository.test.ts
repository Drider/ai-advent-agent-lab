import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, afterEach } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSchedulerRepository } from '../server/scheduler/repository'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function createRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'scheduler-repository-'))
  directories.push(directory)
  const db = openChatDatabase(join(directory, 'chat.sqlite'))
  return { db, repository: createSchedulerRepository(db) }
}

describe('scheduler repository', () => {
  it('claims each scheduled run once and accumulates results', async () => {
    const { db, repository } = await createRepository()
    const job = repository.createJob({
      name: 'Clock', sourceId: 'clock', sourceQuery: {}, collectCron: '*/5 * * * *', reportCron: '0 * * * *', timezone: 'Europe/Moscow', summaryInstruction: 'summarize',
      nextCollectAt: '2026-11-26T10:05:00.000Z', nextReportAt: '2026-11-26T11:00:00.000Z',
    })
    const first = repository.claimRun(job.id, '2026-11-26T10:05:00.000Z')
    expect(first).not.toBeNull()
    expect(repository.claimRun(job.id, '2026-11-26T10:05:00.000Z')).toBeNull()
    repository.saveResult(first!.id, { value: 1 }, '2026-11-26T10:05:01.000Z')
    repository.finishRun(first!.id, { status: 'completed', observedAt: '2026-11-26T10:05:01.000Z' })
    const second = repository.claimRun(job.id, '2026-11-26T10:10:00.000Z')
    repository.saveResult(second!.id, { value: 2 }, '2026-11-26T10:10:01.000Z')
    repository.finishRun(second!.id, { status: 'completed', observedAt: '2026-11-26T10:10:01.000Z' })
    expect(repository.readResults(job.id, '2026-11-26T10:00:00.000Z', '2026-11-26T11:00:00.000Z')).toHaveLength(2)
    expect(repository.counts(job.id, '2026-11-26T10:00:00.000Z', '2026-11-26T11:00:00.000Z')).toMatchObject({ runCount: 2, successCount: 2 })
    db.close()
  })

  it('serializes the scheduler lease between owners', async () => {
    const { db, repository } = await createRepository()
    const at = new Date('2026-11-26T10:00:00.000Z')
    expect(repository.acquireLease('one', at)).toBe(true)
    expect(repository.acquireLease('two', at)).toBe(false)
    expect(repository.acquireLease('two', new Date(at.getTime() + 31_000))).toBe(true)
    db.close()
  })
})
