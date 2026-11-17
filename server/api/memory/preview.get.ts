import { defineEventHandler, getQuery, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { previewMemory } from '../../memory/context'
import { toMemoryHttpError } from '../../memory/api-errors'

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  try {
    return previewMemory(getChatDatabase(), single(getQuery(event).projectId as string | string[] | undefined))
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
