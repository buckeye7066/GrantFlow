/**
 * Unit tests for the auto-repair service patterns added in response to the
 * 2026-04 / 2026-05 production-incident sweep. Each pattern below was a
 * real site-down bug at least once — these tests pin the scanner/applier
 * contracts so future edits cannot silently regress.
 *
 * The scanners and appliers are exercised via the `__testHelpers` named
 * export so we can test them in isolation against synthetic strings. We do
 * NOT invoke `runAutoRepair` with `dryRun=false` here because that walks
 * every file in `backend/` and `src/` and would rewrite the live repo as a
 * side-effect of running the test suite.
 */
import { describe, it, expect } from 'vitest'

import {
  AUTO_REPAIR_TYPES,
  __testHelpers,
  runAutoRepair,
} from '../services/anyaAutoRepairService.js'

const {
  scanMissingDbAwait,
  scanColumnTypos,
  scanUnstructured500,
  scanReasonObjectRender,
  scanProfileAdminSentinel,
  applyMissingDbAwait,
  applyColumnTypos,
  applyUnstructured500,
} = __testHelpers

const ROUTE_FILE = 'backend/routes/example.js'
const SERVICE_FILE = 'backend/services/example.js'
const COMPONENT_FILE = 'src/components/Example.jsx'

describe('AUTO_REPAIR_TYPES surface', () => {
  it('includes every pattern that fixed a recent production incident', () => {
    // Removing any of these would cause Anya to silently lose the ability
    // to detect an entire class of recurring production bug.
    for (const t of [
      'empty_catch',
      'console_log',
      'profile_bleed',
      'missing_db_await',
      'column_typo',
      'unstructured_500',
      'react_object_render',
      'dockerfile_drift',
      'profile_admin_sentinel',
    ]) {
      expect(AUTO_REPAIR_TYPES).toContain(t)
    }
  })

  it('exports runAutoRepair as an async function', () => {
    expect(typeof runAutoRepair).toBe('function')
  })

  it('reports Anya code-error repair policy on every run', async () => {
    const report = await runAutoRepair(null, { dryRun: true, repairTypes: ['column_typo'] })
    expect(report.writePolicy).toBe('code_error_repair')
    expect(report.permissionRequired).toBe(false)
    expect(report.auditRequired).toBe(true)
    // No per-test override: this walks the live source tree (~13s measured
    // standalone, 2026-08-20), so the old local 20s cap was TIGHTER than the
    // suite default and it timed out under full-suite contention. Inherit the
    // 45s global, whose reasoning is documented in vitest.config.js.
  })
})

describe('missing_db_await pattern (reproduces /api/profiles/:id/sections/:key/ai 500)', () => {
  it('flags chained .all() with no preceding await', () => {
    const fixture = `
      async function listDocs(req) {
        const docs = req.db.prepare('SELECT * FROM documents WHERE profile_id = ?').all(profileId)
        return docs
      }
    `
    const { issues } = scanMissingDbAwait(ROUTE_FILE, fixture)
    expect(issues.length).toBe(1)
  })

  it('flags chained .get() and .run() with no preceding await', () => {
    const fixture = `
      async function readAndWrite(req) {
        const row = req.db.prepare('SELECT 1').get()
        const result = req.db.prepare('UPDATE x SET y = 1').run()
        return { row, result }
      }
    `
    const { issues } = scanMissingDbAwait(ROUTE_FILE, fixture)
    expect(issues.length).toBe(2)
  })

  it('does NOT flag awaited chains', () => {
    const fixture = `
      async function listDocs(req) {
        const docs = await req.db.prepare('SELECT 1').all(profileId)
        return docs
      }
    `
    const { issues } = scanMissingDbAwait(ROUTE_FILE, fixture)
    expect(issues.length).toBe(0)
  })

  it('does NOT flag commented-out lines', () => {
    const fixture = `
      async function listDocs(req) {
        // const docs = req.db.prepare('SELECT 1').all(profileId)
        return []
      }
    `
    const { issues } = scanMissingDbAwait(ROUTE_FILE, fixture)
    expect(issues.length).toBe(0)
  })

  it('skips files with no async context (no false-positives in sync utilities)', () => {
    const fixture = `
      function buildSql() {
        return db.prepare('SELECT 1').all()
      }
    `
    const { issues } = scanMissingDbAwait(ROUTE_FILE, fixture)
    expect(issues.length).toBe(0)
  })

  it('apply path inserts await without disturbing the chain or surrounding code', () => {
    const fixture = `
      async function listDocs(req) {
        const docs = req.db.prepare('SELECT 1').all()
        return docs
      }
    `
    const { newContent, count } = applyMissingDbAwait(fixture)
    expect(count).toBe(1)
    expect(newContent).toMatch(/await\s+req\.db\.prepare\('SELECT 1'\)\.all\(\)/)
    // The non-call portion of the file must remain byte-identical apart
    // from the inserted `await ` token.
    expect(newContent.replace(/await\s+/, '')).toBe(fixture)
  })

  it('apply path is idempotent — running twice does not insert duplicate awaits', () => {
    const fixture = `
      async function listDocs(req) {
        const docs = req.db.prepare('SELECT 1').all()
        return docs
      }
    `
    const first = applyMissingDbAwait(fixture)
    const second = applyMissingDbAwait(first.newContent)
    expect(first.count).toBe(1)
    expect(second.count).toBe(0)
    expect(second.newContent).toBe(first.newContent)
  })
})

