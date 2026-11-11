import { mkdir, open, readdir, lstat, writeFile as writeFileFs } from 'node:fs/promises'
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path'
import {
  MAX_FIND_RESULTS,
  MAX_PATH_LENGTH,
  MAX_PATTERN_LENGTH,
  MAX_PDF_BYTES,
  MAX_SCAN_ENTRIES,
  MAX_TEXT_BYTES,
  failure,
  success,
  type FindFilesData,
  type ReadFileData,
  type ReadPdfData,
  type ToolResult,
  type WriteFileData,
} from './file-tool-contracts'

const decoder = new TextDecoder('utf-8', { fatal: true })

function invalidPath(_value: string): ToolResult<never> {
  return failure('INVALID_PATH', 'path is not allowed')
}

function validateRelativePath(value: string, maxLength: number): boolean {
  if (!value || value.length > maxLength || value.includes('\0') || value.includes('\\') || isAbsolute(value)) {
    return false
  }

  return !value.split('/').some(part => part === '..')
}

function toRelativePath(value: string): string {
  return value.split('/').filter(Boolean).join('/')
}

function isInsideRoot(rootDir: string, candidate: string): boolean {
  const rel = relative(rootDir, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function rejectSymlinkComponents(rootDir: string, relativePath: string, allowMissingFinal: boolean): Promise<ToolResult<void>> {
  const parts = relativePath.split('/').filter(Boolean)
  let current = rootDir

  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink()) {
        return invalidPath(relativePath)
      }
    } catch (error) {
      if (allowMissingFinal && index === parts.length - 1 && isMissing(error)) {
        return success(undefined)
      }
      if (isMissing(error)) {
        return failure('NOT_FOUND', 'file was not found')
      }
      return failure('IO_ERROR', 'could not inspect the requested path')
    }
  }

  return success(undefined)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isTooLarge(buffer: Buffer, maxBytes: number): boolean {
  return buffer.byteLength > maxBytes
}

function decodeText(buffer: Buffer): ToolResult<string> {
  if (buffer.includes(0)) {
    return failure('NOT_TEXT', 'file contains a NUL byte')
  }

  try {
    return success(decoder.decode(buffer))
  } catch {
    return failure('NOT_TEXT', 'file is not valid UTF-8 text')
  }
}

function pdfTextChunk(text: string, offset: number): ToolResult<{ text: string; nextOffset: number | null }> {
  let position = 0
  let bytes = 0
  const chunk: string[] = []

  for (const character of text) {
    if (position++ < offset) continue
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > MAX_TEXT_BYTES) {
      return success({ text: chunk.join(''), nextOffset: position - 1 })
    }
    bytes += characterBytes
    chunk.push(character)
  }

  return offset > position
    ? failure('INVALID_INPUT', 'offset exceeds the page text length')
    : success({ text: chunk.join(''), nextOffset: null })
}

function validatePattern(pattern: string): ToolResult<void> {
  if (!validateRelativePath(pattern, MAX_PATTERN_LENGTH)) {
    return invalidPath(pattern)
  }

  return success(undefined)
}

async function readTextFile(rootDir: string, relativePath: string, maxBytes: number): Promise<ToolResult<string>> {
  const pathCheck = await rejectSymlinkComponents(rootDir, relativePath, false)
  if (!pathCheck.ok) {
    return pathCheck
  }

  const absolutePath = join(rootDir, ...relativePath.split('/'))
  let fileHandle
  try {
    fileHandle = await open(absolutePath, 'r')
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0)
    const content = buffer.subarray(0, bytesRead)
    if (isTooLarge(content, maxBytes)) {
      return failure('TOO_LARGE', `file exceeds ${maxBytes} UTF-8 bytes`)
    }
    return decodeText(content)
  } catch (error) {
    if (isMissing(error)) {
      return failure('NOT_FOUND', 'file was not found')
    }
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EISDIR') {
      return failure('NOT_A_FILE', 'path is not a regular file')
    }
    return failure('IO_ERROR', 'could not read the requested file')
  } finally {
    await fileHandle?.close().catch(() => undefined)
  }
}

