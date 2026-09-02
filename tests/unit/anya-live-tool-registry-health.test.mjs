import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Anya health reports the live registry', () => {
  const route = readFileSync('backend/routes/anya.js', 'utf8')
  it('does not use the unpopulated database snapshot as registry truth', () => {
    expect(route).not.toContain("safeCount('SELECT COUNT(*) AS count FROM anya_tool_registry_snapshot')")
    expect(route).toContain("listTools({ userId: 'anya-health-probe', isAdmin: true })")
    expect(route).toContain('ok: tool_registry > 0')
  })
})
