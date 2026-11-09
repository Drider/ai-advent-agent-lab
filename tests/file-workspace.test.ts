import { mkdir, mkdtemp, readFile as readFileFs, rm, symlink, writeFile as writeFileFs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileWorkspace } from '../server/tools/files'

const MAX_TEXT_BYTES = 16 * 1024

let rootDir: string
let outsideDir: string

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'agent-file-workspace-'))
  outsideDir = await mkdtemp(join(tmpdir(), 'agent-file-workspace-outside-'))
})

afterEach(async () => {
  await Promise.all([
    rm(rootDir, { recursive: true, force: true }),
    rm(outsideDir, { recursive: true, force: true }),
  ])
})

describe('findFiles', () => {
  it('uses the data directory under the current working directory by default', async () => {
    await mkdir(join(rootDir, 'data', 'notes'), { recursive: true })
    await writeFileFs(join(rootDir, 'data', 'notes', 'a.md'), 'TODO: проверить')
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootDir)

    try {
      await expect(createFileWorkspace().readFile('notes/a.md')).resolves.toEqual({
        ok: true,
        data: { path: 'notes/a.md', text: 'TODO: проверить' },
      })
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('finds sorted files with shallow and recursive glob patterns', async () => {
    await mkdir(join(rootDir, 'notes', 'deep'), { recursive: true })
    await Promise.all([
      writeFileFs(join(rootDir, 'notes', 'b.md'), 'b'),
      writeFileFs(join(rootDir, 'notes', 'a.md'), 'a'),
      writeFileFs(join(rootDir, 'notes', 'deep', 'c.md'), 'c'),
      writeFileFs(join(rootDir, 'notes', 'a.txt'), 'txt'),
    ])
    const workspace = createFileWorkspace(rootDir)

    await expect(workspace.findFiles('notes/*.md')).resolves.toEqual({
      ok: true,
      data: { paths: ['notes/a.md', 'notes/b.md'], truncated: false },
    })
    await expect(workspace.findFiles('notes/**/*.md')).resolves.toEqual({
      ok: true,
      data: { paths: ['notes/a.md', 'notes/b.md', 'notes/deep/c.md'], truncated: false },
    })
  })

  it('returns an empty result for a missing root and no matches', async () => {
    const workspace = createFileWorkspace(join(rootDir, 'missing'))

    await expect(workspace.findFiles('notes/*.md')).resolves.toEqual({
      ok: true,
      data: { paths: [], truncated: false },
    })
  })

  it('rejects unsafe patterns and skips symlinks', async () => {
    await mkdir(join(rootDir, 'notes'), { recursive: true })
    await writeFileFs(join(outsideDir, 'secret.md'), 'secret')
    await symlink(join(outsideDir, 'secret.md'), join(rootDir, 'notes', 'link.md'))
    await symlink(outsideDir, join(rootDir, 'external'))
    const workspace = createFileWorkspace(rootDir)

    for (const pattern of ['../*.md', '/tmp/*.md', 'notes\\*.md', 'notes/\0.md']) {
      await expect(workspace.findFiles(pattern)).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_PATH' },
      })
    }
    await expect(workspace.findFiles('notes/*.md')).resolves.toEqual({
      ok: true,
      data: { paths: [], truncated: false },
    })
  })

  it('enforces scan and result limits', async () => {
    await mkdir(join(rootDir, 'notes'), { recursive: true })
    await Promise.all(
      Array.from({ length: 51 }, (_, index) => writeFileFs(join(rootDir, 'notes', `${String(index).padStart(2, '0')}.md`), 'x')),
    )
    const workspace = createFileWorkspace(rootDir)
    const result = await workspace.findFiles('notes/*.md')

    expect(result).toEqual({
      ok: true,
      data: { paths: expect.arrayContaining(['notes/00.md', 'notes/49.md']), truncated: true },
    })
    if (result.ok) {
      expect(result.data.paths).toHaveLength(50)
    }
  })
})

