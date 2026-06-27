import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function readRepoFile(relativePath) {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

test('Anya panel keeps a phone-friendly full-width sheet with safe-area padding', () => {
  const file = readRepoFile('src/components/anya/AnyaFloatingButton.jsx')
  assert.match(file, /h-\[100dvh\]/)
  assert.match(file, /w-full sm:w-\[540px\] md:w-\[600px\]/)
  assert.match(file, /pt-\[env\(safe-area-inset-top\)\]/)
  assert.match(file, /pb-\[env\(safe-area-inset-bottom\)\]/)
})

test('profile action-plan controls stack on mobile and keep stable button height', () => {
  const file = readRepoFile('src/components/profiles/ProfileActionPlanCard.jsx')
  assert.match(file, /flex flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row/)
  assert.match(file, /className="h-11 justify-center gap-2 bg-blue-600/)
  assert.match(file, /className="h-11 justify-center gap-2 border-slate-300/)
  assert.match(file, /className="h-11 justify-center gap-2 border-emerald-300/)
})

test('profile file upload flow keeps mobile-first controls and document grid', () => {
  const file = readRepoFile('src/components/profiles/ProfileFilesPanel.jsx')
  assert.match(file, /flex flex-col gap-3 md:flex-row md:items-end md:justify-between/)
  assert.match(file, /flex flex-col gap-3 sm:flex-row sm:items-center/)
  assert.match(file, /grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4/)
})
