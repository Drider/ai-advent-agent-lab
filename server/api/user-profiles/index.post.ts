import { createError, defineEventHandler, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createUserProfileRepository, UserProfileError } from '../../persistence/user-profile-repository'
import { invalidUserProfileRequest, toUserProfileHttpError } from '../../user-profiles/api-errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  let body: unknown
  try {
    body = await readBody(event, { strict: true })
  } catch (error) {
    throw invalidUserProfileRequest(error)
  }
  try {
    return createUserProfileRepository(getChatDatabase()).create(body)
  } catch (error) {
    if (error instanceof UserProfileError) throw toUserProfileHttpError(error)
    throw createError({ statusCode: 500, statusMessage: 'Could not create user profile', cause: error })
  }
})
