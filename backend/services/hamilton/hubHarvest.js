/**
 * hubHarvest.js — the bold.org / scholarshipowl HUB HARVESTER.
 *
 * WHY THIS EXISTS (2026-08-24, owner north star — Hamilton finishes portals
 * autonomously). Measured on prod: every one of the live SPA-hub profiles
 * (two student profiles and a wellness-LLC profile) carries
 * ~5 bold.org award pages, one of them holds VALID bold.org/scholarshipowl
 * sessions —
 * and Hamilton reaches ZERO confirmed external submissions on them. Three gaps
 * (see spaApplySurface.js for the prod DOM evidence) closed the door:
 *   1. `extractListingAwardItems` only kept an applyUrl that was an <a href>, so a
 *      bold.org Apply BUTTON yielded null → the award was catalog_only, never
 *      applied. (Fixed: `snapshot.applyControls` → per-award `applyMarker`.)
 *   2. `decomposeListing` was called with NO applyItem runner, so every ACCEPTed
 *      award became a deferred child task (allowAutoSubmit:false). (Fixed: this
 *      harvester runs the apply step directly, and the orchestrator now wires an
 *      applyItem runner into decomposeListing under the parent run's consent.)
 *   3. an individual award page was mislabeled `no_application_form` / routed to
 *      the `spa_apply_surface` blocker. (Fixed: this harvester enumerates the
 *      LOGGED-IN matched list and drives the in-SPA apply surface directly.)
 *
 * WHAT IT DOES. With the profile's SAVED SESSION (storage_state), it loads the
 * logged-in matched-scholarships list, enumerates the award cards + their in-SPA
 * "Apply" controls (buttons, not just links), and for each award:
 *   (a) admits it through the CANONICAL `opportunityInserter.upsertFundingOpportunity`
 *       (reality gate + dedup — the ONLY admission gate);
 *   (b) runs the FULL 4-gate for the profile — `matchEngine.computeMatchDecision`
 *       (applicant type / stage / geography / eligibility / aid preference) AND
 *       `pipelinePrecision.evaluateDeclaredNeedCoverage` (declared-need coverage).
 *       Only an ACCEPT that also covers a declared need proceeds;
 *   (c) for a qualifying + AUTHORIZED award (the SAME `allow_auto_submit` consent
 *       the engine already reads — NEVER widened here) clicks Apply and drives the
 *       resulting in-SPA form under the EXISTING confirmation-evidence gate. A
 *       submit is REPORTED only with captured portal-confirmation evidence; a
 *       click without evidence is a blocker, NEVER "submitted".
 *
 * HONESTY / SAFETY:
 *   - Consent is read ONCE, verbatim (`allowAutoSubmit`). This module never
 *     derives a broader consent and never submits when consent is absent.
 *   - The DEFAULT apply driver OPENS and DETECTS the in-SPA surface but never
 *     blind-clicks a submit — the actual submit+evidence step is an injected seam
 *     (`deps.submit`), so the repository carries no unattended blind-submit path.
 *   - PURE of a specific browser: the Playwright `page`, the inserter, the match
 *     engine, the need gate and the apply driver are all injectable, so the whole
 *     harvest/enumeration/4-gate/consent flow is unit-testable with a MOCK page.
 */

import { spaApplyHub, SPA_APPLY_HUBS } from './spaApplySurface.js'
import { buildOpportunityRecord } from './listingDecomposition.js'
import { upsertFundingOpportunity } from '../opportunityInserter.js'
import { computeMatchDecision } from '../matchEngine.js'
import { declaredNeedsFrom, evaluateDeclaredNeedCoverage } from '../pipelinePrecision.js'

/** Per-hub logged-in matched-scholarships list URL (env-overridable). */
export const HUB_MATCHED_LIST_URLS = Object.freeze({
  'bold.org': process.env.HAMILTON_HUB_HARVEST_BOLD_URL || 'https://bold.org/dashboard/scholarships',
  'scholarshipowl.com': process.env.HAMILTON_HUB_HARVEST_OWL_URL || 'https://scholarshipowl.com/dashboard/scholarships',
})

/** Max award cards enumerated from one hub per harvest run. */
export const HUB_HARVEST_MAX_AWARDS = Number(process.env.HAMILTON_HUB_HARVEST_MAX_AWARDS) || 25
/** Max per-award apply ATTEMPTS per harvest run (evidence-gated submit fan-out). */
export const HUB_HARVEST_MAX_APPLIES = Number(process.env.HAMILTON_HUB_HARVEST_MAX_APPLIES) || 5

/** The matched-list URL for a hub key, or null. */
export function hubMatchedListUrl(hubKey) {
  return HUB_MATCHED_LIST_URLS[hubKey] || null
}

