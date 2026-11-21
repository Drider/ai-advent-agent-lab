import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createInvariantRepository } from '../server/persistence/invariant-repository'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function createRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-invariants-'))
  temporaryDirectories.push(directory)
  const db = openChatDatabase(join(directory, 'chat.sqlite'))
  return { db, repository: createInvariantRepository(db) }
}

describe('invariant repository', () => {
  it('seeds invariants and journals upsert, forbidden patterns, and removal', async () => {
    const { db, repository } = await createRepository()
    try {
      expect(repository.list().map(item => item.id)).toEqual([
        'server-llm',
        'money-rub',
        'storage-sqlite',
        'stack-frontend',
      ])

      const created = repository.upsert({
        id: 'test-rule',
        category: 'decision',
        rule: 'Тестовое правило',
      })
      expect(created.forbidden).toEqual([])
      repository.setForbidden('test-rule', ['forbidden'])
      expect(repository.remove('test-rule')).toBe(true)

      expect(repository.listChanges(10).map(change => change.action)).toEqual(['remove', 'update', 'create'])
      const update = repository.listChanges(10).find(change => change.action === 'update')!
      expect(update.before?.forbidden).toEqual([])
      expect(update.after?.forbidden).toEqual(['forbidden'])
      expect(repository.listChanges(10).find(change => change.action === 'remove')?.after).toBeNull()
    } finally {
      db.close()
    }
  })

  it('rejects invalid regex before changing the database', async () => {
    const { db, repository } = await createRepository()
    try {
      expect(() => repository.setForbidden('stack-frontend', ['('])).toThrow(/invalid/u)
      expect(repository.get('stack-frontend')?.forbidden).toContain(String.raw`\bimport\s+React\b`)
      expect(repository.listChanges()).toEqual([])
    } finally {
      db.close()
    }
  })
})
