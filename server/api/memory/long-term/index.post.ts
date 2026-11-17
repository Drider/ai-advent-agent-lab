import { defineEventHandler, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { createLongTermMemoryRepository } from '../../../memory/long-term-repository'
import { toMemoryHttpError } from '../../../memory/api-errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  try {
    return createLongTermMemoryRepository(getChatDatabase()).create(await readBody(event))
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