export function createFileWorkspace(rootDir = join(process.cwd(), 'data'), maxReadBytes = MAX_TEXT_BYTES) {
  const absoluteRoot = resolve(rootDir)

  async function findFiles(pattern: string): Promise<ToolResult<FindFilesData>> {
    if (typeof pattern !== 'string') {
      return failure('INVALID_INPUT', 'pattern must be a string')
    }
    const patternCheck = validatePattern(pattern)
    if (!patternCheck.ok) {
      return patternCheck
    }

    try {
      const rootStats = await lstat(absoluteRoot)
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        return success({ paths: [], truncated: false })
      }
    } catch (error) {
      if (isMissing(error)) {
        return success({ paths: [], truncated: false })
      }
      return failure('IO_ERROR', 'could not inspect the file workspace')
    }

    const paths: string[] = []
    let scannedEntries = 0
    let scanLimitReached = false

    async function visit(directory: string, relativeDirectory: string): Promise<void> {
      if (scanLimitReached) {
        return
      }

      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        scannedEntries += 1
        if (scannedEntries > MAX_SCAN_ENTRIES) {
          scanLimitReached = true
          return
        }
        if (entry.isSymbolicLink()) {
          continue
        }

        const entryRelativePath = toRelativePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name)
        const entryAbsolutePath = join(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(entryAbsolutePath, entryRelativePath)
          continue
        }
        if (entry.isFile() && matchesGlob(entryRelativePath, pattern)) {
          paths.push(entryRelativePath)
        }
      }
    }

    try {
      await visit(absoluteRoot, '')
    } catch {
      return failure('IO_ERROR', 'could not scan the file workspace')
    }
    if (scanLimitReached) {
      return failure('SCAN_LIMIT', `workspace scan exceeds ${MAX_SCAN_ENTRIES} entries`)
    }

    paths.sort()
    return success({
      paths: paths.slice(0, MAX_FIND_RESULTS),
      truncated: paths.length > MAX_FIND_RESULTS,
    })
  }

  async function readFile(path: string): Promise<ToolResult<ReadFileData>> {
    if (typeof path !== 'string' || !validateRelativePath(path, MAX_PATH_LENGTH)) {
      return invalidPath(typeof path === 'string' ? path : '')
    }

    const relativePath = toRelativePath(path)
    const absolutePath = resolve(absoluteRoot, ...relativePath.split('/'))
    if (!isInsideRoot(absoluteRoot, absolutePath)) {
      return invalidPath(path)
    }

    const result = await readTextFile(absoluteRoot, relativePath, maxReadBytes)
    return result.ok ? success({ path: relativePath, text: result.data }) : result
  }

  async function readPdf(path: string, page = 1, offset = 0): Promise<ToolResult<ReadPdfData>> {
    if (typeof path !== 'string' || !validateRelativePath(path, MAX_PATH_LENGTH)) {
      return invalidPath(typeof path === 'string' ? path : '')
    }
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(offset) || offset < 0) {
      return failure('INVALID_INPUT', 'page must be positive and offset must be non-negative integers')
    }

    const relativePath = toRelativePath(path)
    if (!relativePath.toLowerCase().endsWith('.pdf')) {
      return failure('INVALID_PDF', 'path must point to a PDF file')
    }
    const absolutePath = resolve(absoluteRoot, ...relativePath.split('/'))
    if (!isInsideRoot(absoluteRoot, absolutePath)) return invalidPath(path)
    const pathCheck = await rejectSymlinkComponents(absoluteRoot, relativePath, false)
    if (!pathCheck.ok) return pathCheck

    let fileHandle
    let buffer: Buffer
    try {
      fileHandle = await open(absolutePath, 'r')
      const stats = await fileHandle.stat()
      if (!stats.isFile()) return failure('NOT_A_FILE', 'path is not a regular file')
      if (stats.size > MAX_PDF_BYTES) return failure('TOO_LARGE', `PDF exceeds ${MAX_PDF_BYTES} bytes`)

      buffer = Buffer.alloc(stats.size + 1)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const result = await fileHandle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (result.bytesRead === 0) break
        bytesRead += result.bytesRead
      }
      if (bytesRead > MAX_PDF_BYTES) return failure('TOO_LARGE', `PDF exceeds ${MAX_PDF_BYTES} bytes`)
      buffer = buffer.subarray(0, bytesRead)
    } catch (error) {
      if (isMissing(error)) return failure('NOT_FOUND', 'file was not found')
      return failure('IO_ERROR', 'could not read the requested PDF')
    } finally {
      await fileHandle?.close().catch(() => undefined)
    }

    if (buffer.subarray(0, 1024).indexOf('%PDF-') === -1) {
      return failure('INVALID_PDF', 'file is not a valid PDF')
    }

    try {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const task = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true })
      try {
        const document = await task.promise
        if (page > document.numPages) return failure('INVALID_INPUT', 'page exceeds the PDF page count')
        const pdfPage = await document.getPage(page)
        const content = await pdfPage.getTextContent()
        const text = content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trimEnd()
        const chunk = pdfTextChunk(text, offset)
        return chunk.ok
          ? success({ path: relativePath, page, totalPages: document.numPages, ...chunk.data })
          : chunk
      } finally {
        await task.destroy()
      }
    } catch {
      return failure('INVALID_PDF', 'could not extract text from the PDF')
    }
  }

  async function writeFile(path: string, content: string): Promise<ToolResult<WriteFileData>> {
    if (typeof path !== 'string' || !validateRelativePath(path, MAX_PATH_LENGTH)) {
      return invalidPath(typeof path === 'string' ? path : '')
    }
    if (typeof content !== 'string') {
      return failure('INVALID_INPUT', 'content must be a string')
    }
    const bytesWritten = Buffer.byteLength(content, 'utf8')
    if (bytesWritten > MAX_TEXT_BYTES) {
      return failure('TOO_LARGE', `content exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`)
    }

    const relativePath = toRelativePath(path)
    const absolutePath = resolve(absoluteRoot, ...relativePath.split('/'))
    if (!isInsideRoot(absoluteRoot, absolutePath)) {
      return invalidPath(path)
    }

    const parts = relativePath.split('/')
    const relativeParent = parts.slice(0, -1).join('/')
    const parentCheck = await rejectSymlinkComponents(absoluteRoot, relativeParent, true)
    if (!parentCheck.ok && parentCheck.error.code !== 'NOT_FOUND') {
      return parentCheck
    }

    try {
      await mkdir(dirnameFor(absolutePath), { recursive: true })
      const pathCheck = await rejectSymlinkComponents(absoluteRoot, relativePath, true)
      if (!pathCheck.ok) {
        return pathCheck
      }
      await writeFileFs(absolutePath, content, { encoding: 'utf8', flag: 'wx' })
      return success({ path: relativePath, bytesWritten })
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        return failure('ALREADY_EXISTS', 'file already exists')
      }
      if (isMissing(error)) {
        return failure('NOT_FOUND', 'parent directory was not found')
      }
      return failure('IO_ERROR', 'could not create the requested file')
    }
  }

  return {
    findFiles,
    readFile,
    readPdf,
    writeFile,
  }
}

function dirnameFor(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf(sep))
  return lastSlash === -1 ? path : path.slice(0, lastSlash)
}
