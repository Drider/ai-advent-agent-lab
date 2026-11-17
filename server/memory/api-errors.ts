import { createError } from 'h3'
import { MemoryError } from './errors'

export function toMemoryHttpError(error: unknown): Error {
  if (!(error instanceof MemoryError)) {
    return error instanceof Error ? error : createError({ statusCode: 500, statusMessage: 'Memory operation failed' })
  }
  const statusCode = error.code === 'NOT_FOUND'
    ? 404
    : error.code === 'REVISION_CONFLICT' || error.code === 'PROJECT_ALREADY_ASSIGNED' || error.code === 'SESSION_RUNNING' || error.code === 'HISTORY_CLEAR_PENDING'
      ? 409
      : error.code === 'MEMORY_BUDGET_EXCEEDED'
        ? 422
        : 400
  return createError({ statusCode, statusMessage: error.message, data: { code: error.code } })
}
