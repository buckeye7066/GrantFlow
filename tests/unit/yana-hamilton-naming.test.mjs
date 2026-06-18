/**
 * Yana → Hamilton naming regression guard.
 *
 * Role contract (docs/AGENT roles):
 *   - Yana     = Client Discovery / Lead Funnel  (legitimate)
 *   - Hamilton = Application Autopilot / Funding Completion + hard stops
 *
 * After the Yana→Hamilton rename, a few user-facing surfaces still attached
 * "Yana" to application-completion / hard-stop concepts. This test pins the
 * corrected strings so the stale labels cannot silently return.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

describe('Yana/Hamilton naming contract', () => {
  it('admin hard-stop tab is labeled Hamilton, not Yana', () => {
    const admin = read('src/pages/Admin.jsx')
    assert.ok(!/Yana hard stop/i.test(admin), 'Admin.jsx must not label hard stops as "Yana"')
    assert.ok(/Hamilton hard stops/.test(admin), 'Admin.jsx should show "Hamilton hard stops"')
  })

  it('pipeline card attributes application completion to Hamilton', () => {
    const card = read('src/components/pipeline/GrantCard.jsx')
    assert.ok(
      !/Yana\s+[—-]\s+application-completion/i.test(card),
      'GrantCard.jsx must not call Yana the application-completion agent',
    )
  })

  it('application-autopilot route + service tree are Hamilton-named', () => {
    assert.ok(fs.existsSync(path.join(root, 'backend/routes/hamiltonAutomation.js')))
    assert.ok(fs.existsSync(path.join(root, 'backend/services/hamilton/hamiltonAutopilotEngine.js')))
    // The legacy yana service directory must be gone (renamed, not duplicated).
    assert.ok(
      !fs.existsSync(path.join(root, 'backend/services/yana')),
      'backend/services/yana should have been renamed to backend/services/hamilton',
    )
  })
})