/**
 * A submit is REPORTABLE only when the apply driver returned a status of
 * 'submitted' AND carries captured portal-confirmation evidence. This mirrors
 * the engine contract (`assessSubmissionEvidence`): a submit-click without
 * evidence is a blocker (`submit_unconfirmed`), never "submitted".
 */
export function isReportableSubmission(result) {
  if (!result || result.status !== 'submitted') return false
  return Boolean(
    result.confirmation_evidence
    || result.confirmation?.reference
    || result.confirmation?.received_acknowledgement === true
    || result.confirmation?.screenshot_document_id
    || result.confirmation?.page_document_id,
  )
}

/**
 * Enumerate award cards + their in-SPA "Apply" controls from the LOGGED-IN
 * matched list. Runs in-page: each card that carries BOTH a scholarship title
 * and an apply control is tagged with a stable `data-hamilton-apply` marker the
 * apply step can re-find, and returned as `{ title, applyUrl, applyMarker }`.
 *
 * Fabrication-guarded by construction: a card is only returned when it has real
 * title text taken from the card itself — nothing is invented — and `applyUrl`
 * is emitted only when the apply control is a genuine <a href>.
 *
 * @param {import('playwright').Page} page  an authenticated page on the list.
 * @param {object} [opts]
 * @param {number} [opts.maxAwards]
 * @returns {Promise<{ awards:Array<{title:string,applyUrl:string|null,applyMarker:string,amount:number|null,sponsor:string|null}>, applyControls:Array<{marker:string,title:string,text:string}> }>}
 */
