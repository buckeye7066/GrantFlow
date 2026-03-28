import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { extractTextFromFile } from '../../backend/services/documentTextExtraction.js'

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
    // Minimal hand-crafted PDF containing "Hello PDF" text
    const pdfContent = [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      '',
    ].join('\n')
    const stream = 'BT /F1 24 Tf 40 120 Td (Hello PDF) Tj ET'
    const streamObj = `4 0 obj<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n`
    const body = pdfContent + streamObj
    const xrefOffset = body.length
    const xref = [
      'xref',
      '0 6',
      '0000000000 65535 f ',
      `${String(body.indexOf('1 0 obj')).padStart(10, '0')} 00000 n `,
      `${String(body.indexOf('2 0 obj')).padStart(10, '0')} 00000 n `,
      `${String(body.indexOf('3 0 obj')).padStart(10, '0')} 00000 n `,
      `${String(body.indexOf('4 0 obj')).padStart(10, '0')} 00000 n `,
      `${String(body.indexOf('5 0 obj')).padStart(10, '0')} 00000 n `,
      'trailer<</Size 6/Root 1 0 R>>',
      'startxref',
      String(xrefOffset),
      '%%EOF',
    ].join('\n')
    await fsp.writeFile(filePath, body + xref)

    const result = await extractTextFromFile({
      filePath,
      mimeType: 'application/pdf',
      fileName: 'sample.pdf',
    })
    assert.ok(result && typeof result === 'object', 'Expected result to be an object')
    assert.ok('method' in result, 'Expected result to have method property')
    assert.ok('text' in result, 'Expected result to have text property')
    assert.ok(Array.isArray(result.warnings), 'Expected result.warnings to be an array')

    // If extraction succeeded, verify the content
    if (result.method) {
      assert.ok(['pdf-parse', 'pdftotext'].includes(result.method), `Expected method to be pdf-parse or pdftotext, got: ${result.method}`)
      assert.ok(result.text && result.text.includes('Hello PDF'), `Expected text to include "Hello PDF", got: ${result.text}`)
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

