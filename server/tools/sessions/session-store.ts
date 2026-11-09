import { lstat, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { failure, success } from '../files/file-tool-contracts'
import { createFileWorkspace } from '../files/file-workspace'
import { parseSessionLog, type SessionLog } from './session-analysis'

export const MAX_SESSION_FILE_BYTES = 2 * 1024 * 1024
const MAX_SESSION_FILES = 100

export interface SessionStoreOptions {
  rootDir?: string
  runsDir?: string
  importsDir?: string
}

export function createSessionStore(options: SessionStoreOptions = {}) {
  const rootDir = options.rootDir ?? join(process.cwd(), 'data')
  const runsDir = options.runsDir ?? join(rootDir, 'runs')
  const importsDir = options.importsDir ?? join(rootDir, 'session-imports')
  const workspace = createFileWorkspace(rootDir, MAX_SESSION_FILE_BYTES)

  async function readSessionFile(path: string) {
    if (!path.endsWith('.json')) {
      return failure('INVALID_INPUT', 'session file must have a .json extension')
    }
    const file = await workspace.readFile(path)
    if (!file.ok) return file
    try {
      return success({ path: file.data.path, session: parseSessionLog(file.data.text) })
    } catch {
      return failure('INVALID_INPUT', 'file is not a valid application session log')
    }
  }

  async function loadSessions(): Promise<{ sessions: SessionLog[]; skippedFiles: number; truncated: boolean }> {
    const files: Array<{ directory: string; name: string; source: 'local' | 'uploaded' }> = []
    for (const [directory, source] of [[runsDir, 'local'], [importsDir, 'uploaded']] as const) {
      try {
        const names = await readdir(directory)
        files.push(...names.filter(name => /^run-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.json$/.test(name))
          .map(name => ({ directory, name, source })))
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    files.sort((a, b) => b.name.localeCompare(a.name))
    const truncated = files.length > MAX_SESSION_FILES
    let skippedFiles = 0
    const sessions = new Map<string, SessionLog>()
    for (const file of files.slice(0, MAX_SESSION_FILES)) {
      try {
        const path = join(file.directory, file.name)
        const info = await lstat(path)
        if (!info.isFile() || info.size > MAX_SESSION_FILE_BYTES) {
          skippedFiles += 1
          continue
        }
        const relativePath = relative(rootDir, path)
        const safePath = relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
        const session = {
          ...parseSessionLog(await readFile(path, 'utf8')),
          source: file.source,
          path: safePath ? relativePath.split(sep).join('/') : undefined,
        }
        const existing = sessions.get(session.runId)
        if (!existing || session.updatedAt >= existing.updatedAt) sessions.set(session.runId, session)
      } catch {
        skippedFiles += 1
      }
    }
    return { sessions: [...sessions.values()], skippedFiles, truncated }
  }

  return { loadSessions, readSessionFile }
}
