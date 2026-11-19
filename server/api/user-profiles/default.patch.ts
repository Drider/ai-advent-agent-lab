import { createError, defineEventHandler, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createUserProfileRepository, UserProfileError } from '../../persistence/user-profile-repository'
import { invalidUserProfileRequest, toUserProfileHttpError } from '../../user-profiles/api-errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  let body: unknown
  try {
    body = await readBody(event, { strict: true })
    if (typeof body !== 'object' || body === null || Array.isArray(body)
      || Object.keys(body).length !== 1 || !('profileId' in body) || typeof body.profileId !== 'string') {
      throw new Error('request must contain only profileId')
    }
  } catch (error) {
    throw invalidUserProfileRequest(error)
  }
  try {
    return createUserProfileRepository(getChatDatabase()).setDefault((body as { profileId: string }).profileId)
  } catch (error) {
    if (error instanceof UserProfileError) throw toUserProfileHttpError(error)
    throw createError({ statusCode: 500, statusMessage: 'Could not set the default user profile', cause: error })
  }
})
