import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 404, statusMessage: 'Session not found' })

  const row = getChatDatabase().prepare('SELECT revision, status FROM sessions WHERE id = ?').get(id) as { revision: number; status: string } | undefined
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  return { revision: row.revision, status: row.status }
})
