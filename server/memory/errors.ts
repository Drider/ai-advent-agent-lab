export type MemoryErrorCode =
  | 'INVALID_INPUT'
  | 'REVISION_CONFLICT'
  | 'NOT_FOUND'
  | 'PROJECT_ALREADY_ASSIGNED'
  | 'SESSION_RUNNING'
  | 'HISTORY_CLEAR_PENDING'
  | 'MEMORY_BUDGET_EXCEEDED'

export class MemoryError extends Error {
  constructor(
    public readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MemoryError'
  }
}
