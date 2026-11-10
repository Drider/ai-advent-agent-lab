import { defineEventHandler, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createSessionRepository } from '../../persistence/session-repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  return createSessionRepository(getChatDatabase()).createSession()
})
