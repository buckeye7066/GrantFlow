import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const componentsRoot = path.join(root, 'src/components')

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolutePath)
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [absolutePath] : []
  })
}

test('components cannot bypass the cross-browser clipboard adapter', () => {
  const directClipboardApi = /\bnavigator\s*\.\s*clipboard\b|\bdocument\s*\.\s*execCommand\s*\(\s*['"]copy['"]/m
  const bypasses = sourceFiles(componentsRoot)
    .filter((absolutePath) => directClipboardApi.test(fs.readFileSync(absolutePath, 'utf8')))
    .map((absolutePath) => path.relative(root, absolutePath))

  assert.deepEqual(bypasses, [])
})

test('portal, saved-login, and diagnostics copy actions use the tested adapter', () => {
  for (const relativePath of [
    'src/components/proposals/GrantPortalAssistant.jsx',
    'src/components/profiles/SavedLoginsCard.jsx',
    'src/components/admin/AdminDiagnostics.jsx',
  ]) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
    assert.match(source, /import \{ copyTextToClipboard \} from ['"]@\/utils\/clipboard['"]/)
    assert.match(source, /await copyTextToClipboard\(/)
  }
})
