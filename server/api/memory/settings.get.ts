import { defineEventHandler, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createMemorySettingsRepository } from '../../memory/settings-repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  return createMemorySettingsRepository(getChatDatabase()).get()
})
