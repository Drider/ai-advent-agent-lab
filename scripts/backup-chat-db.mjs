import { access, chmod, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'

function argumentValue(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(name + ' requires a path')
  }
  return value
}

function privatePath(path, mode) {
  if (process.platform !== 'win32') {
    return chmod(path, mode).catch(() => undefined)
  }
  return Promise.resolve()
}

const args = process.argv.slice(2)
const projectRoot = resolve(import.meta.dirname, '..')
const sourcePath = resolve(argumentValue(args, '--source') ?? join(projectRoot, 'data', 'chat.sqlite'))
const outputPath = resolve(argumentValue(args, '--output') ?? join(
  projectRoot,
  'data',
  'backups',
  'chat-' + new Date().toISOString() + '.sqlite',
))

await access(sourcePath)
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
await privatePath(dirname(outputPath), 0o700)

const source = new Database(sourcePath)
try {
  await source.backup(outputPath)
  await privatePath(outputPath, 0o600)
  process.stdout.write(outputPath + '\n')
} finally {
  source.close()
}
