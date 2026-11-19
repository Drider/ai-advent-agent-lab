import { createError, defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createUserProfileRepository, UserProfileError } from '../../persistence/user-profile-repository'
import { invalidUserProfileRequest, toUserProfileHttpError } from '../../user-profiles/api-errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 404, statusMessage: 'User profile not found' })
  let body: unknown
  try {
    body = await readBody(event, { strict: true })
  } catch (error) {
    throw invalidUserProfileRequest(error)
  }
  try {
    return createUserProfileRepository(getChatDatabase()).update(id, body)
  } catch (error) {
    if (error instanceof UserProfileError) throw toUserProfileHttpError(error)
    throw createError({ statusCode: 500, statusMessage: 'Could not update user profile', cause: error })
  }
})
