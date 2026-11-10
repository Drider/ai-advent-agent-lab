import { defineNitroPlugin } from 'nitropack/runtime'
import { getChatDatabase } from '../persistence/db'
import { createTurnRepository } from '../persistence/turn-repository'

export default defineNitroPlugin(() => {
  createTurnRepository(getChatDatabase()).recoverRunningTurns()
})
