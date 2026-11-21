import { createError } from 'h3'
import { TaskError } from '../../shared/task'

export function toTaskHttpError(error: unknown): Error {
  if (!(error instanceof TaskError)) {
    return error instanceof Error ? error : createError({ statusCode: 500, statusMessage: 'Task operation failed' })
  }
  const statusCode = error.code === 'NOT_FOUND'
    ? 404
    : error.code === 'INVALID_INPUT' || error.code === 'SUMMARY_REQUIRED'
      ? 400
      : 409
  return createError({
    statusCode,
    statusMessage: error.message,
    data: {
      code: error.code,
      ...(error.allowedNext === undefined ? {} : { allowedNext: error.allowedNext }),
      ...(error.missing === undefined ? {} : { missing: error.missing }),
      ...(error.snapshot === undefined ? {} : { task: error.snapshot }),
    },
  })
}

export function invalidTaskRequest(error: unknown): Error {
  return createError({
    statusCode: 400,
    statusMessage: error instanceof Error ? error.message : 'Invalid task request',
    data: { code: 'INVALID_INPUT' },
  })
}
