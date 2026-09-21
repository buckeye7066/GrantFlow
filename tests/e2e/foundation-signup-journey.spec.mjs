import { test, expect } from 'playwright/test'
import { basePath } from './playwright.config.mjs'

const appBase = String(basePath || '').replace(/\/+$/, '')
const endpoint = (response, path) => new URL(response.url()).pathname === `${appBase}${path}`

test('Foundation signup saves answers, resumes, signs in and retains the new profile', async ({ page, browser }) => {
  test.setTimeout(120_000)
  const email = `foundation-journey-${Date.now()}@example.invalid`
  const profileName = 'Foundation Journey Tester'
  const password = 'Foundation-Journey-2026!'
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  async function clickAnswer(name, expectedQuestionId) {
    const responsePromise = page.waitForResponse((response) =>
      endpoint(response, '/api/onboarding/answer') && response.request().method() === 'POST')
    await page.getByRole('button', { name, exact: true }).click()
    const response = await responsePromise
    expect(response.status(), `Answer accepted before ${expectedQuestionId}`).toBe(200)
    const result = await response.json()
    expect(result.question?.id).toBe(expectedQuestionId)
    console.log(`Foundation journey: reached ${expectedQuestionId}`)
    return result
  }

  await page.goto(`${appBase}/start`, { waitUntil: 'domcontentloaded' })
  const intro = page.getByRole('dialog').filter({ hasText: 'Welcome to GrantFlow!' })
  await expect(intro).toBeVisible()
  await intro.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await clickAnswer('English', 'intro')
  await clickAnswer("Let's do it", 'who')
  await clickAnswer('Myself or my family', 'location')
  await page.locator('#zip').fill('37312')
  await expect(page.locator('#city')).toHaveValue('Cleveland')
  await expect(page.locator('#county')).toHaveValue('Bradley')
  await clickAnswer('Continue', 'personal_subtype')

  const resumedResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith(`${appBase}/api/onboarding/sessions/`))
  await page.reload({ waitUntil: 'domcontentloaded' })
  const resumed = await resumedResponse
  expect(resumed.status()).toBe(200)
  expect((await resumed.json()).question.id).toBe('personal_subtype')
  await clickAnswer('Just me (single adult)', 'needs_personal')
  await page.getByRole('button', { name: 'Utility bills (electric, gas, water, internet)', exact: true }).click()
  await clickAnswer('Continue', 'situations')
  await clickAnswer('Continue', 'narrative')
  await page.locator('textarea').fill('I need help with household utility bills in Bradley County.')
  await clickAnswer('Continue', 'name')
  await page.getByPlaceholder("e.g. 'Jordan Smith' or 'Hope Community Church'").fill(profileName)
  await clickAnswer('Continue', 'email')
  await page.locator('input[type="email"]').fill(email)

  const completedResponse = page.waitForResponse((response) =>
    endpoint(response, '/api/onboarding/complete') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Send my sign-in code', exact: true }).click()
  const completed = await completedResponse
  const completion = await completed.json()
  expect(completed.status(), JSON.stringify({ error: completion.error, detail: completion.detail })).toBe(201)
  expect(completion.profile_id).toBeTruthy()
  expect(completion.email).toBe(email)
  // Isolated development token handoff does not prove production SMTP delivery.
  await expect(page).toHaveURL(/\/set-password\?token=/)
  await page.locator('#new-password').fill(password)
  await page.locator('#confirm-password').fill(password)
  const setupResponse = page.waitForResponse((response) =>
    endpoint(response, '/api/auth/password/setup/complete') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Set password & sign in', exact: true }).click()
  const setup = await setupResponse
  expect(setup.status()).toBe(200)
  const setupUser = (await setup.json()).user
  expect(setupUser.is_admin).toBe(false)
  expect(setupUser.has_completed_onboarding).toBe(true)
  expect(setupUser.profile_completion.next.effective_type).toBe('individual')
  expect(setupUser.profile_completion.next.questions.map((question) => question.id)).toEqual(['financial_need'])
  await expect(page).toHaveURL(/\/Dashboard(?:\?|$)/)
  console.log('Foundation journey: account creation retained personal type and completed onboarding')

  // Fresh context: no reused session, administrator bypass, or pre-created account.
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL })
  try {
    const returning = await context.newPage()
    returning.on('pageerror', (error) => errors.push(error.message))
    await returning.goto(`${appBase}/login`)
    await returning.getByRole('textbox', { name: 'Profile email', exact: true }).fill(email)
    await returning.getByRole('button', { name: 'Continue with Email', exact: true }).click()
    await returning.getByRole('textbox', { name: 'Password', exact: true }).fill(password)
    await returning.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(returning).toHaveURL(/\/Dashboard(?:\?|$)/)

    // Answer the blocking question on the login destination, before navigation.
    const gate = returning.getByTestId('profile-completion-gate')
    await expect(gate).toBeVisible()
    await expect(gate.getByText(/What kind of organization/)).toHaveCount(0)
    await gate.getByRole('textbox', { name: /Roughly how urgent is your financial need/ }).fill('high')
    const answerResponse = returning.waitForResponse((response) =>
      endpoint(response, `/api/profiles/${completion.profile_id}/completion-gate/answer`) && response.request().method() === 'POST')
    await gate.getByRole('button', { name: 'Finish', exact: true }).click()
    const answer = await answerResponse
    expect(answer.status()).toBe(200)
    expect((await answer.json()).complete).toBe(true)
    await expect(gate).toBeHidden()

    // Materialize the response body as it arrives, rather than retaining a
    // network handle across a full-page navigation.
    const profileResponse = returning.waitForResponse((response) =>
      endpoint(response, `/api/profiles/${completion.profile_id}`) && response.request().method() === 'GET')
      .then(async (response) => ({ status: response.status(), body: await response.json() }))
    await returning.goto(`${appBase}/ProfileDetail?id=${encodeURIComponent(completion.profile_id)}`)
    const profileHttp = await profileResponse
    expect(profileHttp.status).toBe(200)
    const profile = profileHttp.body
    expect(profile.primary_type).toBe('individual')
    expect(profile.billing.tier_id).toBe('foundation')
    const sections = Object.fromEntries(profile.sections.map((section) => [section.section_key, section.data]))
    expect(sections.basic_information).toMatchObject({ full_name: profileName, profile_type: 'individual', city: 'Cleveland', county: 'Bradley', state: 'TN', zip_code: '37312' })
    expect(sections.financial_information.assistance_needs).toEqual(['utilities'])
    await expect(returning.getByRole('heading', { name: profileName, exact: true }).first()).toBeVisible()
    await expect(returning.getByRole('link', { name: 'Admin Panel', exact: true })).toHaveCount(0)
    await returning.reload({ waitUntil: 'domcontentloaded' })
    await expect(returning.getByRole('heading', { name: profileName, exact: true }).first()).toBeVisible()
    await expect(returning.getByTestId('profile-completion-gate')).toHaveCount(0)
    console.log('Foundation journey: independent login, required answer and saved profile survived reload')

    // One real non-admin login may own both personal and business identities.
    // Exercise the shared selector and persisted active scope, not a mocked UI.
    const refreshed = await context.request.post(`${appBase}/api/auth/refresh`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' }, data: {},
    })
    expect(refreshed.status()).toBe(200)
    const session = await refreshed.json()
    const headers = { Authorization: `Bearer ${session.accessToken}` }
    const created = await context.request.post(`${appBase}/api/profiles`, {
      headers, data: { display_name: 'Journey Business', primary_type: 'business' },
    })
    expect(created.status()).toBe(201)
    const business = await created.json()
    expect(business.id).not.toBe(completion.profile_id)
    const personalRead = await context.request.get(`${appBase}/api/profiles/${completion.profile_id}`, { headers })
    expect((await personalRead.json()).display_name).toBe(profileName)
    await returning.reload({ waitUntil: 'domcontentloaded' })
    // A second profile must answer its own type-specific required questions.
    // Do not skip the gate or reuse the individual's household answers.
    const businessGate = returning.getByTestId('profile-completion-gate')
    const businessAnswers = [
      [/Which US state/, 'Tennessee'],
      [/What kind of organization/, 'business'],
      [/organization.*mission or main focus/, 'Provide local wellness services.'],
      [/main program focus areas/, 'Wellness services and accessible community classes'],
    ]
    for (const [prompt, value] of businessAnswers) {
      await businessGate.getByRole('textbox', { name: prompt }).fill(value)
      const saved = returning.waitForResponse(response =>
        endpoint(response, `/api/profiles/${business.id}/completion-gate/answer`) && response.request().method() === 'POST')
      await businessGate.getByRole('button', { name: /^(Continue|Finish)$/ }).click()
      expect((await saved).status()).toBe(200)
    }
    await expect(businessGate).toBeHidden()
    const selector = returning.getByRole('combobox', { name: 'Active funding profile', exact: true })
    await expect(selector).toBeVisible()
    await selector.selectOption(business.id)
    await expect(returning).toHaveURL(new RegExp(`ProfileDetail\\?id=${business.id}`))
    await expect.poll(() => returning.evaluate(() => localStorage.getItem('grantflow:active-profile-id'))).toBe(business.id)
    await selector.selectOption(completion.profile_id)
    await expect(returning).toHaveURL(new RegExp(`ProfileDetail\\?id=${completion.profile_id}`))
    await returning.reload({ waitUntil: 'domcontentloaded' })
    await expect(selector).toHaveValue(completion.profile_id)
    await expect(returning.getByRole('heading', { name: profileName, exact: true }).first()).toBeVisible()
    console.log('Foundation journey: personal/business switch preserved separate profiles and survived reload')
  } finally {
    await context.close()
  }
  expect(errors).toEqual([])
})
