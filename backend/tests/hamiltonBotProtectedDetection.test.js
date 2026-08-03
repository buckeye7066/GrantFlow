/**
 * Full-page bot-protection detection (owner 2026-08-03: "for the dead-ends,
 * make sure the user and admin are aware").
 *
 * scholarships.com serves a FULL-PAGE Cloudflare "managed challenge"
 * interstitial that REPLACES the application before it loads. It used to
 * collapse into a generic `login` blocker that told the owner nothing. These
 * guards pin:
 *   - the verbatim Cloudflare interstitial body → a DISTINCT `bot_protected`
 *     gate, never `login`
 *   - a normal application page is NOT misclassified
 *   - a page that merely mentions a vendor in its footer (real content) is NOT
 *     a bot-wall (the low-content corroboration guard)
 *   - an embedded captcha WIDGET on a real page still classifies as `captcha`
 *   - classifyBlocker maps `bot_protected` → `portal_anti_bot_block`
 *   - the owner+admin notice points at SIDE-BY-SIDE co-browse, honestly
 */
import { describe, it, expect } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const { _internal } = await import('../services/hamilton/hamiltonAutopilotEngine.js')
const { classifyBlocker } = await import('../services/hamilton/hamiltonBlockerClassifier.js')
const {
  botProtectedNotice,
  buildCobrowseLink,
  BOT_PROTECTED_NOTIFICATION_TYPE,
} = await import('../services/hamilton/hamiltonBotProtectedNotice.js')
const { HAMILTON_NOTIFICATION_TYPES } = await import('../services/hamilton/hamiltonNotifications.js')

const detectGate = _internal.detectGate

// The verbatim scholarships.com Cloudflare "managed challenge" interstitial —
// the whole page IS this, with no application content behind it.
const CLOUDFLARE_INTERSTITIAL = [
  'scholarships.com',
  'Verifying you are human. This may take a few seconds.',
  'scholarships.com needs to review the security of your connection before proceeding.',
  'Performing security verification…',
  'This website uses a security service to protect against malicious bots.',
  'Ray ID: 8f2a1b3c4d5e6f70',
  'Performance & security by Cloudflare',
].join('\n')

// A real, long scholarship application page (no bot-protection signals).
const REAL_APP_PAGE = [
  'Apply for the Future Leaders Scholarship',
  'First name', 'Last name', 'Email address', 'Home address', 'City', 'State', 'ZIP',
  'Tell us about your academic goals in 500 words or fewer.',
  'Upload your transcript.', 'Submit application',
  'Your information is protected with industry-standard security.',
].join('\n').padEnd(2500, ' ')

// A REAL app page that happens to mention Cloudflare in its footer — brand
// signal present, but the page is full of application content, NOT a bot-wall.
const REAL_PAGE_WITH_CF_FOOTER = (REAL_APP_PAGE + '\nProtected by Cloudflare.').padEnd(3000, ' ')

function fakePage({ title = '', body = '', url = 'https://www.scholarships.com/apply', selectorMatches = [] } = {}) {
  return {
    url: () => url,
    title: async () => title,
    $eval: async (_sel, fn) => fn({ innerText: body, textContent: body }),
    $: async (selector) => (selectorMatches.some((m) => selector.includes(m)) ? {} : null),
  }
}

describe('detectBotWall / detectGate — full-page interstitial', () => {
  it('classifies the verbatim scholarships.com Cloudflare interstitial as bot_protected, NOT login', async () => {
    const gate = await detectGate(fakePage({ body: CLOUDFLARE_INTERSTITIAL }))
    expect(gate?.kind).toBe('bot_protected')
    expect(gate.kind).not.toBe('login')
    expect(gate.detail).toMatch(/bot-protection|cloudflare/i)
  })

  it('classifies a short Akamai/DataDome brand interstitial as bot_protected', async () => {
    const body = 'Access to this page has been blocked. powered by DataDome. Reference #18.abc'
    const gate = await detectGate(fakePage({ body, url: 'https://portal.example.org/apply' }))
    expect(gate?.kind).toBe('bot_protected')
  })

  it('does NOT misclassify a normal application page', async () => {
    const gate = await detectGate(fakePage({ body: REAL_APP_PAGE }))
    // No password field, no bot-wall → no gate at all.
    expect(gate).toBeNull()
  })

  it('does NOT treat a real page that merely mentions Cloudflare in its footer as a bot-wall', async () => {
    const gate = await detectGate(fakePage({ body: REAL_PAGE_WITH_CF_FOOTER }))
    expect(gate?.kind).not.toBe('bot_protected')
  })

  it('still classifies an EMBEDDED captcha widget on a real page as captcha (regression)', async () => {
    const gate = await detectGate(fakePage({ body: REAL_APP_PAGE, selectorMatches: ['cf-turnstile'] }))
    expect(gate?.kind).toBe('captcha')
  })
})

describe('classifyBlocker — bot_protected engine kind', () => {
  it('maps bot_protected → portal_anti_bot_block', () => {
    expect(classifyBlocker({ kind: 'bot_protected' }).category).toBe('portal_anti_bot_block')
  })
})

describe('botProtectedNotice — owner + admin awareness with side-by-side CTA', () => {
  it('builds an honest bot-protection notice pointing at side-by-side co-browse', () => {
    const n = botProtectedNotice({ profileId: 'p1', host: 'https://www.scholarships.com/apply', fundingTitle: 'Future Leaders' })
    expect(n.type).toBe(BOT_PROTECTED_NOTIFICATION_TYPE)
    expect(n.title).toMatch(/blocks automated submission/i)
    expect(n.message).toMatch(/bot protection|cloudflare|anti-bot/i)
    expect(n.message).toMatch(/side-by-side/i)
    // Honest: this is NOT a "saved login could not be completed" message.
    expect(n.message).not.toMatch(/saved login could not be completed/i)
    expect(n.data.blocker_kind).toBe('bot_protected')
    expect(n.data.cobrowse_host).toBe('www.scholarships.com')
    expect(n.data.cobrowse_reason).toBe('bot_protected')
    expect(n.data.side_by_side_link).toContain('cobrowse=www.scholarships.com')
    expect(n.data.side_by_side_link).toContain('cobrowse_reason=bot_protected')
  })

  it('registers hamilton_bot_protected in the notification allowlist (else emit throws + drops)', () => {
    // emitHamiltonNotification throws on any type not in this frozen list, so an
    // unregistered type would silently fail the owner+admin alert at runtime.
    expect(HAMILTON_NOTIFICATION_TYPES).toContain(BOT_PROTECTED_NOTIFICATION_TYPE)
  })

  it('buildCobrowseLink deep-links to the profile Portals tab with the co-browse card flagged', () => {
    const link = buildCobrowseLink({ profileId: 'p1', host: 'scholarships.com' })
    expect(link).toContain('/ProfileDetail?')
    expect(link).toContain('id=p1')
    expect(link).toContain('tab=pipeline')
    expect(link).toContain('cobrowse=scholarships.com')
    expect(link).toContain('cobrowse_reason=bot_protected')
  })
})
