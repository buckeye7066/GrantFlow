/**
 * Dry-run is REMOVED OUTRIGHT from owner-facing HTTP routes (owner order
 * 2026-08-13; #1389 did the agent-control surface, this PR does the routes).
 * A request NAMING the flag fails with 400 — it never silently proceeds as a
 * real run the caller believed was a preview. Services keep their internal
 * parameters; routes pass real intent explicitly.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { rejectDryRunBody } = await import('../utils/noDryRun.js')

function makeRes() {
  const res = { statusCode: null, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  return res
}

describe('rejectDryRunBody', () => {
  it('400s when dry_run is named — true, false, either spelling', () => {
    for (const body of [{ dry_run: true }, { dry_run: false }, { dryRun: true }, { dryRun: false }]) {
      const res = makeRes()
      expect(rejectDryRunBody({ body }, res)).toBe(true)
      expect(res.statusCode).toBe(400)
      expect(String(res.body?.error || '')).toMatch(/removed/i)
    }
  })

  it('passes clean bodies untouched', () => {
    for (const body of [{}, { limit: 5 }, undefined, null, 'not-an-object']) {
      const res = makeRes()
      expect(rejectDryRunBody({ body }, res)).toBe(false)
      expect(res.statusCode).toBe(null)
    }
  })
})

describe('STATIC TRIPWIRE: no route reads a dry-run flag from a request body', () => {
  it('backend/routes never consults body dry_run/dryRun outside the rejector', () => {
    const dir = path.join(process.cwd(), 'backend', 'routes')
    const offenders = []
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.js')) continue
      const src = fs.readFileSync(path.join(dir, entry), 'utf8')
      // A body READ of the flag — `body.dryRun`, `req.body?.dry_run`, or a
      // destructured `dry_run:` alias — is the defect. rejectDryRunBody guards
      // are fine; internal constants (dryRun: false/true passed to services)
      // are fine.
      const reads = src.match(/(?:req\.)?body\??\.(?:dryRun|dry_run)\b|\bdry_run\s*:\s*dryRun\b|\{\s*[^}]*\bdry_run\s*:\s*\w+\s*=/g) || []
      if (reads.length > 0) offenders.push(`${entry}: ${reads.join(' | ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
