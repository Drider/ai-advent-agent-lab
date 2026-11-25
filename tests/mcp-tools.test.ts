import { describe, expect, it, vi } from 'vitest'
import { tool, type ToolSet } from 'ai'
import type { ListToolsResult } from '@ai-sdk/mcp'
import { z } from 'zod'
import { connectMcpServers, parseMcpServers, type McpClientFactory } from '../server/mcp/client'

function fakeToolSet(label: string): ToolSet {
  return {
    lookup: tool({
      description: `${label} lookup`,
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => ({ label, query }),
    }),
  }
}

describe('parseMcpServers', () => {
  it('accepts an empty configuration and validates server entries', () => {
    expect(parseMcpServers('[]')).toEqual([])
    expect(parseMcpServers(JSON.stringify([
      { id: 'git', command: 'node', args: ['server.mjs'] },
    ]))).toEqual([
      { id: 'git', command: 'node', args: ['server.mjs'] },
    ])
  })

  it.each([
    ['not json', 'must be valid JSON'],
    ['{}', 'must be an array'],
    ['[{"id":"bad-id","command":"node","args":[]}]', 'id'],
    ['[{"id":"git","command":"","args":[]}]', 'command'],
    ['[{"id":"git","command":"node","args":[1]}]', 'args'],
  ])('rejects invalid configuration: %s', (raw, message) => {
    expect(() => parseMcpServers(raw)).toThrow(message)
  })

  it('rejects duplicate server ids', () => {
    expect(() => parseMcpServers(JSON.stringify([
      { id: 'git', command: 'node', args: [] },
      { id: 'git', command: 'node', args: [] },
    ]))).toThrow('duplicate')
  })
})

describe('connectMcpServers', () => {
  it('uses a 60-second default startup timeout for cold stdio servers', async () => {
    let startupTimeoutMs: number | undefined
    const createClient: McpClientFactory = vi.fn(async ({ timeoutMs }) => {
      startupTimeoutMs = timeoutMs
      return {
        listTools: async () => ({ tools: [] }),
        toolsFromDefinitions: () => ({}),
        close: async () => {},
      }
    })

    const connected = await connectMcpServers([
      { id: 'time', command: 'uvx', args: ['mcp-server-time'] },
    ], { createClient })

    expect(startupTimeoutMs).toBe(60_000)
    await connected.close()
  })

  it('lets stdio transports wait for modern protocol discovery', async () => {
    let waitsForProtocolDiscovery: boolean | undefined
    const createClient: McpClientFactory = vi.fn(async ({ transport }) => {
      waitsForProtocolDiscovery = transport.waitsForProtocolVersionDiscovery
      return {
        listTools: async () => ({ tools: [] }),
        toolsFromDefinitions: () => ({}),
        close: async () => {},
      }
    })

    const connected = await connectMcpServers([
      { id: 'time', command: 'uvx', args: ['mcp-server-time'] },
    ], { createClient })

    expect(waitsForProtocolDiscovery).toBe(true)
    await connected.close()
  })

  it('discovers paginated tools, namespaces them, and closes every client', async () => {
    const clients: Array<{ closed: boolean }> = []
    const createClient: McpClientFactory = vi.fn(async ({ server }) => {
      const state = { closed: false }
      clients.push(state)
      return {
        listTools: async (options?: { params?: { cursor?: string } }) => options?.params?.cursor === 'next'
          ? { tools: [{ name: 'second', description: 'second', inputSchema: { type: 'object' } }] }
          : { tools: [{ name: 'first', description: 'first', inputSchema: { type: 'object' } }], nextCursor: 'next' },
        toolsFromDefinitions: (definitions: ListToolsResult) => Object.fromEntries(
          definitions.tools.map(definition => [definition.name, fakeToolSet(server.id).lookup!]),
      ),
        close: async () => { state.closed = true },
      }
    })

    const connected = await connectMcpServers([
      { id: 'alpha', command: 'node', args: [] },
      { id: 'beta', command: 'node', args: [] },
    ], { createClient })

    expect(Object.keys(connected.tools)).toEqual([
      'mcp_alpha__first',
      'mcp_alpha__second',
      'mcp_beta__first',
      'mcp_beta__second',
    ])
    expect(connected.names).toEqual(Object.keys(connected.tools))
    await connected.close()
    await connected.close()
    expect(clients.every(client => client.closed)).toBe(true)
  })

  it('closes earlier clients when a later server fails to connect', async () => {
    const close = vi.fn(async () => {})
    const createClient: McpClientFactory = vi.fn(async ({ server }) => {
      if (server.id === 'broken') throw new Error('connection failed')
      return {
        listTools: async () => ({ tools: [] }),
        toolsFromDefinitions: () => ({}),
        close,
      }
    })

    await expect(connectMcpServers([
      { id: 'ok', command: 'node', args: [] },
      { id: 'broken', command: 'node', args: [] },
    ], { createClient })).rejects.toThrow('connection failed')
    expect(close).toHaveBeenCalledOnce()
  })

  it('bounds MCP startup when a server never finishes connecting', async () => {
    const createClient: McpClientFactory = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return {
        listTools: async () => ({ tools: [] }),
        toolsFromDefinitions: () => ({}),
        close: async () => {},
      }
    })

    await expect(connectMcpServers([
      { id: 'hung', command: 'node', args: [] },
    ], { createClient, timeoutMs: 10 })).rejects.toThrow('timed out')
  })
})
