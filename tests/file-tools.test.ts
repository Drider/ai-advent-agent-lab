import { mkdtemp, readFile as readFileFs, rm, writeFile as writeFileFs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileTools } from '../server/tools/files'

function safeParse(schema: unknown, value: unknown): { success: boolean } {
  return (schema as { safeParse(input: unknown): { success: boolean } }).safeParse(value)
}

let rootDir: string

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'agent-file-tools-'))
})

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

describe('createFileTools', () => {
  it('exposes the five expected tools and validates their input schemas', () => {
    const tools = createFileTools({ rootDir })

    expect(Object.keys(tools)).toEqual(['find_files', 'read_file', 'search_text', 'text_stats', 'write_file'])
    expect(safeParse(tools.find_files.inputSchema, { pattern: 'notes/*.md' }).success).toBe(true)
    expect(safeParse(tools.find_files.inputSchema, { pattern: '' }).success).toBe(false)
    expect(safeParse(tools.read_file.inputSchema, { path: 'notes/a.md' }).success).toBe(true)
    expect(safeParse(tools.search_text.inputSchema, { text: '', query: 'TODO' }).success).toBe(true)
    expect(safeParse(tools.search_text.inputSchema, { text: 'text', query: '' }).success).toBe(false)
    expect(safeParse(tools.text_stats.inputSchema, { text: 'text' }).success).toBe(true)
    expect(safeParse(tools.write_file.inputSchema, { path: 'report.md', content: '' }).success).toBe(true)
    expect(safeParse(tools.write_file.inputSchema, { path: 'report.md' }).success).toBe(false)
    expect(safeParse(tools.write_file.inputSchema, {
      path: 'report.md',
      content: 'a'.repeat(16 * 1024 + 1),
    }).success).toBe(false)
  })

  it('executes each tool against the configured workspace', async () => {
    await writeFileFs(join(rootDir, 'notes.md'), 'TODO: one\nready')
    const tools = createFileTools({ rootDir })
    const context = { toolCallId: 'call-1', messages: [], context: {} }

    await expect(tools.find_files.execute({ pattern: '*.md' }, context)).resolves.toMatchObject({
      ok: true,
      data: { paths: ['notes.md'] },
    })
    await expect(tools.read_file.execute({ path: 'notes.md' }, context)).resolves.toEqual({
      ok: true,
      data: { path: 'notes.md', text: 'TODO: one\nready' },
    })
    expect(tools.search_text.execute({ text: 'TODO: one\nready', query: 'TODO' }, context)).toMatchObject({
      ok: true,
      data: { matches: [{ lineNumber: 1, line: 'TODO: one' }] },
    })
    expect(tools.text_stats.execute({ text: 'TODO: one\nready' }, context)).toMatchObject({
      ok: true,
      data: { lines: 2, words: 3, characters: 15 },
    })
    await expect(tools.write_file.execute({ path: 'reports/todo.md', content: 'TODO: one' }, context)).resolves.toMatchObject({
      ok: true,
      data: { path: 'reports/todo.md', bytesWritten: 9 },
    })
    await expect(readFileFs(join(rootDir, 'reports', 'todo.md'), 'utf8')).resolves.toBe('TODO: one')
  })

  it('returns sanitized operation errors', async () => {
    const tools = createFileTools({ rootDir })
    const result = await tools.read_file.execute({ path: 'missing.md' }, {
      toolCallId: 'call-1',
      messages: [],
      context: {},
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(JSON.stringify(result)).not.toContain(rootDir)
  })
})
