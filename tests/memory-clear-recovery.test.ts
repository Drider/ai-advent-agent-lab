import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createHistoryClearRepository } from '../server/memory/clear-repository'
import { createHistoryClearService } from '../server/memory/clear-service'
import { appendRunLogEntry, closeAndDeleteRunLog } from '../server/utils/run-logger'

const databases: ReturnType<typeof openChatDatabase>[] = []
const directories: string[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('history clear recovery', () => {
  it('resumes pending file deletion and prevents a late append from reviving the old log', async () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const session = createSessionRepository(db).createSession()
    const directory = await mkdtemp(join(tmpdir(), 'agent-chat-clear-'))
    directories.push(directory)
    await writeFile(join(directory, `run-${session.runLogId}.json`), '{}')
    const repository = createHistoryClearRepository(db)
    const operationId = randomUUID()
    const started = repository.begin(session.id, operationId)
    expect(started.status).toBe('pending_files')
    const service = createHistoryClearService(db, { logDirectory: directory })
    expect(await service.resumePending()).toBe(1)
    await appendRunLogEntry({ runId: started.oldRunLogId!, level: 'basic', question: 'late', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 0 }, directory)
    await expect(readFile(join(directory, `run-${started.oldRunLogId}.json`))).rejects.toThrow()
  })

  it('treats a missing run log as successfully deleted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-chat-clear-log-'))
    directories.push(directory)
    await expect(closeAndDeleteRunLog('2026-01-01T00:00:00.000Z', directory)).resolves.toBeUndefined()
  })
})
