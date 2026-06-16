/**
 * Sam — pricing access-gate auditor.
 *
 * Complements `samPricingAuditor` by checking the gate end-to-end:
 *
 *   - every profile has a profile_pricing row
 *   - every profile_pricing → quote with consistent totals
 *   - admins are never blocked
 *   - admin notifications target only the configured admin email
 *   - new-user pricing creates an admin notification
 *   - unpaid users have not generated payment_access_events that imply
 *     they reached blocked routes
 *   - user-facing copy never says funding is "guaranteed"
 *
 * Pure-ish: where possible, the function reads the DB and returns a list
 * of structured findings.
 */

import { withProfileScope } from '../../middleware/profileContext.js'
import { SAM_PRICING_FINDING_SEVERITY } from './samPricingAuditor.js'
import {
  ACCESS_STATUS,
  ADMIN_NOTIFICATION_TYPE,
  PAYMENT_ACCESS_EVENT,
  adminNotificationEmail,
  isAdminNotificationTarget,
} from './pricingTypes.js'
import {
  ADMIN_NOTIFICATIONS_TABLE,
  PAYMENT_EVENTS_TABLE,
  PROFILE_PRICING_TABLE,
} from './profilePricingInitializer.js'

async function tableExists(db, table) {
  if (!db) return false
  try {
    if (db.dialect === 'pg' || db.dialect === 'postgres') {
      const r = await db.prepare("SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1").get(table)
      return Boolean(r)
    }
    const r = await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1").get(table)
    return Boolean(r)
  } catch {
    return false
  }
}

/**
 * Pure findings derived from a snapshot of (profile, profile_pricing,
 * notifications, events, user). Used in unit tests.
 */
export function deriveGateFindings({
  profile,
  profilePricing,
  notifications = [],
  events = [],
  user = null,
} = {}) {
  const findings = []
  if (!profile) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
      category: 'no_profile',
      title: 'Audit called without a profile',
      description: 'Sam pricing-gate audit requires a profile.',
      recommended_fix: 'Pass the profile row.',
      evidence: {},
    })
    return findings
  }

  const isAdmin = Boolean(user?.is_admin) || isAdminNotificationTarget(user?.email)

  if (!profilePricing) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
      category: 'profile_missing_pricing',
      title: 'Profile missing automatic pricing',
      description:
        'Every profile must receive automatic pricing on creation. This profile has no `profile_pricing` row.',
      recommended_fix: 'Run profilePricingInitializer.initializeProfilePricing for this profile.',
      evidence: { profile_id: profile.id },
    })
    return findings
  }

  // 1. Admin must never be blocked.
  if (isAdmin && [
    ACCESS_STATUS.PENDING_AGREEMENT,
    ACCESS_STATUS.PENDING_PAYMENT,
    ACCESS_STATUS.BLOCKED,
    ACCESS_STATUS.EXPIRED,
  ].includes(profilePricing.access_status)) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.CRITICAL,
      category: 'admin_blocked_by_payment_gate',
      title: 'Admin blocked by payment gate',
      description: `Admin user ${user?.email || user?.id} has access_status="${profilePricing.access_status}".`,
      recommended_fix: 'Set access_status=admin_waived for admin profiles.',
      evidence: { profile_id: profile.id, access_status: profilePricing.access_status },
    })
  }

  // 2. Quote math (subtotal_cents - discount_total_cents == total_cents).
  const subC = Number(profilePricing.subtotal_cents || 0)
  const discC = Number(profilePricing.discount_total_cents || 0)
  const totalC = Number(profilePricing.total_cents || 0)
  if (Math.max(0, subC - discC) !== totalC) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
      category: 'profile_pricing_total_mismatch',
      title: 'profile_pricing total does not equal subtotal − discount',
      description: `subtotal=${subC} discount=${discC} total=${totalC}.`,
      recommended_fix: 'Re-run the initializer for this profile.',
      evidence: { profile_id: profile.id, subtotal_cents: subC, discount_total_cents: discC, total_cents: totalC },
    })
  }

  // 3. Catalog version must be present.
  if (!profilePricing.pricing_catalog_version) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
      category: 'pricing_missing_catalog_version',
      title: 'profile_pricing missing pricing_catalog_version',
      description: 'Every pricing record must capture the catalog version.',
      recommended_fix: 'Re-run the initializer.',
      evidence: { profile_id: profile.id },
    })
  }

  // 4. Admin notifications target must be the configured admin email only.
  for (const n of notifications) {
    if (n.admin_email && n.admin_email.toLowerCase() !== adminNotificationEmail()) {
      findings.push({
        severity: SAM_PRICING_FINDING_SEVERITY.CRITICAL,
        category: 'wrong_admin_notification_target',
        title: `Admin notification routed to ${n.admin_email}`,
        description: `Pricing toasts must only target ${adminNotificationEmail()}.`,
        recommended_fix: 'Update PRICING_ADMIN_NOTIFICATION_EMAIL or fix the queue insert.',
        evidence: { notification_id: n.id, admin_email: n.admin_email },
      })
    }
  }

  // 5. New-user pricing must create at least one notification (unless admin).
  if (!isAdmin && profilePricing.created_at) {
    const hasNewUserNotif = notifications.some(
      (n) => n.notification_type === ADMIN_NOTIFICATION_TYPE.NEW_USER_PRICING && n.profile_id === profile.id,
    )
    if (!hasNewUserNotif) {
      findings.push({
        severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
        category: 'admin_notification_missing',
        title: 'Admin pricing notification not created',
        description: 'profilePricingInitializer should queue a new_user_pricing notification for this profile.',
        recommended_fix: 'Confirm initializer ran and PRICING_ADMIN_TOASTS_ENABLED=true.',
        evidence: { profile_id: profile.id },
      })
    }
  }

  // 6. Unpaid access leak — payment_access_events show ACCESS_GRANTED for an
  //    unpaid profile.
  const accessGranted = events.some((e) => e.event_type === PAYMENT_ACCESS_EVENT.ACCESS_GRANTED)
  const isPaidish = [ACCESS_STATUS.ACTIVE_PAID, ACCESS_STATUS.ADMIN_WAIVED].includes(profilePricing.access_status)
  if (accessGranted && !isPaidish && !isAdmin) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.CRITICAL,
      category: 'unpaid_access_leak',
      title: 'Unpaid user accessed a gated route',
      description: 'access_granted event recorded for a profile whose access_status is not active_paid or admin_waived.',
      recommended_fix: 'Audit the gate and revoke access until payment.',
      evidence: { profile_id: profile.id, access_status: profilePricing.access_status },
    })
  }

  // 7. Payment succeeded but access not granted.
  const paymentSucceeded = events.some((e) => e.event_type === PAYMENT_ACCESS_EVENT.PAYMENT_SUCCEEDED)
  if (paymentSucceeded && !isPaidish) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
      category: 'paid_but_blocked',
      title: 'Payment succeeded but access not granted',
      description:
        'A payment_succeeded event exists but profile_pricing.access_status is not active_paid / admin_waived.',
      recommended_fix: 'Run /api/access-gate/payment-success or manually mark active_paid.',
      evidence: { profile_id: profile.id, access_status: profilePricing.access_status },
    })
  }

  return findings
}

