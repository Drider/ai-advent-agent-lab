import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createUserProfileRepository } from '../../persistence/user-profile-repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 404, statusMessage: 'User profile not found' })
  const profile = createUserProfileRepository(getChatDatabase()).get(id)
  if (!profile) throw createError({ statusCode: 404, statusMessage: 'User profile not found' })
  return profile
})
