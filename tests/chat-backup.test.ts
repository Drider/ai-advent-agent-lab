import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import type { ChatUIMessage } from '../shared/chat'

const execFile = promisify(execFileCallback)
const temporaryDirectories: string[] = []

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-backup-'))
  temporaryDirectories.push(directory)
  return join(directory, 'chat.sqlite')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('chat database backup', () => {
  it('backs up a live database and keeps the source writable', async () => {
    const sourcePath = await createDatabasePath()
    const directory = sourcePath.slice(0, sourcePath.lastIndexOf('/'))
    const outputPath = join(directory, 'backups', 'chat-copy.sqlite')
    const sourceDb = openChatDatabase(sourcePath)
    const sessions = createSessionRepository(sourceDb)
    const turns = createTurnRepository(sourceDb)
    const session = sessions.createSession()
    const message: ChatUIMessage = {
      id: 'backup-user-message',
      role: 'user',
      parts: [{ type: 'text', text: 'Сохрани меня' }],
    }
    turns.beginUserTurn({
      sessionId: session.id,
      requestId: '11111111-1111-4111-8111-111111111111',
      modelId: 'mock-model',
      message,
      agentConfig: { version: 1 },
    })

    await execFile(process.execPath, [join(process.cwd(), 'scripts', 'backup-chat-db.mjs'), '--source', sourcePath, '--output', outputPath])

    const backupDb = openChatDatabase(outputPath)
    await expect(createSessionRepository(backupDb).getSession(session.id)).resolves.toMatchObject({
      messages: [message],
    })
    expect(() => sessions.createSession()).not.toThrow()
    backupDb.close()
    sourceDb.close()
  })
})