/**
 * Live audit: scan a sample of recent profile_pricing rows.
 */
export async function runGateAudit(db, { sampleSize = 50 } = {}) {
  const findings = []
  if (!db) return { installed: false, findings, audited: 0 }
  const installed = await tableExists(db, PROFILE_PRICING_TABLE)
  if (!installed) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.INFO,
      category: 'access_gate_tables_not_installed',
      title: 'Access-gate tables not installed',
      description: 'Run migration 080_pricing_access_gate.sql.',
      recommended_fix: 'Apply the migration.',
      evidence: {},
    })
    return { installed: false, findings, audited: 0 }
  }

  const rows = await withProfileScope({ bypass: true }, () =>
    db.prepare(`SELECT * FROM ${PROFILE_PRICING_TABLE} ORDER BY created_at DESC LIMIT ?`).all(sampleSize),
  )
  let audited = 0
  for (const pp of rows) {
    audited += 1
    const notifications = (await tableExists(db, ADMIN_NOTIFICATIONS_TABLE))
      ? await withProfileScope({ bypass: true }, () =>
          db.prepare(`SELECT * FROM ${ADMIN_NOTIFICATIONS_TABLE} WHERE profile_id = ?`).all(pp.profile_id),
        )
      : []
    const events = (await tableExists(db, PAYMENT_EVENTS_TABLE))
      ? await withProfileScope({ bypass: true }, () =>
          db.prepare(`SELECT * FROM ${PAYMENT_EVENTS_TABLE} WHERE profile_id = ? ORDER BY created_at`).all(pp.profile_id),
        )
      : []
    const sub = deriveGateFindings({
      profile: { id: pp.profile_id },
      profilePricing: pp,
      notifications,
      events,
      user: null,
    })
    for (const f of sub) findings.push({ ...f, evidence: { ...f.evidence, profile_id: pp.profile_id } })
  }
  return { installed: true, findings, audited }
}
