import { defineEventHandler, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createMemorySettingsRepository } from '../../memory/settings-repository'
import { toMemoryHttpError } from '../../memory/api-errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  try {
    return createMemorySettingsRepository(getChatDatabase()).update(await readBody(event))
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