describe('readFile', () => {
  it('reads a relative UTF-8 text file', async () => {
    await mkdir(join(rootDir, 'notes'), { recursive: true })
    await writeFileFs(join(rootDir, 'notes', 'a.md'), 'TODO: проверить')
    const workspace = createFileWorkspace(rootDir)

    await expect(workspace.readFile('notes/a.md')).resolves.toEqual({
      ok: true,
      data: { path: 'notes/a.md', text: 'TODO: проверить' },
    })
  })

  it('reports missing paths, directories, unsafe paths, symlinks, and large files', async () => {
    await mkdir(join(rootDir, 'notes'), { recursive: true })
    await writeFileFs(join(outsideDir, 'secret.md'), 'secret')
    await writeFileFs(join(rootDir, 'notes', 'exact.txt'), Buffer.alloc(MAX_TEXT_BYTES, 97))
    await writeFileFs(join(rootDir, 'notes', 'large.txt'), Buffer.alloc(MAX_TEXT_BYTES + 1, 97))
    await writeFileFs(join(rootDir, 'notes', 'binary.txt'), Buffer.from([0xff, 0xfe]))
    await writeFileFs(join(rootDir, 'notes', 'nul.txt'), Buffer.from('a\0b'))
    await symlink(join(outsideDir, 'secret.md'), join(rootDir, 'notes', 'link.md'))
    const workspace = createFileWorkspace(rootDir)

    await expect(workspace.readFile('notes/missing.md')).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    await expect(workspace.readFile('notes')).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_A_FILE' },
    })
    for (const path of ['../secret.md', resolve(outsideDir, 'secret.md'), 'notes\\secret.md', 'notes/\0.md', 'notes/link.md']) {
      await expect(workspace.readFile(path)).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_PATH' },
      })
    }
    const unsafeResult = await workspace.readFile(resolve(outsideDir, 'secret.md'))
    expect(JSON.stringify(unsafeResult)).not.toContain(outsideDir)
    const absoluteResult = await workspace.readFile('/tmp/exposed.txt')
    expect(JSON.stringify(absoluteResult)).not.toContain('/tmp/exposed.txt')
    await expect(workspace.readFile('notes/exact.txt')).resolves.toMatchObject({ ok: true })
    await expect(workspace.readFile('notes/large.txt')).resolves.toMatchObject({
      ok: false,
      error: { code: 'TOO_LARGE' },
    })
    await expect(workspace.readFile('notes/binary.txt')).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_TEXT' },
    })
    await expect(workspace.readFile('notes/nul.txt')).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_TEXT' },
    })
  })
})

describe('writeFile', () => {
  it('creates parent directories and writes a new UTF-8 file', async () => {
    const workspace = createFileWorkspace(rootDir)

    await expect(workspace.writeFile('reports/test.md', 'Привет')).resolves.toEqual({
      ok: true,
      data: { path: 'reports/test.md', bytesWritten: 12 },
    })
    await expect(readFileFs(join(rootDir, 'reports', 'test.md'), 'utf8')).resolves.toBe('Привет')
    await expect(workspace.writeFile('reports/empty.md', '')).resolves.toEqual({
      ok: true,
      data: { path: 'reports/empty.md', bytesWritten: 0 },
    })
    await expect(workspace.writeFile('reports/exact.md', 'a'.repeat(MAX_TEXT_BYTES))).resolves.toMatchObject({ ok: true })
    await expect(workspace.writeFile('reports/large.md', 'a'.repeat(MAX_TEXT_BYTES + 1))).resolves.toMatchObject({
      ok: false,
      error: { code: 'TOO_LARGE' },
    })
  })

  it('does not overwrite existing files and resolves concurrent writes exclusively', async () => {
    const workspace = createFileWorkspace(rootDir)

    await expect(workspace.writeFile('reports/existing.md', 'first')).resolves.toMatchObject({ ok: true })
    await expect(workspace.writeFile('reports/existing.md', 'second')).resolves.toMatchObject({
      ok: false,
      error: { code: 'ALREADY_EXISTS' },
    })
    await expect(readFileFs(join(rootDir, 'reports', 'existing.md'), 'utf8')).resolves.toBe('first')

    const results = await Promise.all([
      workspace.writeFile('reports/race.md', 'left'),
      workspace.writeFile('reports/race.md', 'right'),
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toHaveLength(1)
    expect(results.find(result => !result.ok)).toMatchObject({ error: { code: 'ALREADY_EXISTS' } })
    await expect(readFileFs(join(rootDir, 'reports', 'race.md'), 'utf8')).resolves.toMatch(/^(left|right)$/)
  })

  it('rejects unsafe destinations without touching files outside the root', async () => {
    await writeFileFs(join(outsideDir, 'secret.md'), 'secret')
    await symlink(outsideDir, join(rootDir, 'external'))
    const workspace = createFileWorkspace(rootDir)

    for (const path of ['../outside.md', resolve(outsideDir, 'outside.md'), 'reports\\outside.md', 'reports/\0.md', 'external/created.md']) {
      await expect(workspace.writeFile(path, 'blocked')).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_PATH' },
      })
    }
    await expect(readFileFs(join(outsideDir, 'secret.md'), 'utf8')).resolves.toBe('secret')
  })
})
