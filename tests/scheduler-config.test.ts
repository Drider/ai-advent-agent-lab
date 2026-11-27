import { describe, expect, it } from 'vitest'
import { parseSchedulerMcpServer, parseSchedulerSources } from '../server/scheduler/config'

describe('scheduler configuration', () => {
  it('provides a safe clock source by default', () => {
    expect(parseSchedulerSources(undefined)).toEqual([{ id: 'clock', kind: 'clock', allowedQueryKeys: [] }])
  })

  it('accepts HTTPS sources and rejects arbitrary HTTP URLs', () => {
    expect(parseSchedulerSources(JSON.stringify([{ id: 'weather', kind: 'http_json', url: 'https://example.com/data', allowedQueryKeys: ['city'] }]))).toEqual([
      { id: 'weather', kind: 'http_json', url: 'https://example.com/data', allowedQueryKeys: ['city'] },
    ])
    expect(() => parseSchedulerSources(JSON.stringify([{ id: 'unsafe', kind: 'http_json', url: 'http://example.com/data', allowedQueryKeys: [] }]))).toThrow('HTTPS')
  })

  it('uses the local scheduler MCP server by default', () => {
    const server = parseSchedulerMcpServer()
    expect(server.id).toBe('scheduler')
    expect(server.command).toBe(process.execPath)
    expect(server.args.at(-1)).toContain('scripts/scheduler-mcp-server.mjs')
  })
})
