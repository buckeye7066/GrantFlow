/**
 * Entity-map totality tripwire (epic slice 8/9 residual).
 *
 * Every `client.entities.<Name>` referenced anywhere in src/ must be either
 * (a) mapped to a real backend resource in entityResourceMap, or (b) listed
 * in KNOWN_STUB_ENTITIES below -- the documented, consciously-accepted set
 * whose writes land in the in-memory stub store and vanish on reload.
 *
 * Why: ChecklistItem / GrantAward / ComplianceReport silently fell through to
 * createStubEntityClient for months -- the UI toasted success while the data
 * evaporated. A stub is only acceptable when it is a DECLARED decision; this
 * test makes an undeclared one a red build, in both directions:
 *   - a NEW unmapped entity reference fails ("stub by accident")
 *   - a KNOWN_STUB entry that gains a real mapping fails ("stale list")
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import client from './client.js'

// Empty on purpose: every previously-declared stub now has a real resource.
// Grow this list only with a deliberate PR decision.
const KNOWN_STUB_ENTITIES = Object.freeze([])

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(js|jsx|ts|tsx)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) out.push(full)
  }
  return out
}

function referencedEntityNames() {
  const srcRoot = path.join(process.cwd(), 'src')
  const names = new Set()
  const re = /\bentities\.([A-Z][A-Za-z0-9]*)\b/g
  for (const file of walk(srcRoot, [])) {
    const text = fs.readFileSync(file, 'utf8')
    let m
    while ((m = re.exec(text)) !== null) names.add(m[1])
  }
  return names
}

describe('entityResourceMap totality', () => {
  const mapped = new Set(Object.keys(client.entityResourceMap ?? {}))
  const referenced = referencedEntityNames()

  it('every entity referenced in src/ is mapped or a DECLARED stub', () => {
    const undeclared = Array.from(referenced).filter(
      (name) => !mapped.has(name) && !KNOWN_STUB_ENTITIES.includes(name),
    )
    expect(
      undeclared,
      `entities falling through to the in-memory stub store WITHOUT a declaration (writes vanish on reload): ${undeclared.join(', ')} -- map them to a real backend resource or consciously add them to KNOWN_STUB_ENTITIES`,
    ).toEqual([])
  })

  it('no DECLARED stub is secretly mapped (stale list)', () => {
    const stale = KNOWN_STUB_ENTITIES.filter((name) => mapped.has(name))
    expect(stale, `remove from KNOWN_STUB_ENTITIES -- now real: ${stale.join(', ')}`).toEqual([])
  })

  it('the previously-lost grant-scoped entities are REAL now and stay real', () => {
    for (const name of ['ChecklistItem', 'GrantAward', 'ComplianceReport']) {
      expect(mapped.has(name), `${name} must map to a real backend resource`).toBe(true)
    }
  })

  it('consultant workspace entities persist (no more vanishing invoices)', () => {
    for (const name of ['Invoice', 'InvoiceLine', 'Project', 'TimeEntry', 'TimeLog', 'BillingAccount']) {
      expect(mapped.has(name), `${name} must map to a real backend resource`).toBe(true)
    }
  })

  it('the last declared stubs are REAL now and stay real', () => {
    for (const name of ['AiArtifact', 'PartnerSource', 'SearchJob', 'Taxonomy']) {
      expect(mapped.has(name), `${name} must map to a real backend resource`).toBe(true)
    }
  })
})
