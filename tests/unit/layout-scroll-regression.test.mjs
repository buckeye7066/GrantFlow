import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const layoutSource = readFileSync(path.join(process.cwd(), 'src/pages/Layout.jsx'), 'utf8')

test('app shell lets the document own vertical scrolling', () => {
  assert.doesNotMatch(
    layoutSource,
    /<main[^>]+overflow-hidden/,
    'main must not hide overflow; that makes the browser scrollbar a dead control',
  )
  assert.doesNotMatch(
    layoutSource,
    /<div[^>]+flex-1[^>]+overflow-auto[^>]+bg-background/,
    'the primary workspace must not be a nested page-height scroll container',
  )
})
