import { defineEventHandler, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { createLongTermMemoryRepository } from '../../../memory/long-term-repository'
import { toMemoryHttpError } from '../../../memory/api-errors'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  try {
    return { deleted: createLongTermMemoryRepository(getChatDatabase()).clear() }
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