describe('column_typo pattern (reproduces GET /api/saved-grants 500)', () => {
  it('flags requires_matching_funds and reports the canonical column', () => {
    const fixture = `
      const sql = 'SELECT fo.requires_matching_funds FROM funding_opportunities fo'
    `
    const { issues } = scanColumnTypos(ROUTE_FILE, fixture)
    expect(issues.length).toBe(1)
    expect(issues[0].typo).toBe('requires_matching_funds')
    expect(issues[0].canonical).toBe('requires_match')
  })

  it('apply path rewrites the typo to the canonical column name only', () => {
    const fixture = `
      const sql = 'SELECT fo.requires_matching_funds FROM funding_opportunities fo'
    `
    const { newContent, count } = applyColumnTypos(fixture)
    expect(count).toBe(1)
    expect(newContent).toContain('requires_match')
    expect(newContent).not.toContain('requires_matching_funds')
  })

  it('apply path leaves unrelated identifiers alone', () => {
    const fixture = `
      const sql = 'SELECT fo.match_required FROM funding_opportunities fo'
    `
    const { newContent, count } = applyColumnTypos(fixture)
    expect(count).toBe(0)
    expect(newContent).toBe(fixture)
  })
})

describe('unstructured_500 pattern (replaces console.error before res.status(500))', () => {
  it('flags console.error preceding res.status(500) in route files', () => {
    const fixture = `
      import { createLogger } from '../utils/logger.js'
      const routeLogger = createLogger('route:demo')
      router.get('/', async (req, res) => {
        try {
          throw new Error('boom')
        } catch (err) {
          console.error('[demo] GET error:', err)
          res.status(500).json({ error: err.message })
        }
      })
    `
    const { issues, canAutoFix } = scanUnstructured500(ROUTE_FILE, fixture)
    expect(issues.length).toBe(1)
    expect(canAutoFix).toBe(true)
  })

  it('does NOT flag the same pattern outside backend/routes/', () => {
    const fixture = `
      import { createLogger } from '../utils/logger.js'
      const routeLogger = createLogger('service:demo')
      function notARoute() {
        console.error('failed')
        res.status(500)
      }
    `
    const { issues } = scanUnstructured500(SERVICE_FILE, fixture)
    expect(issues.length).toBe(0)
  })

  it('flags but does NOT auto-fix when no routeLogger is in scope', () => {
    const fixture = `
      router.get('/', async (req, res) => {
        try {
          throw new Error('boom')
        } catch (err) {
          console.error('[demo] GET error:', err)
          res.status(500).json({ error: err.message })
        }
      })
    `
    const { issues, canAutoFix } = scanUnstructured500(ROUTE_FILE, fixture)
    expect(issues.length).toBe(1)
    expect(canAutoFix).toBe(false)
    const { newContent, count } = applyUnstructured500(ROUTE_FILE, fixture)
    expect(count).toBe(0)
    expect(newContent).toBe(fixture)
  })

  it('apply path rewrites console.error to routeLogger.error when logger is in scope', () => {
    const fixture = `
      import { createLogger } from '../utils/logger.js'
      const routeLogger = createLogger('route:demo')
      router.get('/', async (req, res) => {
        try {
          throw new Error('boom')
        } catch (err) {
          console.error('[demo] GET error:', err)
          res.status(500).json({ error: err.message })
        }
      })
    `
    const { newContent, count } = applyUnstructured500(ROUTE_FILE, fixture)
    expect(count).toBe(1)
    expect(newContent).toMatch(/routeLogger\.error\(/)
  })
})

describe('react_object_render pattern (reproduces React error #31)', () => {
  it('flags reasons.map((reason) => <Badge>{reason}</Badge>) without coercion', () => {
    const fixture = `
      export default function Card({ opp }) {
        return (
          <div>
            {opp.match_reasons.map((reason, i) => (
              <Badge key={i}>{reason}</Badge>
            ))}
          </div>
        )
      }
    `
    const { issues } = scanReasonObjectRender(COMPONENT_FILE, fixture)
    expect(issues.length).toBeGreaterThan(0)
  })

  it('flags matched_needs.map((need) => <span>{need}</span>) — the GrantDetail crash site', () => {
    const fixture = `
      export default function GrantOverview({ grant }) {
        return (
          <div>
            {grant.matched_needs.map((need, i) => (
              <span key={i}>{need}</span>
            ))}
          </div>
        )
      }
    `
    const { issues } = scanReasonObjectRender(COMPONENT_FILE, fixture)
    expect(issues.length).toBeGreaterThan(0)
  })

  it('does NOT flag files that already use formatReasonText', () => {
    const fixture = `
      import { formatReasonText } from '@/utils/reasonText'
      export default function Card({ opp }) {
        return opp.match_reasons.map((reason, i) => (
          <Badge key={i}>{formatReasonText(reason)}</Badge>
        ))
      }
    `
    const { issues } = scanReasonObjectRender(COMPONENT_FILE, fixture)
    expect(issues.length).toBe(0)
  })

  it('does NOT flag .js / .ts non-component files', () => {
    const fixture = `
      const reasons = ['a', 'b']
      reasons.map((reason, i) => console.log(reason))
    `
    const { issues } = scanReasonObjectRender(SERVICE_FILE, fixture)
    expect(issues.length).toBe(0)
  })
})

describe('profile_admin_sentinel pattern (reproduces /api/profiles/__admin__ 404)', () => {
  const FRONTEND_FILE = 'src/pages/SomePage.jsx'
  const API_FILE = 'src/api/profiles.js'

  it('flags template-literal /api/profiles/${id} fetches that skip the boundary guard', () => {
    const fixture = `
      import { apiFetch } from '@/api/client'
      export async function loadProfile(id) {
        return apiFetch(\`/api/profiles/\${id}\`)
      }
    `
    const { issues } = scanProfileAdminSentinel(FRONTEND_FILE, fixture)
    expect(issues.length).toBeGreaterThan(0)
  })

  it('does NOT flag files that import the boundary guard', () => {
    const fixture = `
      import { apiFetch } from '@/api/client'
      import { assertRealProfileId } from '@/api/profileIdGuards'
      export async function loadProfile(id) {
        assertRealProfileId(id, 'loadProfile')
        return apiFetch(\`/api/profiles/\${id}\`)
      }
    `
    const { issues } = scanProfileAdminSentinel(FRONTEND_FILE, fixture)
    expect(issues.length).toBe(0)
  })

  it('does NOT flag the boundary helper itself (src/api/profiles.js)', () => {
    const fixture = `
      export async function getProfile(id) {
        return apiFetch(\`/api/profiles/\${id}\`)
      }
    `
    const { issues } = scanProfileAdminSentinel(API_FILE, fixture)
    expect(issues.length).toBe(0)
  })

  it('does NOT flag backend files (only src/** is in scope)', () => {
    const fixture = `
      const url = \`/api/profiles/\${id}\`
    `
    const { issues } = scanProfileAdminSentinel('backend/services/example.js', fixture)
    expect(issues.length).toBe(0)
  })

  it('does NOT flag mentions inside JSDoc / comments', () => {
    const fixture = `
      // Documentation: GET /api/profiles/\${id} returns the profile row.
      /* Another mention: /api/profiles/\${id} */
      export const x = 1
    `
    const { issues } = scanProfileAdminSentinel(FRONTEND_FILE, fixture)
    expect(issues.length).toBe(0)
  })
})
