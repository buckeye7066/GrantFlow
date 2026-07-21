// TOTALITY guard (the MIGRATION-PARITY rule applied to EVA): every app in the
// portfolio registry MUST have a manifest in qa/manifests/, and every manifest
// MUST validate. A new portfolio app cannot silently fall out of coverage — it
// either gets a valid manifest or this test reds.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { loadRegistry, validateManifest } from '../services/eva/evaRegistry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MANIFEST_DIR = join(__dirname, '..', '..', 'qa', 'manifests')

describe('EVA manifest totality', () => {
  const registry = loadRegistry({ force: true })

  it('every registry app has a manifest file', () => {
    const missing = []
    for (const app of registry.apps) {
      const p = join(MANIFEST_DIR, `${app.app_id}.json`)
      if (!existsSync(p)) missing.push(app.app_id)
    }
    expect(missing, `apps without a manifest: ${missing.join(', ')}`).toEqual([])
  })

  it('every manifest validates against the safety-enforcing schema', () => {
    const failures = []
    for (const app of registry.apps) {
      const p = join(MANIFEST_DIR, `${app.app_id}.json`)
      if (!existsSync(p)) continue
      const manifest = JSON.parse(readFileSync(p, 'utf8'))
      const r = validateManifest(manifest)
      if (!r.ok) failures.push(`${app.app_id}: ${r.errors.join('; ')}`)
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('every manifest declares a non-empty prohibited-action policy', () => {
    for (const app of registry.apps) {
      const p = join(MANIFEST_DIR, `${app.app_id}.json`)
      if (!existsSync(p)) continue
      const manifest = JSON.parse(readFileSync(p, 'utf8'))
      expect(Array.isArray(manifest.prohibited_actions) && manifest.prohibited_actions.length > 0, `${app.app_id} has no prohibited_actions`).toBe(true)
    }
  })

  it("the manifest app_id matches its registry app_id", () => {
    for (const app of registry.apps) {
      const p = join(MANIFEST_DIR, `${app.app_id}.json`)
      if (!existsSync(p)) continue
      const manifest = JSON.parse(readFileSync(p, 'utf8'))
      expect(manifest.app_id).toBe(app.app_id)
    }
  })
})
