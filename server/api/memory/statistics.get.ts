import { createError, defineEventHandler, getQuery, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { getMemoryStatistics } from '../../memory/statistics'
import { toMemoryHttpError } from '../../memory/api-errors'
import type { MemoryScope } from '../../../shared/memory'

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  const scope = single(query.scope as string | string[] | undefined)
  const id = single((query.sessionId ?? query.projectId) as string | string[] | undefined)
  let selection: MemoryScope
  if (scope === 'global') selection = { scope: 'global' }
  else if (scope === 'dialogue' && id) selection = { scope: 'dialogue', sessionId: id }
  else if (scope === 'project' && id) selection = { scope: 'project', projectId: id }
  else throw createError({ statusCode: 400, statusMessage: 'scope and its id are required' })
  try {
    return getMemoryStatistics(getChatDatabase(), selection)
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
