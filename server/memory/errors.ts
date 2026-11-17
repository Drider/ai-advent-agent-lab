export type MemoryErrorCode = 'INVALID_INPUT' | 'REVISION_CONFLICT' | 'NOT_FOUND'

export class MemoryError extends Error {
  constructor(
    public readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MemoryError'
  }
}
