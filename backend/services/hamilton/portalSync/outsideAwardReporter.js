/**
 * outsideAwardReporter.js — the GLOBAL write path: report the household's
 * accepted funding sources to ANY portal that has a form for them.
 *
 * OWNER RULE (2026-08-01): the two-way sync must be global for all portals, not
 * just the ones with a hand-written connector. Before this, `generic.write()`
 * was a NO-OP that returned "there is no structured data connector for this
 * portal yet" — so every portal except MTSU pushed nothing, forever.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT FILLS. IT DOES NOT SUBMIT.
 * ───────────────────────────────────────────────────────────────────────────
 * Submitting a form on a student's real financial-aid account is an
 * outward-facing, hard-to-reverse act with consequences the agent cannot see —
 * a mis-reported outside scholarship can trigger a revised aid package or a
 * repayment demand. So this stages the values and STOPS, reporting exactly what
 * it filled. Submission stays where it already lives: the authorized autopilot
 * path, behind explicit household authorization. `allowSubmit` exists so that
 * path can pass it, and defaults to FALSE for every ordinary sync.
 *
 * Selector strategy: role/label/placeholder locators only — never a guessed CSS
 * path. If the form is not found we SKIP with a reason. A portal that has no
 * reporting form is a fact about the portal, not a failure to hide.
 */

import { createLogger } from '../../../utils/logger.js'

const log = createLogger('service:outsideAwardReporter')

const FIND_TIMEOUT_MS = 4000

// How a real portal names the place you report outside money. Broad on purpose
// (link text varies wildly by vendor); a false positive costs a skip, not a
// wrong write, because every field is located by label before anything is typed.
const REPORT_LINK_RE = /outside (scholarship|award|aid|resource)|additional (funding|resources?|scholarship)|report (a )?(scholarship|award|outside)|external scholarship|private scholarship/i

const NAME_FIELD_RE = /scholarship name|award name|source name|organization|provider|donor|name of (the )?(scholarship|award|source)/i
const AMOUNT_FIELD_RE = /amount|award amount|value|dollars|\$/i

async function visible(locator) {
  try { return await locator.isVisible({ timeout: FIND_TIMEOUT_MS }) } catch { return false }
}

/**
 * Try to reach a portal's outside-scholarship reporting form from wherever the
 * authenticated page currently is. Returns true only if we believe we are on a
 * form — proven by an actual name-ish input being visible, never by the click
 * alone (a click that navigates nowhere used to read as success).
 */
async function reachReportingForm(page, log_) {
  // Already on something form-shaped?
  try {
    if (await visible(page.getByLabel(NAME_FIELD_RE).first())) return true
  } catch { /* keep looking */ }

  try {
    const link = page.getByRole('link', { name: REPORT_LINK_RE }).first()
    if (await visible(link)) {
      await link.click({ timeout: FIND_TIMEOUT_MS }).catch(() => {})
      await page.waitForLoadState?.('domcontentloaded', { timeout: 10000 }).catch(() => {})
      // PROVE it: the form must actually be there now.
      if (await visible(page.getByLabel(NAME_FIELD_RE).first())) return true
      log_?.('reporting link clicked but no name field appeared')
    }
  } catch { /* fall through to the honest skip */ }
  return false
}

/**
 * Report accepted funding sources to the portal.
 *
 * @param {import('playwright').Page} page  authenticated page
 * @param {object} opts
 * @param {Array<{name:string, amount?:number, sponsor?:string}>} opts.sources
 * @param {boolean} [opts.allowSubmit=false]  ONLY the authorized autopilot path
 *        may pass true. Ordinary syncs never submit.
 * @param {(msg:string, detail?:object)=>void} [opts.log]
 * @returns {Promise<{written:Array, skipped:Array, submitted:boolean}>}
 */
export async function reportOutsideAwards(page, { sources = [], allowSubmit = false, log: trace } = {}) {
  const written = []
  const skipped = []
  const say = trace || (() => {})

  if (!Array.isArray(sources) || sources.length === 0) {
    skipped.push({ target: 'outside_awards', reason: 'no accepted funding sources in GrantFlow to report' })
    return { written, skipped, submitted: false }
  }

  const onForm = await reachReportingForm(page, say)
  if (!onForm) {
    // An honest, ACTIONABLE skip: this names what a human would have to do,
    // rather than implying the sync failed.
    skipped.push({
      target: 'outside_awards',
      reason: `no outside-scholarship reporting form found on this portal (${sources.length} accepted source(s) ready to report). Many portals accept these by email or a paper form instead.`,
      sources_ready: sources.length,
    })
    return { written, skipped, submitted: false }
  }

  for (const src of sources) {
    const name = String(src?.name || '').trim()
    if (!name) { skipped.push({ target: 'source', reason: 'funding source has no name' }); continue }
    try {
      const nameInput = page.getByLabel(NAME_FIELD_RE).first()
      if (!(await visible(nameInput))) {
        skipped.push({ target: name, reason: 'name input not present for this row' })
        continue
      }
      await nameInput.fill(name, { timeout: FIND_TIMEOUT_MS })

      const amount = Number(src?.amount)
      if (Number.isFinite(amount) && amount > 0) {
        const amountInput = page.getByLabel(AMOUNT_FIELD_RE).first()
        if (await visible(amountInput)) {
          await amountInput.fill(String(amount), { timeout: FIND_TIMEOUT_MS })
        }
      }

      written.push({
        target: name,
        value: Number.isFinite(amount) && amount > 0 ? `$${amount}` : null,
        // The state is part of the record: never let "written" be read as "sent".
        state: 'filled_not_submitted',
      })
      // The award NAME is tainted (it comes from a portal page / the DB), so it
      // rides as structured detail rather than being interpolated into the log
      // message — CodeQL flags the interpolated form as js/tainted-format-string,
      // and the connector log signature is (msg, detail) precisely for this.
      say('staged outside award', { name })
    } catch (err) {
      skipped.push({ target: name, reason: `fill failed: ${err?.message || err}` })
    }
  }

  if (allowSubmit && written.length > 0) {
    // Reserved for the authorized autopilot path. Even here we require a real
    // submit control and report the outcome truthfully.
    try {
      const submit = page.getByRole('button', { name: /submit|save|add/i }).first()
      if (await visible(submit)) {
        await submit.click({ timeout: FIND_TIMEOUT_MS })
        await page.waitForLoadState?.('domcontentloaded', { timeout: 10000 }).catch(() => {})
        for (const w of written) w.state = 'submitted'
        log.info('outside awards submitted', { count: written.length })
        return { written, skipped, submitted: true }
      }
      skipped.push({ target: 'submit', reason: 'submission was authorized but no submit control was found — values remain filled, not submitted' })
    } catch (err) {
      skipped.push({ target: 'submit', reason: `submit failed: ${err?.message || err} — values remain filled, not submitted` })
    }
  }

  return { written, skipped, submitted: false }
}

export default { reportOutsideAwards }
