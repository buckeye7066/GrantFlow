/**
 * The end-user sidebar carries the full non-admin tool set (owner order
 * 2026-09-07, from three screenshots of the admin sidebar: Find Funding, its
 * advanced tools, and Work — "keeping nonadmin tools only").
 */
import { describe, expect, it } from 'vitest'
import { END_USER_NAV_GROUPS, END_USER_ROUTE_NAMES } from './endUserNavConfig.js'
import { NAV_GROUPS } from './navConfig.js'
import { pickDashboardNextAction, HIDDEN_END_USER_ROUTES } from '../lib/dashboardNextAction.js'

const group = (id) => END_USER_NAV_GROUPS.find((g) => g.groupId === id)
const routes = (id) => group(id).items.map((i) => i.routeName)

describe('end-user sidebar parity with the owner screenshots', () => {
  it('Find Funding lists the screenshot items in order, then the advanced tools', () => {
    expect(routes('find')).toEqual([
      'DiscoverGrants', 'GreenHomePrograms', 'SavedGrants', 'FundingResults', 'SmartMatcher', 'ProfileMatcher', 'FundingOpportunities',
      'ItemFunding',
      'Funder', 'DataSources', 'SourceDirectory', 'NOFOParser', 'AIGrantScorer',
    ])
  })
  it('Work lists Pipeline through Printable Application', () => {
    expect(routes('work')).toEqual(['Pipeline', 'HamiltonProcessing', 'Applications', 'Proposals', 'Documents', 'PrintableApplication'])
  })
  it('keeps only non-admin tools: nothing flagged admin-only, no Admin / Operations group', () => {
    const all = END_USER_NAV_GROUPS.flatMap((g) => g.items)
    expect(all.some((i) => i.isAdminOnly)).toBe(false)
    expect(group('admin')).toBeUndefined()
    const adminOnly = NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.isAdminOnly).map((i) => i.routeName)
    for (const r of adminOnly) expect(END_USER_ROUTE_NAMES).not.toContain(r)
  })
  it('tier-dependent tools declare the capability they need, with the hook\'s own names', () => {
    const byRoute = Object.fromEntries(END_USER_NAV_GROUPS.flatMap((g) => g.items).map((i) => [i.routeName, i]))
    expect(byRoute.HamiltonProcessing.requiresCapability).toBe('pipelineAutomation')
    expect(byRoute.NOFOParser.requiresCapability).toBe('documentAI')
    expect(byRoute.AIGrantScorer.requiresCapability).toBe('documentAI')
    expect(byRoute.ItemFunding.requiresCapability).toBe('itemFunding')
    expect(byRoute.DiscoverGrants.requiresCapability).toBeUndefined()
  })
  it('group ids line up with the admin sidebar so breadcrumbs and open-state resolve the same way', () => {
    for (const id of ['home', 'find', 'work']) expect(NAV_GROUPS.some((g) => g.groupId === id)).toBe(true)
  })
  it('the dashboard may now send an end user to Discover and Saved; Automation and the profile list stay hidden', () => {
    expect(HIDDEN_END_USER_ROUTES).toEqual(['Automation', 'MyProfiles'])
    expect(pickDashboardNextAction({ completionPct: 80, savedCount: 0, activeCount: 0, isSimplified: true })).toMatchObject({ route: 'DiscoverGrants' })
    expect(pickDashboardNextAction({ completionPct: 80, savedCount: 2, activeCount: 0, isSimplified: true })).toMatchObject({ route: 'SavedGrants' })
    for (const hidden of HIDDEN_END_USER_ROUTES) expect(END_USER_ROUTE_NAMES).not.toContain(hidden)
  })
})
