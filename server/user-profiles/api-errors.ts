import { createError } from 'h3'
import { UserProfileError } from '../persistence/user-profile-repository'

export function toUserProfileHttpError(error: unknown): Error {
  if (!(error instanceof UserProfileError)) {
    return error instanceof Error ? error : createError({ statusCode: 500, statusMessage: 'User profile operation failed' })
  }
  const statusCode = error.code === 'NOT_FOUND'
    ? 404
    : error.code === 'NAME_CONFLICT' || error.code === 'REVISION_CONFLICT' || error.code === 'SESSION_RUNNING' || error.code === 'TURN_NOT_ACTIVE'
      ? 409
      : 400
  return createError({ statusCode, statusMessage: error.message, data: { code: error.code } })
}

export function invalidUserProfileRequest(error: unknown): Error {
  return createError({
    statusCode: 400,
    statusMessage: error instanceof Error ? error.message : 'Invalid user profile request',
    data: { code: 'INVALID_INPUT' },
  })
}
