/**
 * Yana — public contact-info verification (legacy filename `yanaOutreachContactVerifier.js`).
 *
 * Verifies an organization's *publicly listed* contact info — website
 * reachable, email format/MX-style classification, phone digit-validity,
 * address completeness. We never try to bypass logins, gates, or captchas.
 *
 * The actual HTTP/DNS calls live in pluggable adapters so this file stays
 * deterministic and unit-testable.
 *
 * Adapter contract:
 *   webChecker({ url, config }) -> Promise<{ ok, status, finalUrl, error? }>
 *   mxChecker({ domain, config }) -> Promise<{ ok, mx_records?: number }>
 *
 * Both adapters are optional. When omitted Yana falls back to format-only
 * classification, which is what observe-mode runs use.
 */

import { CONTACT_VERIFICATION_STATUS, PROSPECT_STATUS } from './yanaOutreachTypes.js'
import { classifyEmail, classifyPhone, isPlaceholderUrl, getYanaOutreachConfig } from './yanaOutreachSafety.js'
import { updateProspect } from './yanaOutreachRunStore.js'

/**
 * Pure verification: returns {status, reasons}. No DB writes.
 */
export async function verifyProspectContact(prospect, { webChecker = null, mxChecker = null, config = null } = {}) {
  const cfg = config || getYanaOutreachConfig()
  const reasons = []
  let scoreableSignals = 0
  let satisfiedSignals = 0

  const checkWebsite = async () => {
    if (!prospect?.website_url) {
      reasons.push({ field: 'website_url', verdict: 'missing' })
      return
    }
    scoreableSignals += 1
    if (isPlaceholderUrl(prospect.website_url)) {
      reasons.push({ field: 'website_url', verdict: 'placeholder', value: prospect.website_url })
      return
    }
    if (typeof webChecker !== 'function') {
      reasons.push({ field: 'website_url', verdict: 'unchecked', value: prospect.website_url })
      satisfiedSignals += 0.5
      return
    }
    try {
      const result = await Promise.race([
        webChecker({ url: prospect.website_url, config: cfg }),
        timeout(cfg.timeoutMs ?? 15000),
      ])
      if (result?.ok) {
        reasons.push({
          field: 'website_url',
          verdict: 'live',
          status: result.status ?? null,
          finalUrl: result.finalUrl ?? null,
        })
        satisfiedSignals += 1
      } else {
        reasons.push({
          field: 'website_url',
          verdict: 'unreachable',
          status: result?.status ?? null,
          error: result?.error ?? null,
        })
      }
    } catch (err) {
      reasons.push({ field: 'website_url', verdict: 'error', error: err?.message || String(err) })
    }
  }

  const checkEmail = async () => {
    if (!prospect?.primary_contact_email) {
      reasons.push({ field: 'primary_contact_email', verdict: 'missing' })
      return
    }
    scoreableSignals += 1
    const cls = classifyEmail(prospect.primary_contact_email)
    if (!cls.valid) {
      reasons.push({ field: 'primary_contact_email', verdict: 'invalid_format', value: prospect.primary_contact_email })
      return
    }
    if (cls.is_disposable) {
      reasons.push({ field: 'primary_contact_email', verdict: 'disposable_provider', domain: cls.domain })
      return
    }
    if (cls.is_role) {
      reasons.push({ field: 'primary_contact_email', verdict: 'role_address_ok', domain: cls.domain })
      satisfiedSignals += 0.6
    } else if (cls.is_org_email) {
      reasons.push({ field: 'primary_contact_email', verdict: 'org_email', domain: cls.domain })
      satisfiedSignals += 1
    } else {
      reasons.push({ field: 'primary_contact_email', verdict: 'generic_provider', domain: cls.domain })
      satisfiedSignals += 0.4
    }
    if (typeof mxChecker === 'function' && cls.domain) {
      try {
        const mx = await Promise.race([
          mxChecker({ domain: cls.domain, config: cfg }),
          timeout(cfg.timeoutMs ?? 15000),
        ])
        if (mx?.ok) {
          reasons.push({ field: 'primary_contact_email', verdict: 'mx_present', mx_records: mx.mx_records ?? null })
          satisfiedSignals = Math.min(satisfiedSignals + 0.2, scoreableSignals)
        } else {
          reasons.push({ field: 'primary_contact_email', verdict: 'mx_missing', error: mx?.error ?? null })
        }
      } catch (err) {
        reasons.push({ field: 'primary_contact_email', verdict: 'mx_error', error: err?.message || String(err) })
      }
    }
  }

  const checkPhone = () => {
    if (!prospect?.primary_contact_phone) {
      reasons.push({ field: 'primary_contact_phone', verdict: 'missing' })
      return
    }
    scoreableSignals += 1
    const cls = classifyPhone(prospect.primary_contact_phone)
    if (cls.valid) {
      reasons.push({ field: 'primary_contact_phone', verdict: 'plausible', e164_like: cls.e164_like })
      satisfiedSignals += 1
    } else {
      reasons.push({ field: 'primary_contact_phone', verdict: 'invalid', digit_count: cls.digit_count })
    }
  }

  const checkAddress = () => {
    if (!prospect) return
    const hasCity = Boolean(prospect.city)
    const hasState = Boolean(prospect.state)
    const hasZip = Boolean(prospect.zip)
    const hasAddr = Boolean(prospect.address)
    if (hasCity || hasState || hasAddr) scoreableSignals += 1
    if (hasCity && hasState) {
      reasons.push({ field: 'address', verdict: 'city_state_present', has_zip: hasZip, has_street: hasAddr })
      satisfiedSignals += 1
    } else if (hasState) {
      reasons.push({ field: 'address', verdict: 'state_only' })
      satisfiedSignals += 0.5
    } else {
      reasons.push({ field: 'address', verdict: 'missing' })
    }
  }

  await Promise.all([checkWebsite(), checkEmail()])
  checkPhone()
  checkAddress()

  let status = CONTACT_VERIFICATION_STATUS.UNVERIFIED
  if (scoreableSignals === 0) {
    status = CONTACT_VERIFICATION_STATUS.UNREACHABLE
  } else {
    const ratio = satisfiedSignals / scoreableSignals
    if (ratio >= 0.8) status = CONTACT_VERIFICATION_STATUS.VERIFIED
    else if (ratio >= 0.4) status = CONTACT_VERIFICATION_STATUS.PARTIAL
    else status = CONTACT_VERIFICATION_STATUS.UNREACHABLE
  }

  return { status, reasons, scoreableSignals, satisfiedSignals }
}

