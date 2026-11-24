import { execFile as execFileCallback, spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const execFile = promisify(execFileCallback)
const MAX_OUTPUT_LENGTH = 64 * 1024

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  }
}

function assertInsideRepository(repositoryRoot, requestedPath) {
  if (requestedPath === undefined || requestedPath === '') return undefined
  if (isAbsolute(requestedPath)) throw new Error('path must be relative to the repository')
  const candidate = resolve(repositoryRoot, requestedPath)
  const outside = relative(repositoryRoot, candidate)
  if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
    throw new Error('path must stay inside the repository')
  }
  return requestedPath
}

function createGitRunner(repositoryRoot) {
  return async (args) => {
    return await new Promise((resolveOutput, reject) => {
      const child = spawn('git', ['-C', repositoryRoot, ...args], {
        cwd: repositoryRoot,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        shell: false,
        windowsHide: true,
      })
      const outputChunks = []
      let outputBytes = 0
      let outputTruncated = false
      let errorOutput = ''
      let settled = false

      child.stdout.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (outputBytes >= MAX_OUTPUT_LENGTH) {
          outputTruncated = true
          return
        }
        const remaining = MAX_OUTPUT_LENGTH - outputBytes
        outputChunks.push(buffer.subarray(0, remaining))
        outputBytes += Math.min(buffer.length, remaining)
        if (buffer.length > remaining) outputTruncated = true
      })
      child.stderr.on('data', chunk => {
        if (errorOutput.length < 16_384) errorOutput += String(chunk)
      })
      child.once('error', error => {
        if (settled) return
        settled = true
        reject(error)
      })
      child.once('close', code => {
        if (settled) return
        settled = true
        if (code !== 0) {
          reject(new Error(errorOutput.trim() || `git exited with code ${code ?? 'unknown'}`))
          return
        }
        const output = Buffer.concat(outputChunks).toString('utf8')
        resolveOutput(outputTruncated ? `${output}\n[output truncated]` : output)
      })
    })
  }
}

async function findRepositoryRoot(requestedPath) {
  const candidate = await realpath(resolve(requestedPath))
  const result = await execFile('git', ['-C', candidate, 'rev-parse', '--show-toplevel'], {
    cwd: candidate,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    windowsHide: true,
  })
  return await realpath(result.stdout.trim())
}

function registerGitTools(server, repositoryRoot) {
  const runGit = createGitRunner(repositoryRoot)

  server.registerTool('git_status', {
    title: 'Git status',
    description: 'Show the current branch and changed or untracked files in the configured repository.',
    inputSchema: {},
  }, async () => {
    try {
      const output = (await runGit(['status', '--short', '--branch'])).trim()
      return {
        content: [{ type: 'text', text: output || 'clean' }],
      }
    } catch (error) {
      return toolError(error)
    }
  })

  server.registerTool('git_log', {
    title: 'Git log',
    description: 'Show recent commits from the configured repository.',
    inputSchema: {
      limit: z.number().int().min(1).max(20).default(10),
    },
  }, async ({ limit = 10 }) => {
    try {
      const output = (await runGit(['log', '--oneline', '--decorate', `-${limit}`])).trim()
      return {
        content: [{ type: 'text', text: output || 'no commits' }],
      }
    } catch (error) {
      return toolError(new Error(`no commits: ${error instanceof Error ? error.message : String(error)}`))
    }
  })

  server.registerTool('git_diff', {
    title: 'Git diff',
    description: 'Show unstaged or staged changes in the configured repository. Untracked files are not included.',
    inputSchema: {
      staged: z.boolean().default(false),
      path: z.string().optional(),
    },
  }, async ({ staged = false, path }) => {
    try {
      const safePath = assertInsideRepository(repositoryRoot, path)
      const args = ['diff']
      if (staged) args.push('--cached')
      args.push('--')
      if (safePath !== undefined) args.push(safePath)
      const output = await runGit(args)
      return {
        content: [{ type: 'text', text: output || 'clean' }],
      }
    } catch (error) {
      return toolError(error)
    }
  })
}

async function main() {
  const repositoryRoot = await findRepositoryRoot(process.argv[2] ?? process.cwd())
  const server = new McpServer({ name: 'git-readonly-mcp', version: '1.0.0' })
  registerGitTools(server, repositoryRoot)
  await server.connect(new StdioServerTransport())
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
