import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('Anya health reports the live registry', () => {
  const route = readFileSync('backend/routes/anya.js', 'utf8')
  it('does not use the unpopulated database snapshot as registry truth', () => {
    assert.ok(!route.includes("safeCount('SELECT COUNT(*) AS count FROM anya_tool_registry_snapshot')"))
    assert.ok(route.includes("listTools({ userId: 'anya-health-probe', isAdmin: true })"))
    assert.ok(route.includes('ok: tool_registry > 0'))
  })
})