/**
 * Verify and persist on a single prospect. Updates contact_verification_*
 * columns on larry_prospect_candidates and bumps `status` to
 * `contact_verified` or `contact_unverified` accordingly.
 */
export async function verifyAndPersistContact({ db, prospect, webChecker = null, mxChecker = null, config = null } = {}) {
  if (!prospect?.id) return null
  const result = await verifyProspectContact(prospect, { webChecker, mxChecker, config })
  if (!db) return { prospect, ...result }

  const newStatus =
    result.status === CONTACT_VERIFICATION_STATUS.VERIFIED ||
    result.status === CONTACT_VERIFICATION_STATUS.PARTIAL
      ? PROSPECT_STATUS.CONTACT_VERIFIED
      : PROSPECT_STATUS.CONTACT_UNVERIFIED

  const updated = await updateProspect(db, prospect.id, {
    contact_verification_status: result.status,
    contact_verification_reasons_json: result.reasons,
    last_checked_at: new Date().toISOString(),
    status: newStatus,
  })
  return { prospect: updated, ...result }
}

function timeout(ms) {
  return new Promise((_, reject) => {
    const id = setTimeout(() => reject(new Error(`timeout_${ms}ms`)), ms)
    if (typeof id?.unref === 'function') id.unref()
  })
}
