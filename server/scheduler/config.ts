import { join } from 'node:path'
import type { McpServerConfig } from '../mcp/client'
import type { SchedulerSourceConfig } from '../../shared/scheduler'

function configError(message: string): Error { return new Error(`scheduler configuration ${message}`) }

export function parseSchedulerSources(raw: string | undefined): SchedulerSourceConfig[] {
  const input = raw?.trim() || JSON.stringify([{ id: 'clock', kind: 'clock', allowedQueryKeys: [] }])
  let parsed: unknown
  try { parsed = JSON.parse(input) } catch { throw configError('sources must be valid JSON') }
  if (!Array.isArray(parsed) || parsed.length === 0) throw configError('sources must be a non-empty array')
  const ids = new Set<string>()
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw configError(`source ${index} must be an object`)
    const value = entry as Record<string, unknown>
    const id = value.id
    const kind = value.kind
    const allowedQueryKeys = value.allowedQueryKeys
    if (typeof id !== 'string' || !/^[a-z0-9_]+$/u.test(id)) throw configError(`source ${index} id is invalid`)
    if (ids.has(id)) throw configError(`contains duplicate source id: ${id}`)
    if (kind !== 'clock' && kind !== 'http_json') throw configError(`source ${index} kind is invalid`)
    if (!Array.isArray(allowedQueryKeys) || allowedQueryKeys.some(key => typeof key !== 'string' || !/^[a-zA-Z0-9_.-]+$/u.test(key))) throw configError(`source ${index} allowedQueryKeys is invalid`)
    if (kind === 'clock') {
      if (value.url !== undefined) throw configError(`clock source ${index} cannot have a URL`)
      ids.add(id)
      return { id, kind, allowedQueryKeys: [...allowedQueryKeys] }
    }
    if (typeof value.url !== 'string') throw configError(`source ${index} url is required`)
    let url: URL
    try { url = new URL(value.url) } catch { throw configError(`source ${index} url is invalid`) }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) throw configError(`source ${index} url must use HTTPS`)
    ids.add(id)
    return { id, kind, url: url.toString(), allowedQueryKeys: [...allowedQueryKeys] }
  })
}

export function parseSchedulerMcpServer(raw?: string): McpServerConfig {
  if (!raw?.trim()) return { id: 'scheduler', command: process.execPath, args: [join(process.cwd(), 'scripts/scheduler-mcp-server.mjs')] }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw configError('MCP server must be valid JSON') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw configError('MCP server must be an object')
  const value = parsed as Record<string, unknown>
  if (value.id !== undefined && value.id !== 'scheduler') throw configError('MCP server id must be scheduler')
  if (typeof value.command !== 'string' || !value.command.trim()) throw configError('MCP server command is required')
  if (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== 'string')) throw configError('MCP server args must be strings')
  return { id: 'scheduler', command: value.command, args: [...value.args] }
}
