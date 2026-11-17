import { createError, defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../../../persistence/db'
import { createHistoryClearService } from '../../../../memory/clear-service'
import { toMemoryHttpError } from '../../../../memory/api-errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const sessionId = getRouterParam(event, 'id')
  const body = await readBody(event) as { operationId?: unknown }
  if (!sessionId || !body || typeof body.operationId !== 'string' || body.operationId.length === 0) throw createError({ statusCode: 400, statusMessage: 'operationId is required' })
  try {
    return await createHistoryClearService(getChatDatabase()).clear(sessionId, body.operationId)
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
