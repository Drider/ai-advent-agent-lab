import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createUserProfileRepository, UserProfileError } from '../../persistence/user-profile-repository'
import { toUserProfileHttpError } from '../../user-profiles/api-errors'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 404, statusMessage: 'User profile not found' })

  try {
    const deleted = createUserProfileRepository(getChatDatabase()).delete(id)
    if (!deleted) throw createError({ statusCode: 404, statusMessage: 'User profile not found' })
    return { id, deleted: true }
  } catch (error) {
    if (error instanceof UserProfileError) throw toUserProfileHttpError(error)
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    throw createError({ statusCode: 500, statusMessage: 'Could not delete user profile', cause: error })
  }
})
