import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_PDF_BYTES, MAX_TEXT_BYTES, createFileTools, createFileWorkspace } from '../server/tools/files'

function makePdf(pages: string[], paddingBytes = 0): Buffer {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (const [index, text] of pages.entries()) {
    const pageId = 4 + index * 2
    const fontSize = text.length > 1000 ? 1 : 12
    const stream = `BT /F1 ${fontSize} Tf 72 720 Td ${text.match(/.{1,40}/g)!.map(part => `(${part}) Tj 0 -${fontSize} Td`).join(' ')} ET\n%${' '.repeat(paddingBytes)}\n`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`)
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf)
}

let rootDir: string
let outsideDir: string

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'agent-pdf-'))
  outsideDir = await mkdtemp(join(tmpdir(), 'agent-pdf-outside-'))
})

afterEach(async () => {
  await Promise.all([
    rm(rootDir, { recursive: true, force: true }),
    rm(outsideDir, { recursive: true, force: true }),
  ])
})

describe('readPdf', () => {
  it('extracts text by page and exposes the tool to the agent', async () => {
    await writeFile(join(rootDir, 'report.pdf'), makePdf(['First page', 'Second page']))
    const workspace = createFileWorkspace(rootDir)

    await expect(workspace.readPdf('report.pdf')).resolves.toEqual({
      ok: true,
      data: { path: 'report.pdf', page: 1, totalPages: 2, text: 'First page', nextOffset: null },
    })
    await expect(workspace.readPdf('report.pdf', 2)).resolves.toEqual({
      ok: true,
      data: { path: 'report.pdf', page: 2, totalPages: 2, text: 'Second page', nextOffset: null },
    })
    const tools = createFileTools({ rootDir })
    expect((tools.read_pdf.inputSchema as { safeParse(input: unknown): { success: boolean } }).safeParse({ path: 'report.pdf', page: 2, offset: 0 }).success).toBe(true)
    expect((tools.read_pdf.inputSchema as { safeParse(input: unknown): { success: boolean } }).safeParse({ path: 'report.pdf', page: 0 }).success).toBe(false)
    await expect(tools.read_pdf.execute({ path: 'report.pdf', page: 2 }, {
      toolCallId: 'read-pdf', messages: [], context: {},
    })).resolves.toMatchObject({ ok: true, data: { text: 'Second page' } })
  })

  it('splits a long page into bounded chunks', async () => {
    await writeFile(join(rootDir, 'long.pdf'), makePdf(['A'.repeat(MAX_TEXT_BYTES + 40)]))
    const workspace = createFileWorkspace(rootDir)
    const first = await workspace.readPdf('long.pdf')
    expect(first).toMatchObject({ ok: true, data: { nextOffset: MAX_TEXT_BYTES } })
    if (!first.ok) return
    expect(Buffer.byteLength(first.data.text)).toBe(MAX_TEXT_BYTES)
    const second = await workspace.readPdf('long.pdf', 1, first.data.nextOffset!)
    expect(second).toMatchObject({ ok: true, data: { nextOffset: null } })
    if (second.ok) expect((first.data.text + second.data.text).replace(/\s/g, '')).toBe('A'.repeat(MAX_TEXT_BYTES + 40))
  })

  it('rejects oversized, malformed, and unsafe files', async () => {
    await writeFile(join(rootDir, 'large.pdf'), Buffer.alloc(MAX_PDF_BYTES + 1))
    await writeFile(join(rootDir, 'bad.pdf'), 'not a pdf')
    await writeFile(join(outsideDir, 'secret.pdf'), makePdf(['Secret']))
    await symlink(join(outsideDir, 'secret.pdf'), join(rootDir, 'link.pdf'))
    const workspace = createFileWorkspace(rootDir)

    await expect(workspace.readPdf('large.pdf')).resolves.toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } })
    await expect(workspace.readPdf('bad.pdf')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_PDF' } })
    await expect(workspace.readPdf('missing.pdf')).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    await expect(workspace.readPdf('link.pdf')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_PATH' } })
    await expect(workspace.readPdf('../secret.pdf')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_PATH' } })
    await expect(workspace.readPdf('large.pdf', 0)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('accepts a valid PDF at the 20 MiB boundary', async () => {
    let paddingBytes = MAX_PDF_BYTES - makePdf(['Boundary']).byteLength
    let pdf = makePdf(['Boundary'], paddingBytes)
    while (pdf.byteLength !== MAX_PDF_BYTES) {
      paddingBytes += MAX_PDF_BYTES - pdf.byteLength
      pdf = makePdf(['Boundary'], paddingBytes)
    }
    await writeFile(join(rootDir, 'exact.pdf'), pdf)

    await expect(createFileWorkspace(rootDir).readPdf('exact.pdf')).resolves.toMatchObject({
      ok: true,
      data: { text: 'Boundary', totalPages: 1 },
    })
  })
})
