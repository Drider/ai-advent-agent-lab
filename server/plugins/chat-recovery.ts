import { defineNitroPlugin } from 'nitropack/runtime'
import { recoverTaskOperations } from '../tasks/recovery'
import { getChatDatabase } from '../persistence/db'
import { createTurnRepository } from '../persistence/turn-repository'
import { createHistoryClearService } from '../memory/clear-service'

export default defineNitroPlugin(() => {
  const db = getChatDatabase()
  // Nitro does not await an async plugin before serving requests. Recover
  // running turns synchronously, then let file cleanup resume in the
  // background while its session remains blocked by the pending operation.
  createTurnRepository(db).recoverRunningTurns()
  recoverTaskOperations(db)
  void createHistoryClearService(db).resumePending()
})