export async function enumerateHubAwards(page, opts = {}) {
  const maxAwards = Number.isFinite(opts.maxAwards) ? opts.maxAwards : HUB_HARVEST_MAX_AWARDS
  let cards = []
  try {
    cards = await page.evaluate((cap) => {
      const APPLY_RX = /\bapply(\s+(now|to))?\b|1[-\s]?click\s+apply/i
      const out = []
      // A "card" is the nearest ancestor of an apply control that also contains a
      // scholarship title. Walk apply controls (buttons OR links), climb to a
      // container, read the card's own heading/title text.
      const controls = Array.from(document.querySelectorAll('button, a[role="button"], a'))
        .filter((el) => APPLY_RX.test((el.textContent || '').trim()))
      let idx = 0
      const seen = new Set()
      for (const ctrl of controls) {
        if (out.length >= cap) break
        // Climb up to a plausible card container (max 6 hops).
        let card = ctrl
        for (let i = 0; i < 6 && card?.parentElement; i += 1) {
          card = card.parentElement
          const h = card.querySelector('h1,h2,h3,h4,[data-testid*="title"],[class*="title"],[class*="Title"]')
          if (h && (h.textContent || '').trim().length >= 6) break
        }
        const heading = card?.querySelector('h1,h2,h3,h4,[data-testid*="title"],[class*="title"],[class*="Title"]')
        const title = (heading?.textContent || '').trim().replace(/\s+/g, ' ')
        if (!title || title.length < 6 || seen.has(title.toLowerCase())) continue
        seen.add(title.toLowerCase())
        const marker = `hamilton-apply-${idx}`
        try { ctrl.setAttribute('data-hamilton-apply', marker) } catch { /* read-only DOM */ }
        // A real navigable apply URL only when the control is an <a href>.
        const href = ctrl.tagName === 'A' ? (ctrl.getAttribute('href') || '') : ''
        let applyUrl = null
        if (href && /^https?:\/\//i.test(href)) applyUrl = href
        else if (href && href.startsWith('/')) { try { applyUrl = new URL(href, location.origin).href } catch { applyUrl = null } }
        const amountText = (card?.textContent || '').match(/\$\s?([\d,]{2,})/)
        const amount = amountText ? Number(amountText[1].replace(/,/g, '')) : null
        out.push({
          title: title.slice(0, 200),
          applyUrl,
          applyMarker: marker,
          amount: Number.isFinite(amount) ? amount : null,
          controlText: (ctrl.textContent || '').trim().slice(0, 60),
        })
        idx += 1
      }
      return out
    }, maxAwards)
  } catch {
    cards = []
  }
  const awards = (Array.isArray(cards) ? cards : [])
    .filter((c) => c && typeof c.title === 'string' && c.title.trim().length >= 6)
    .map((c) => ({
      title: c.title,
      applyUrl: c.applyUrl || null,
      applyMarker: c.applyMarker,
      amount: Number.isFinite(c.amount) ? c.amount : null,
      sponsor: null,
    }))
  const applyControls = awards.map((a) => ({ marker: a.applyMarker, title: a.title, text: 'Apply' }))
  return { awards, applyControls }
}

/**
 * The DEFAULT in-SPA apply driver. OPENS the application behind the award's
 * "Apply" control and detects whether an application surface came up — it does
 * NOT blind-submit. The real submit+evidence step is the injected `submit` seam
 * (default null), so no unattended blind-submit path lives in this repository.
 *
 * @returns {Promise<{status:string, blocker_kind?:string, detail?:string, confirmation?:object, confirmation_evidence?:string}>}
 */
export async function driveInSpaApply(page, { item, allowAutoSubmit, authorizations, submit = null } = {}) {
  const marker = item?.applyMarker || null
  // Open the apply surface (navigable URL preferred; else click the in-SPA control).
  try {
    if (item?.applyUrl) {
      await page.goto(item.applyUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    } else if (marker) {
      await page.click(`[data-hamilton-apply="${marker}"]`, { timeout: 8_000 })
      await page.waitForLoadState?.('networkidle', { timeout: 4_000 }).catch(() => {})
    } else {
      return { status: 'blocked', blocker_kind: 'no_apply_surface', detail: 'award carried no apply URL or in-SPA marker' }
    }
  } catch (err) {
    return { status: 'blocked', blocker_kind: 'apply_open_failed', detail: err?.message || String(err) }
  }
  // The submit + confirmation-evidence capture is the injected seam. It is the
  // ONLY thing that may actually submit, and it must return the engine-style
  // { status:'submitted', confirmation } ONLY with captured evidence — otherwise
  // a blocker. Consent is forwarded verbatim; the driver never widens it.
  if (allowAutoSubmit === true && typeof submit === 'function') {
    const result = await submit(page, { item, authorizations, allowAutoSubmit })
    return result || { status: 'blocked', blocker_kind: 'submit_unconfirmed', detail: 'submit step returned nothing' }
  }
  return {
    status: 'blocked',
    blocker_kind: 'spa_apply_form_ready',
    detail: 'Opened the in-SPA application. Submit requires the evidence-gated submit step (captured portal confirmation) and explicit auto-submit consent.',
  }
}

/**
 * Harvest one hub for one profile: enumerate → admit → 4-gate → apply.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.profile           raw profile bundle (for matching + needs)
 * @param {object} [args.profileSections] optional sections for the need gate
 * @param {string} args.hubKey            'bold.org' | 'scholarshipowl.com'
 * @param {string} [args.listUrl]         override the matched-list URL
 * @param {import('playwright').Page} args.page  authenticated page (saved session)
 * @param {boolean} args.allowAutoSubmit  the SAME consent the engine reads — verbatim
 * @param {object} [args.authorizations]  forwarded verbatim to the apply driver
 * @param {number} [args.maxAwards]
 * @param {number} [args.maxApplies]
 * @param {object} [deps]  injectable seams (defaults use the canonical modules)
 * @returns {Promise<object>}
 */
export async function harvestHub(args = {}, deps = {}) {
  const {
    db, profile, profileSections = null, hubKey, page,
    allowAutoSubmit = false, authorizations = null,
    maxAwards = HUB_HARVEST_MAX_AWARDS, maxApplies = HUB_HARVEST_MAX_APPLIES,
  } = args
  const log = deps.log || (() => {})
  const enumerate = deps.enumerate || ((p, o) => enumerateHubAwards(p, o))
  const insert = deps.insert || ((d, rec, o) => upsertFundingOpportunity(d, rec, o))
  const match = deps.match || ((p, opp, o) => computeMatchDecision(p, opp, o))
  const applyRunner = deps.applyRunner || ((p, ctx) => driveInSpaApply(p, { ...ctx, submit: deps.submit || null }))
  const declaredNeeds = declaredNeedsFrom(profile, profileSections)
  // The declared-need gate is the 4th conjunct beyond the engine's own gates.
  // Injectable for tests; the default is the canonical pipelinePrecision reader.
  const needGate = deps.needCoverage || ((opp) => evaluateDeclaredNeedCoverage(opp, declaredNeeds))

  const listUrl = args.listUrl || hubMatchedListUrl(hubKey)
  const hub = SPA_APPLY_HUBS[hubKey] || spaApplyHub(listUrl || `https://${hubKey}/`)

  const out = {
    hub: hubKey || null, list_url: listUrl || null,
    enumerated: 0, admitted: 0, accepted: 0, applies_attempted: 0, submitted: 0,
    items: [], notFound: [],
  }
  if (!hubKey || !hub) {
    out.notFound.push(`unknown scholarship hub: ${hubKey}`)
    return out
  }
  if (!listUrl) {
    out.notFound.push(`no matched-scholarships list URL configured for ${hubKey}`)
    return out
  }
  if (!page) {
    out.notFound.push('no authenticated browser page (saved session) available for the harvest')
    return out
  }

  // Load the logged-in matched list, then enumerate the cards.
  try {
    if (typeof page.goto === 'function') {
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      await page.waitForLoadState?.('networkidle', { timeout: 5_000 }).catch(() => {})
    }
  } catch (err) {
    out.notFound.push(`could not load the matched list: ${err?.message || err}`)
    return out
  }

  let enumResult
  try {
    enumResult = await enumerate(page, { maxAwards, hub: hubKey })
  } catch (err) {
    out.notFound.push(`enumeration failed: ${err?.message || err}`)
    return out
  }
  const awards = (Array.isArray(enumResult?.awards) ? enumResult.awards : []).slice(0, maxAwards)
  out.enumerated = awards.length
  if (awards.length === 0) {
    out.notFound.push('no award cards enumerated from the logged-in matched list')
    return out
  }

  for (const award of awards) {
    const record = { title: award.title, apply_url: award.applyUrl || null, apply_marker: award.applyMarker || null }
    const opp = buildOpportunityRecord(award, { listingUrl: award.applyUrl || listUrl })

    // 1. Admit through the canonical inserter (reality gate + dedup).
    let ins
    try {
      ins = await insert(db, opp, { allowDirectories: true })
    } catch (err) {
      record.outcome = 'insert_error'
      record.detail = err?.message || String(err)
      out.items.push(record)
      continue
    }
    if (!ins || ins.skipped || (!ins.inserted && !ins.updated && !ins.id)) {
      record.outcome = 'not_admitted'
      record.detail = ins?.reason || 'inserter rejected or deduped without id'
      out.items.push(record)
      continue
    }
    out.admitted += 1
    record.opportunity_id = ins.id
    record.admitted = true

    // 2. Canonical relevance decision (applicant/stage/geo/eligibility/aid).
    let decision
    try {
      decision = match(profile, opp, { profileSections })
    } catch (err) {
      record.outcome = 'match_error'
      record.detail = err?.message || String(err)
      out.items.push(record)
      continue
    }
    record.decision = decision?.decision || 'REVIEW'
    record.match_score = decision?.score ?? null

    // 3. Declared-need coverage (the 4th gate beyond the engine's own gates).
    const cov = needGate(opp)
    record.need_coverage = cov.detail
    record.need_pass = cov.pass

    // 4. Only an ACCEPT that also covers a declared need proceeds.
    if (record.decision !== 'ACCEPT') {
      record.outcome = 'not_accepted'
      out.items.push(record)
      continue
    }
    if (!cov.pass) {
      record.outcome = 'need_not_covered'
      out.items.push(record)
      continue
    }
    out.accepted += 1

    if (!award.applyUrl && !award.applyMarker) {
      record.outcome = 'accepted_no_apply_surface'
      out.items.push(record)
      continue
    }
    // 5. Consent is read verbatim — NEVER widened. No consent → do not apply.
    if (allowAutoSubmit !== true) {
      record.outcome = 'accepted_apply_unauthorized'
      record.detail = 'auto-submit consent (allow_auto_submit) is not set for this run — award admitted + accepted, not applied'
      out.items.push(record)
      continue
    }
    if (out.applies_attempted >= maxApplies) {
      record.outcome = 'apply_fanout_capped'
      record.detail = `reached HAMILTON_HUB_HARVEST_MAX_APPLIES=${maxApplies}`
      out.items.push(record)
      continue
    }

    // 6. Drive the in-SPA apply under the EXISTING confirmation-evidence gate.
    out.applies_attempted += 1
    let result
    try {
      result = await applyRunner(page, {
        item: award, opportunityId: ins.id, allowAutoSubmit, authorizations,
      })
    } catch (err) {
      record.outcome = 'apply_error'
      record.detail = err?.message || String(err)
      out.items.push(record)
      continue
    }
    record.apply_status = result?.status || null
    record.apply_blocker = result?.blocker_kind || null
    if (isReportableSubmission(result)) {
      out.submitted += 1
      record.outcome = 'submitted'
      record.confirmation_evidence = result.confirmation_evidence || 'portal_confirmation'
    } else if (result?.status === 'submitted') {
      // A submit status WITHOUT captured evidence is a blocker, never "submitted".
      record.outcome = 'submit_unconfirmed'
      record.detail = 'submit click completed but no portal-confirmation evidence was captured — handed to a human, never reported as submitted'
    } else {
      record.outcome = 'apply_blocked'
    }
    out.items.push(record)
  }

  log(`harvestHub[${hubKey}]: ${out.enumerated} enumerated, ${out.admitted} admitted, ${out.accepted} accepted, ${out.applies_attempted} apply attempt(s), ${out.submitted} submitted`)
  return out
}

export default {
  HUB_MATCHED_LIST_URLS,
  HUB_HARVEST_MAX_AWARDS,
  HUB_HARVEST_MAX_APPLIES,
  hubMatchedListUrl,
  isReportableSubmission,
  enumerateHubAwards,
  driveInSpaApply,
  harvestHub,
}
