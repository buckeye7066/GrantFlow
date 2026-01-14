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

