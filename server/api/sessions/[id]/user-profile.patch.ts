import { createError, defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { createUserProfileRepository, UserProfileError } from '../../../persistence/user-profile-repository'
import type { UserProfileSummary } from '../../../../shared/user-profile'
import { invalidUserProfileRequest, toUserProfileHttpError } from '../../../user-profiles/api-errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const sessionId = getRouterParam(event, 'id')
  if (!sessionId) throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  let profileId: string
  try {
    const body = await readBody(event, { strict: true }) as unknown
    if (typeof body !== 'object' || body === null || Array.isArray(body)
      || Object.keys(body).length !== 1 || !('profileId' in body) || typeof body.profileId !== 'string') {
      throw new Error('request must contain only profileId')
    }
    profileId = body.profileId
  } catch (error) {
    throw invalidUserProfileRequest(error)
  }

  try {
    const profile = createUserProfileRepository(getChatDatabase()).selectForSession(sessionId, profileId)
    const userProfile: UserProfileSummary = {
      id: profile.id,
      name: profile.name,
      revision: profile.revision,
      defaultWorkflowId: profile.defaultWorkflowId,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    }
    return { userProfileId: profile.id, userProfile }
  } catch (error) {
    if (error instanceof UserProfileError) throw toUserProfileHttpError(error)
    throw createError({ statusCode: 500, statusMessage: 'Could not select user profile', cause: error })
  }
})
