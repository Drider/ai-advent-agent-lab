import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const serverPath = join(process.cwd(), 'scripts', 'git-mcp-server.mjs')
const clients: Client[] = []

async function git(repo: string, ...args: string[]) {
  return await execFile('git', ['-C', repo, ...args])
}

async function createClient(repo: string) {
  const client = new Client({ name: 'git-mcp-test-client', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, repo],
  })
  await client.connect(transport)
  clients.push(client)
  return client
}

function text(result: unknown) {
  if (typeof result !== 'object' || result === null || !('content' in result) || !Array.isArray(result.content)) {
    return ''
  }
  const part = result.content.find(item => typeof item === 'object' && item !== null && 'type' in item && item.type === 'text')
  return typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : ''
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
})

describe('git MCP server', () => {
  it('exposes read-only status, log, and diff tools over stdio', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'git-mcp-repo-'))
    await git(repo, 'init', '-q')
    await git(repo, 'config', 'user.email', 'test@example.com')
    await git(repo, 'config', 'user.name', 'MCP Test')
    await writeFile(join(repo, 'README.md'), 'before\n')
    await git(repo, 'add', 'README.md')
    await git(repo, 'commit', '-qm', 'initial commit')
    await writeFile(join(repo, 'README.md'), 'after\n')
    await writeFile(join(repo, 'untracked.txt'), 'not part of diff\n')

    const client = await createClient(repo)
    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual(['git_status', 'git_log', 'git_diff'])
    expect(listed.tools.find(tool => tool.name === 'git_log')?.inputSchema).toMatchObject({ type: 'object' })

    const status = await client.callTool({ name: 'git_status', arguments: {} })
    expect(text(status)).toContain('README.md')
    expect(text(status)).toContain('untracked.txt')

    const log = await client.callTool({ name: 'git_log', arguments: { limit: 1 } })
    expect(text(log)).toContain('initial commit')

    const diff = await client.callTool({ name: 'git_diff', arguments: { path: 'README.md' } })
    expect(text(diff)).toContain('-before')
    expect(text(diff)).toContain('+after')
    expect(text(diff)).not.toContain('not part of diff')
  })

  it('rejects paths outside the repository and truncates large diffs', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'git-mcp-large-repo-'))
    await git(repo, 'init', '-q')
    await git(repo, 'config', 'user.email', 'test@example.com')
    await git(repo, 'config', 'user.name', 'MCP Test')
    await writeFile(join(repo, 'large.txt'), 'small\n')
    await git(repo, 'add', 'large.txt')
    await git(repo, 'commit', '-qm', 'initial commit')
    await writeFile(join(repo, 'large.txt'), `${'x'.repeat(300_000)}\n`)

    const client = await createClient(repo)
    const outside = await client.callTool({ name: 'git_diff', arguments: { path: '../outside.txt' } })
    expect(outside.isError).toBe(true)

    const diff = await client.callTool({ name: 'git_diff', arguments: { path: 'large.txt' } })
    expect(text(diff).length).toBeLessThanOrEqual(66_000)
    expect(text(diff)).toContain('[output truncated]')
  })

  it('returns a tool error when history is requested before the first commit', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'git-mcp-empty-repo-'))
    await git(repo, 'init', '-q')
    const client = await createClient(repo)

    const log = await client.callTool({ name: 'git_log', arguments: { limit: 10 } })
    expect(log.isError).toBe(true)
    expect(text(log)).toContain('no commits')
  })
})
