import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function readRepoFile(relativePath) {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

test('canonical rules forbid fake production data, fake proof, and bypassed guardrails', () => {
  const doc = readRepoFile('docs/canonical_rules.md')
  assert.match(doc, /Truthful data, truthful proof, no fake shortcuts/)
  assert.match(doc, /Do not fake funding/)
  assert.match(doc, /Do not fake production proof/)
  assert.match(doc, /Do not bypass guardrails/)
  assert.match(doc, /Missing evidence is a gap, not a license to invent/)
})

test('offline crawler routing proof labels itself honestly', () => {
  const script = readRepoFile('scripts/crawler-profile-routing-proof.mjs')
  assert.match(script, /NOT a live web-crawl proof/)
  assert.match(script, /deterministic\/offline code-path proof/)
  assert.doesNotMatch(script, /live crawl proof/i)
})
