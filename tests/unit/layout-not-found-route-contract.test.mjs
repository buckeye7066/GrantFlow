import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Production 2026-09-11: Pricing "Get Started" navigated to /CreateProfile, which
// is not a route. LayoutRoutes had no catch-all, so the signed-in app rendered
// its chrome around an EMPTY page with no explanation (live: breadcrumb
// "Home > CreateProfile", blank main area, no error). Every unknown in-app path
// must render a not-found page instead.
const read = (relative) => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

test('the signed-in layout router has a not-found catch-all route', () => {
  const router = read('src/pages/index.jsx')
  const start = router.indexOf('function LayoutRoutes')
  const end = router.indexOf('export default function Pages')
  assert.ok(start >= 0 && end > start, 'LayoutRoutes not found in src/pages/index.jsx')
  const layout = router.slice(start, end)
  assert.match(layout, /<Route\s+path="\*"\s+element=\{[^}]*NotFound/, 'LayoutRoutes has no path="*" route rendering NotFound')
  assert.ok(fs.existsSync(new URL('../../src/pages/NotFound.jsx', import.meta.url)), 'src/pages/NotFound.jsx is missing')
})
