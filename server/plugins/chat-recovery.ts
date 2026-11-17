import { defineNitroPlugin } from 'nitropack/runtime'
import { getChatDatabase } from '../persistence/db'
import { createTurnRepository } from '../persistence/turn-repository'
import { createHistoryClearService } from '../memory/clear-service'

export default defineNitroPlugin(async () => {
  const db = getChatDatabase()
  await createHistoryClearService(db).resumePending()
  createTurnRepository(db).recoverRunningTurns()
})
