import { test, expect } from 'playwright/test'

async function login(page) {
  await page.addInitScript(() => { globalThis.__GF_SMOKE__ = true })
  await page.goto('/login')
  await page.getByRole('textbox', { name: 'Profile email', exact: true }).fill('user1@grantflow.local')
  await page.getByRole('button', { name: 'Continue with Email', exact: true }).click()
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('UxFixture-Only-2026!')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/login/)
  await expect(page).not.toHaveURL(/PricingRequired/)
  await page.waitForLoadState('networkidle')
  const welcome = page.getByRole('button', { name: 'Continue to GrantFlow', exact: true })
  if (await welcome.isVisible()) {
    await Promise.all([page.waitForResponse((response) => response.url().includes('/api/preferences') && response.request().method() === 'PUT'), welcome.click()])
  }
}
test('the five workflow steps stay visible and specialist tools remain reachable', async ({ page }) => {
  await login(page)
  await page.goto('/Dashboard')
  const guide = page.getByRole('complementary', { name: 'Page guide', exact: true })
  const journey = guide.getByRole('navigation')
  await expect(journey.getByRole('link')).toHaveCount(5)
  for (const link of await journey.getByRole('link').all()) await expect(link).toBeVisible()
  await expect(page.getByRole('link', { name: 'Smart Matcher', exact: true })).not.toBeVisible()
  await page.getByRole('button', { name: 'More funding tools', exact: true }).click()
  await page.getByRole('link', { name: 'Smart Matcher', exact: true }).click()
  await expect(page).toHaveURL(/SmartMatcher/)
  await page.reload()
  await expect(page.getByRole('link', { name: 'Smart Matcher', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Smart Matcher', exact: true })).toHaveAttribute('aria-current', 'page')
})

test('unavailable job progress is shown as a search failure, never a completed empty scan', async ({ page }) => {
  await login(page)
  await page.route('**/api/real-crawlers/discover-all', async (route) => {
    const profileId = route.request().postDataJSON().profile_id
    await route.fulfill({ status: 202, json: { success: true, profile_id: profileId, synchronous: false, jobs_enqueued: 1, job_ids: ['fixture-job'] } })
  })
  await page.route('**/api/crawlers/jobs/fixture-job', (route) => route.fulfill({ status: 503, json: { error: 'Search progress temporarily unavailable' } }))
  await page.goto('/DiscoverGrants')
  await page.getByRole('button', { name: 'Find Funding Opportunities', exact: true }).click()
  await expect(page.getByText('Search failed', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Find Funding Opportunities', exact: true })).toBeEnabled()
  await expect(page.getByText('Searched funding sources matched to your profile', { exact: true })).toHaveCount(0)
})

test('completed discovery keeps a failed catalog refresh visible as an error', async ({ page }) => {
  await login(page)
  let profileId
  await page.route('**/api/real-crawlers/discover-all', async (route) => {
    profileId = route.request().postDataJSON().profile_id
    await route.fulfill({ status: 202, json: { success: true, profile_id: profileId, synchronous: false, jobs_enqueued: 1, job_ids: ['fixture-job'] } })
  })
  await page.route('**/api/crawlers/jobs/fixture-job', (route) => route.fulfill({ json: { id: 'fixture-job', profile_id: profileId, status: 'completed', result_meta: {} } }))
  await page.goto('/DiscoverGrants')
  await page.route('**/api/matching/profile/*/opportunities?*', (route) => route.fulfill({ status: 503, json: { error: 'Matches temporarily unavailable' } }))
  await page.getByRole('button', { name: 'Find Funding Opportunities', exact: true }).click()
  await expect(page.getByText('Search failed', { exact: true }).first()).toBeVisible()
})
