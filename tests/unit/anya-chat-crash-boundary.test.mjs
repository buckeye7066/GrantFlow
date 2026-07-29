import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (relative) => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

const boundary = read('src/components/anya/SafeAnyaChat.jsx')
const floating = read('src/components/anya/AnyaFloatingButton.jsx')
const vite = read('vite.config.ts')

test('SafeAnyaChat is a real React error boundary with an in-place retry', () => {
  assert.match(boundary, /class AnyaChatErrorBoundary extends React\.Component/)
  assert.match(boundary, /static getDerivedStateFromError\(\)/)
  assert.match(boundary, /componentDidCatch\(error, info\)/)
  assert.match(boundary, /Retry Anya/)
  assert.match(boundary, /<AnyaChat \{\.\.\.props\} \/>/)
})

test('page-level Anya imports resolve through the boundary before the broad @ alias', () => {
  const safeAlias = vite.indexOf("'@/components/anya/AnyaChat':")
  const broadAlias = vite.indexOf("'@': path.resolve")
  assert.ok(safeAlias >= 0, 'exact Anya alias must exist')
  assert.ok(broadAlias > safeAlias, 'exact Anya alias must precede the broad @ alias')
  assert.match(vite, /src\/components\/anya\/SafeAnyaChat\.jsx/)
})

test('the relative floating-panel import also uses SafeAnyaChat', () => {
  assert.match(floating, /import AnyaChat from "\.\/SafeAnyaChat"/)
  assert.doesNotMatch(floating, /import AnyaChat from "\.\/AnyaChat"/)
})
