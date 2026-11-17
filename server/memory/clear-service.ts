import type Database from 'better-sqlite3'
import { closeAndDeleteRunLog } from '../utils/run-logger'
import { createHistoryClearRepository } from './clear-repository'
import type { HistoryClearResult } from '../../shared/memory'

export function createHistoryClearService(db: Database.Database, options: {
  deleteLog?: typeof closeAndDeleteRunLog
  logDirectory?: string
} = {}) {
  const repository = createHistoryClearRepository(db)
  const deleteLog = options.deleteLog ?? closeAndDeleteRunLog

  async function clear(sessionId: string, operationId: string): Promise<HistoryClearResult> {
    const started = repository.begin(sessionId, operationId)
    if (started.status === 'completed') return started
    try {
      await deleteLog(started.oldRunLogId!, options.logDirectory)
      return repository.complete(operationId)
    } catch (error) {
      return repository.fail(operationId, error instanceof Error ? error.message : 'history log cleanup failed')
    }
  }

  async function resumePending(): Promise<number> {
    let completed = 0
    for (const operation of repository.pending()) {
      try {
        await deleteLog(operation.oldRunLogId, options.logDirectory)
        repository.complete(operation.operationId)
        completed += 1
      } catch (error) {
        repository.fail(operation.operationId, error instanceof Error ? error.message : 'history log cleanup failed')
      }
    }
    return completed
  }

  return { clear, resumePending }
}

