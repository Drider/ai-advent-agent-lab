export const MAX_TEXT_BYTES = 16 * 1024
export const MAX_PATH_LENGTH = 512
export const MAX_PATTERN_LENGTH = 256
export const MAX_QUERY_LENGTH = 256
export const MAX_FIND_RESULTS = 50
export const MAX_SEARCH_MATCHES = 100
export const MAX_SCAN_ENTRIES = 1000

export type ToolErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'ALREADY_EXISTS'
  | 'TOO_LARGE'
  | 'NOT_TEXT'
  | 'SCAN_LIMIT'
  | 'IO_ERROR'

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ToolErrorCode; message: string } }

export interface FindFilesData {
  paths: string[]
  truncated: boolean
}

export interface ReadFileData {
  path: string
  text: string
}

export interface WriteFileData {
  path: string
  bytesWritten: number
}

export interface SearchTextData {
  matches: Array<{ lineNumber: number; line: string }>
  truncated: boolean
}

export interface TextStatsData {
  lines: number
  words: number
  characters: number
}

export function success<T>(data: T): ToolResult<T> {
  return { ok: true, data }
}

export function failure<T = never>(code: ToolErrorCode, message: string): ToolResult<T> {
  return { ok: false, error: { code, message } }
}
