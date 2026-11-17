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
    public readonly details: { layer?: 'working' | 'long_term'; estimatedTokens?: number; budgetTokens?: number } = {},
  ) {
    super(message)
    this.name = 'MemoryError'
  }

  get layer(): 'working' | 'long_term' | undefined {
    return this.details.layer
  }

  get estimatedTokens(): number | undefined {
    return this.details.estimatedTokens
  }

  get budgetTokens(): number | undefined {
    return this.details.budgetTokens
  }
}
