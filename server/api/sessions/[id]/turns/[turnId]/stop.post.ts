import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../../../../persistence/db'
import { createTurnRepository } from '../../../../../persistence/turn-repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const sessionId = getRouterParam(event, 'id')
  const turnId = getRouterParam(event, 'turnId')
  if (!sessionId || !turnId) {
    throw createError({ statusCode: 404, statusMessage: 'Turn not found' })
  }

  const turns = createTurnRepository(getChatDatabase())
  const lastTurn = turns.getLastTurn(sessionId)
  if (!lastTurn || lastTurn.id !== turnId) {
    throw createError({ statusCode: 404, statusMessage: 'Turn not found' })
  }
  if (lastTurn.status !== 'running' && lastTurn.status !== 'stopped') {
    throw createError({ statusCode: 409, statusMessage: 'Turn is not running' })
  }

  turns.markStopped(turnId)
  return { ok: true, sessionId, turnId, status: 'stopped' as const }
})
