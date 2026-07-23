import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HIDDEN_END_USER_ROUTES,
  pickDashboardNextAction,
} from '../../src/lib/dashboardNextAction.js'

const scenarios = [
  { completionPct: 10, savedCount: 0, activeCount: 0, urgentCount: 0 },
  { completionPct: 80, savedCount: 0, activeCount: 0, urgentCount: 0 },
  { completionPct: 80, savedCount: 0, activeCount: 2, urgentCount: 3 },
  { completionPct: 80, savedCount: 4, activeCount: 0, urgentCount: 0 },
]

test('the simplified (end-user) Dashboard never routes to a hidden surface', () => {
  for (const scenario of scenarios) {
    const action = pickDashboardNextAction({ ...scenario, isSimplified: true })
    if (!action) continue
    assert.ok(
      !HIDDEN_END_USER_ROUTES.includes(action.route),
      `end-user CTA "${action.label}" must not route to hidden page ${action.route}`,
    )
  }
})

test('every simplified end-user CTA lands on a visible page', () => {
  const allowed = new Set(['Help', 'Pipeline', 'Calendar', 'Dashboard', 'ItemFunding'])
  for (const scenario of scenarios) {
    const action = pickDashboardNextAction({ ...scenario, isSimplified: true })
    if (!action) continue
    assert.ok(
      allowed.has(action.route),
      `end-user CTA route ${action.route} is not in the end-user nav`,
    )
  }
})

test('the admin Dashboard keeps its full-workspace call-to-actions', () => {
  const discover = pickDashboardNextAction({ completionPct: 80, savedCount: 0, activeCount: 0, isSimplified: false })
  assert.equal(discover.route, 'DiscoverGrants')

  const profile = pickDashboardNextAction({ completionPct: 10, isSimplified: false })
  assert.equal(profile.route, 'MyProfiles')

  const saved = pickDashboardNextAction({ completionPct: 80, savedCount: 4, activeCount: 0, isSimplified: false })
  assert.equal(saved.route, 'SavedGrants')
})

test('deadlines take priority and route to the Pipeline for everyone', () => {
  for (const isSimplified of [true, false]) {
    const action = pickDashboardNextAction({
      completionPct: 90,
      savedCount: 1,
      activeCount: 1,
      urgentCount: 2,
      isSimplified,
    })
    assert.equal(action.route, 'Pipeline')
    assert.match(action.label, /2 deadlines/)
  }
})
