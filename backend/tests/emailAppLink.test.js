import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))
vi.mock('resend', () => ({ Resend: class { constructor() { this.emails = { send: sendMock } } } }))
const canonical = 'https://app.axiombiolabs.org/login'
let email
beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('GRANTFLOW_SIGNIN_URL', '')
  vi.stubEnv('RESEND_API_KEY', 'fixture-only')
  vi.stubEnv('FROM_EMAIL', 'sender@example.com')
  sendMock.mockReset().mockResolvedValue({ data: { id: 'fixture' }, error: null })
  email = await import('../services/email.js')
})
afterEach(() => vi.unstubAllEnvs())

describe('email links reach the application, not the marketing router', () => {
  it('defaults HTML and text footers to the verified application login', () => {
    expect(email.grantFlowLinkFooterHtml()).toContain(`href="${canonical}"`)
    expect(email.grantFlowLinkFooterText()).toContain(canonical)
  })
  it.each(['   ', 'https://www.axiombiolabs.org/grantflow',
    'https://axiombiolabs.org/grantflow/', 'https://www.axiombiolabs.org/grantflow/login'])('repairs blank or retired sign-in configuration: %s', (value) => {
    vi.stubEnv('GRANTFLOW_SIGNIN_URL', value)
    expect(email.grantFlowLinkFooterText()).toContain(canonical)
  })
  it('honors a deployment override and escapes only the HTML representation', () => {
    const custom = 'https://preview.example.com/grantflow/login?one=1&two=2'
    vi.stubEnv('GRANTFLOW_SIGNIN_URL', custom)
    expect(email.grantFlowLinkFooterText()).toContain(custom)
    expect(email.grantFlowLinkFooterHtml()).toContain(custom.replace('&', '&amp;'))
  })
  it('uses the same destination in verification emails and their footer', async () => {
    expect(await email.sendVerificationEmail('recipient@example.com', '123456')).toBe(true)
    const payload = sendMock.mock.calls[0][0]
    expect(payload.html).toContain(`href="${canonical}"`)
    expect(payload.html).not.toContain('www.axiombiolabs.org/grantflow')
  })
  it('preserves complete HTML documents when adding the corrected link', () => {
    const html = email.appendGrantFlowLinkFooter('<html><body>Report</body></html>')
    expect(html).toMatch(new RegExp('Open GrantFlow[\\s\\S]*</body></html>$'))
    expect(html).toContain(canonical)
  })
})
