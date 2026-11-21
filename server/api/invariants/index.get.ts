import { defineEventHandler, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createInvariantRepository } from '../../persistence/invariant-repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const repository = createInvariantRepository(getChatDatabase())
  return {
    invariants: repository.list(),
    changes: repository.listChanges(50),
  }
})
