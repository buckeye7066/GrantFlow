import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const FILES = [
  'backend/services/robert/robertSourceAcquisition.js',
  'backend/services/robert/robertFunderLeads.js',
]

test('Robert crawler writers cannot bypass canonical pipeline admission', async () => {
  const sources = await Promise.all(FILES.map((file) => readFile(file, 'utf8')))
  for (let index = 0; index < FILES.length; index += 1) {
    assert.doesNotMatch(
      sources[index],
      /INSERT\s+INTO\s+grants/i,
      `${FILES[index]} must not write grants directly`,
    )
  }
  assert.match(
    sources[0],
    /saveToProfilePipeline/,
    'apply-ready Robert sources must use the canonical pipeline writer',
  )
})

test('funder research remains catalog-only until a leaf application exists', async () => {
  const source = await readFile(FILES[1], 'utf8')
  assert.match(source, /funder_lead_catalog_only/)
  assert.match(source, /not an application/)
})
