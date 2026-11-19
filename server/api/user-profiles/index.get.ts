import { defineEventHandler, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createUserProfileRepository } from '../../persistence/user-profile-repository'

export default defineEventHandler((event) => {
  const db = getChatDatabase()
  setHeader(event, 'Cache-Control', 'no-store')
  const profiles = createUserProfileRepository(db)
  return { items: profiles.list(), defaultProfileId: profiles.getDefaultId() }
})
