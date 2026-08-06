import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowsDir = path.join(repoRoot, '.github', 'workflows')
const immutableActionRef = /^[0-9a-f]{40}$/i

test('all external GitHub Actions are pinned to immutable commit SHAs', () => {
  const violations = []

  for (const filename of fs.readdirSync(workflowsDir).sort()) {
    if (!/\.ya?ml$/i.test(filename)) continue
    const lines = fs.readFileSync(path.join(workflowsDir, filename), 'utf8').split(/\r?\n/)

    lines.forEach((line, index) => {
      const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/)
      if (!match) return

      const target = match[1]
      if (target.startsWith('./')) return
      const separator = target.lastIndexOf('@')
      const ref = separator >= 0 ? target.slice(separator + 1) : ''
      if (!immutableActionRef.test(ref)) {
        violations.push(`${filename}:${index + 1} ${target}`)
      }
    })
  }

  assert.deepEqual(violations, [], `mutable action references:\n${violations.join('\n')}`)
})
