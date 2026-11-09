import {
  MAX_SEARCH_MATCHES,
  MAX_QUERY_LENGTH,
  MAX_TEXT_BYTES,
  failure,
  success,
  type SearchTextData,
  type TextStatsData,
  type ToolResult,
} from './file-tool-contracts'

function validateText(text: string): ToolResult<void> {
  if (typeof text !== 'string') {
    return failure('INVALID_INPUT', 'text must be a string')
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    return failure('TOO_LARGE', `text exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`)
  }

  return success(undefined)
}

function splitLines(text: string): string[] {
  if (text === '') {
    return []
  }

  const lines = text.split(/\r\n|\r|\n/u)
  if (lines.at(-1) === '') {
    lines.pop()
  }
  return lines
}

export function searchText(text: string, query: string): ToolResult<SearchTextData> {
  const textCheck = validateText(text)
  if (!textCheck.ok) {
    return textCheck
  }
  if (typeof query !== 'string' || query.length === 0 || query.length > MAX_QUERY_LENGTH) {
    return failure('INVALID_INPUT', `query must contain 1-${MAX_QUERY_LENGTH} characters`)
  }

  const matches: Array<{ lineNumber: number; line: string }> = []
  for (const [index, line] of splitLines(text).entries()) {
    if (!line.includes(query)) {
      continue
    }
    if (matches.length < MAX_SEARCH_MATCHES) {
      matches.push({ lineNumber: index + 1, line })
    }
  }

  const totalMatches = splitLines(text).filter(line => line.includes(query)).length
  return success({
    matches,
    truncated: totalMatches > MAX_SEARCH_MATCHES,
  })
}

export function textStats(text: string): ToolResult<TextStatsData> {
  const textCheck = validateText(text)
  if (!textCheck.ok) {
    return textCheck
  }

  return success({
    lines: splitLines(text).length,
    words: text.trim() === '' ? 0 : text.trim().split(/\s+/u).length,
    characters: Array.from(text).length,
  })
}
