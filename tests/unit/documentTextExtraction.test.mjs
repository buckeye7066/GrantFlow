import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { extractTextFromFile } from '../../backend/services/documentTextExtraction.js'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

async function withTempFile(name, content) {
  const dir = await fsp.mkdtemp(join(os.tmpdir(), 'grantflow-doc-'))
  const filePath = join(dir, name)
  await fsp.writeFile(filePath, content)
  return { dir, filePath }
}

test('extractTextFromFile: text/plain extracts text', async () => {
  const { dir, filePath } = await withTempFile('hello.txt', 'Hello world\n\n')
  try {
    const result = await extractTextFromFile({
      filePath,
      mimeType: 'text/plain',
      fileName: 'hello.txt',
    })
    assert.equal(result.method, 'text')
    assert.equal(result.text, 'Hello world')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('extractTextFromFile: unsupported mime returns a helpful warning', async () => {
  const { dir, filePath } = await withTempFile('data.bin', 'nope')
  try {
    const result = await extractTextFromFile({
      filePath,
      mimeType: 'application/x-custom',
      fileName: 'data.bin',
    })
    assert.equal(result.text, null)
    assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('extractTextFromFile: application/rtf extracts readable text', async () => {
  const rtf = `{\\rtf1\\ansi\\deff0\nHello \\b world\\b0\\par\nSecond line\\par\n}`
  const { dir, filePath } = await withTempFile('sample.rtf', rtf)
  try {
    const result = await extractTextFromFile({
      filePath,
      mimeType: 'application/rtf',
      fileName: 'sample.rtf',
    })
    assert.equal(result.method, 'rtf')
    assert.ok(result.text && result.text.includes('Hello world'))
    assert.ok(result.text && result.text.includes('Second line'))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('extractTextFromFile: PDF extracts text via pdf-parse', async () => {
  const dir = await fsp.mkdtemp(join(os.tmpdir(), 'grantflow-doc-'))
  const filePath = join(dir, 'sample.pdf')
  try {
    const pdfDoc = await PDFDocument.create()
    const page = pdfDoc.addPage([400, 200])
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
    page.drawText('Hello PDF', { x: 40, y: 120, size: 24, font, color: rgb(0, 0, 0) })
    const bytes = await pdfDoc.save()
    await fsp.writeFile(filePath, Buffer.from(bytes))

    const result = await extractTextFromFile({
      filePath,
      mimeType: 'application/pdf',
      fileName: 'sample.pdf',
    })
    assert.ok(['pdf-parse', 'pdftotext'].includes(result.method))
    assert.ok(result.text && result.text.includes('Hello PDF'))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

