import { tool } from 'ai'
import { z } from 'zod'
import {
  MAX_PATH_LENGTH,
  MAX_PATTERN_LENGTH,
  MAX_QUERY_LENGTH,
  MAX_TEXT_BYTES,
} from './file-tool-contracts'
import { createFileWorkspace } from './file-workspace'
import { searchText, textStats } from './text-tools'

const relativePathSchema = z.string().min(1).max(MAX_PATH_LENGTH)
const patternSchema = z.string().min(1).max(MAX_PATTERN_LENGTH)
const textSchema = z.string().refine(
  value => Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES,
  `text must be no larger than ${MAX_TEXT_BYTES} UTF-8 bytes`,
)

export function createFileTools(options: { rootDir?: string } = {}) {
  const workspace = createFileWorkspace(options.rootDir)

  return {
    find_files: tool({
      description: 'Find regular files under the configured workspace using a relative glob such as notes/*.md or documents/*.pdf. Returns sorted relative paths and a truncation flag.',
      inputSchema: z.object({
        pattern: patternSchema.describe('Relative glob pattern, for example notes/*.md or notes/**/*.md'),
      }),
      execute: ({ pattern }) => workspace.findFiles(pattern),
    }),
    read_file: tool({
      description: 'Read one UTF-8 text file from the configured workspace by its relative path. The result includes the exact path and text or a structured error.',
      inputSchema: z.object({
        path: relativePathSchema.describe('Relative file path inside the workspace'),
      }),
      execute: ({ path }) => workspace.readFile(path),
    }),
    read_pdf: tool({
      description: 'Extract text from one PDF up to 20 MiB in the workspace. Read one page at a time; nextOffset gives the next chunk of the same page, or null when the page is complete. Scanned pages without a text layer return empty text.',
      inputSchema: z.object({
        path: relativePathSchema.describe('Relative path to a .pdf file inside the workspace'),
        page: z.number().int().positive().optional().describe('1-based page number; defaults to 1'),
        offset: z.number().int().nonnegative().optional().describe('Unicode character offset within the page; defaults to 0'),
      }),
      execute: ({ path, page, offset }) => workspace.readPdf(path, page, offset),
    }),
    search_text: tool({
      description: 'Search literal, case-sensitive text in supplied content by line. This does not interpret the query as a regular expression.',
      inputSchema: z.object({
        text: textSchema.describe('Text to search, up to 16 KiB in UTF-8'),
        query: z.string().min(1).max(MAX_QUERY_LENGTH).describe('Literal non-empty search text'),
      }),
      execute: ({ text, query }) => searchText(text, query),
    }),
    text_stats: tool({
      description: 'Count lines, whitespace-delimited words, and Unicode code points in supplied text.',
      inputSchema: z.object({
        text: textSchema.describe('Text to measure, up to 16 KiB in UTF-8'),
      }),
      execute: ({ text }) => textStats(text),
    }),
    write_file: tool({
      description: 'Create a new UTF-8 text file inside the configured workspace. Parent directories are created; an existing file is never overwritten.',
      inputSchema: z.object({
        path: relativePathSchema.describe('Relative destination path inside the workspace'),
        content: textSchema.describe('UTF-8 text content, up to 16 KiB'),
      }),
      execute: ({ path, content }) => workspace.writeFile(path, content),
    }),
  }
}

export type FileTools = ReturnType<typeof createFileTools>
