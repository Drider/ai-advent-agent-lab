import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { migrateChatDatabase } from './migrations'

const DEFAULT_DATABASE_PATH = join(process.cwd(), 'data', 'chat.sqlite')
let chatDatabase: Database.Database | undefined

function ensurePrivatePath(path: string, mode: number): void {
  if (process.platform === 'win32') {
    return
  }

  try {
    chmodSync(path, mode)
  } catch {
    // The database may be created with the requested mode already. A later
    // chmod is best effort for platforms with restrictive filesystem ACLs.
  }
}

export function openChatDatabase(filePath = DEFAULT_DATABASE_PATH): Database.Database {
  const directory = dirname(filePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  ensurePrivatePath(directory, 0o700)

  const db = new Database(filePath)
  ensurePrivatePath(filePath, 0o600)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 1000')
  db.pragma('synchronous = FULL')
  migrateChatDatabase(db)
  return db
}

export function getChatDatabase(): Database.Database {
  chatDatabase ??= openChatDatabase()
  return chatDatabase
}
