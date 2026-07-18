/**
 * Request Context Middleware
 * 
 * Canonical source of truth for identity and authority.
 * This middleware MUST run early in the pipeline, after auth token parsing.
 * 
 * Produces req.ctx with:
 * - userId: stable user ID
 * - email: primary email
 * - isAdmin: DB-backed admin status (NOT token-only)
 * - activeProfileId: current profile context
 * - accessibleProfileIds: Set of profile IDs user can access
 * - accessibleOrgIds: Set of org IDs user can access
 */

import { 
  getAuthUserId, 
  getAuthProfileId,
  getAccessibleProfileIds,
  getAccessibleOrganizationIds,
  addProfileEmails,
  ensureProfileEmailSchema,
} from '../utils/accessControl.js'
import { isAdminEmail } from '../config/constants.js'
import crypto from 'crypto'

let lastAdminSelfHealAtMs = 0
const ADMIN_SELF_HEAL_INTERVAL_MS = 10 * 60 * 1000

// Synthetic SERVICE tokens (ADMIN_TOKEN / bulk key, Anya API key, health token)
// are validated by safeTokenEqual against configured secrets in the auth layer and
// have NO real users row. They are the ONLY legitimate token-derived admins — a
// real user (any other userId) must always resolve from users.is_admin, and a DB
// error/missing row must FAIL CLOSED, never trust the JWT role/is_admin claim.
const SYNTHETIC_SERVICE_ADMIN_USER_IDS = new Set([
  'system_admin_token',
  'system_anya_token',
  'system_health_token',
])

export function isSyntheticServiceAdmin(user) {
  // Bind synthetic-admin authority to service-token PROVENANCE, not to the id
  // VALUE. `serviceToken` is set ONLY inside a safeTokenEqual service-token branch
  // and can never come from a JWT payload — so a signed JWT with sub:'system_admin_token'
  // (or any colliding synthetic id) does NOT pass this check and falls through to
  // the normal DB lookup (where it has no is_admin row => non-admin). The id
  // allowlist is kept as a secondary defense-in-depth constraint.
  const id = user?.userId
  return Boolean(
    user?.serviceToken === true &&
      user.is_admin === true &&
      id &&
      SYNTHETIC_SERVICE_ADMIN_USER_IDS.has(String(id)),
  )
}

function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase()
  if (!email || !email.includes('@')) return null
  return email
}

async function upsertBasicInformationEmail(db, { profileId, email, actorUserId }) {
  const normalized = normalizeEmail(email)
  if (!normalized) return { updated: false }

  const existing = await db
    .prepare(`SELECT id, data FROM profile_sections WHERE profile_id = ? AND section_key = 'basic_information' LIMIT 1`)
    .get(profileId)

  let data = {}
  if (existing?.data) {
    try {
      data = typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data
    } catch {
      data = {}
    }
  }

  const current = normalizeEmail(data?.email)
  if (current) return { updated: false }

  const next = { ...(data && typeof data === 'object' ? data : {}), email: normalized }
  const id = existing?.id || crypto.randomUUID()

  // Works for both sqlite + postgres (ON CONFLICT supported in sqlite >= 3.24).
  await db
    .prepare(
      `
        INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by)
        VALUES (?, ?, 'basic_information', ?, ?)
        ON CONFLICT(profile_id, section_key) DO UPDATE SET
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP,
          updated_by = excluded.updated_by
      `,
    )
    .run(id, profileId, JSON.stringify(next), actorUserId || null)

  return { updated: true }
}

async function adminSelfHealOrgProfileEmails(db, { actorUserId, isAdmin = false } = {}) {
  if (!isAdmin) return { ran: false, error: 'Unauthorized' }
  // Throttle (avoid heavy work on every request)
  const now = Date.now()
  if (now - lastAdminSelfHealAtMs < ADMIN_SELF_HEAL_INTERVAL_MS) return { ran: false }
  lastAdminSelfHealAtMs = now

  try {
    await ensureProfileEmailSchema(db)
  } catch {
    // best-effort only
  }

  // Ensure org profiles that lack ownership are still shareable to the org email.
  // This prevents "invisible" profiles for org users when only organizations.email is populated.
  const rows = await db
    .prepare(
      `
        SELECT p.id AS profile_id, p.organization_id, o.email AS org_email
        FROM profiles p
        JOIN organizations o ON o.id = p.organization_id
        WHERE p.organization_id IS NOT NULL
          AND (p.status IS NULL OR p.status <> 'deleted')
          AND (p.user_id IS NULL OR TRIM(p.user_id) = '')
          AND o.email IS NOT NULL
          AND TRIM(o.email) <> ''
        ORDER BY p.updated_at DESC
        LIMIT 250
      `,
    )
    .all()

  let healed = 0
  for (const row of rows || []) {
    const email = normalizeEmail(row?.org_email)
    if (!email) continue
    const profileId = row.profile_id

    try {
      const exists = await db
        .prepare('SELECT 1 FROM profile_emails WHERE profile_id = ? AND lower(email) = ? LIMIT 1')
        .get(profileId, email)
      if (!exists) {
        await addProfileEmails(db, { profileId, emails: [email], addedBy: actorUserId ?? 'admin_self_heal' })
      }
      // Also ensure basic_information.email exists when missing (idempotent).
      await upsertBasicInformationEmail(db, { profileId, email, actorUserId: actorUserId ?? 'admin_self_heal' })
      healed += 1
    } catch {
      // ignore per-profile failures (schema drift / bad data)
    }
  }

  if (healed > 0) {
    console.info('[requestContext] admin self-heal applied', { profiles: healed })
  }
  return { ran: true, profiles: healed }
}

/**
 * Build canonical request context from authenticated user.
 * This is the ONLY place where admin status should be resolved.
 * All other code must use req.ctx.isAdmin.
 * 
 * @param {object} db - Database connection
 * @param {object} user - User object from req.user (after auth middleware)
 * @returns {Promise<object>} Request context
 */
export async function buildRequestContext(db, user) {
  const ctx = {
    userId: null,
    email: null,
    isAdmin: false,
    activeProfileId: null,
    // IMPORTANT:
    // - `null` means "all" and MUST be reserved for authenticated admins only.
    // - Guests MUST NOT default to null, or they will be treated as "admin sentinel" by access helpers.
    accessibleProfileIds: new Set(), // null = all (admin only), Set = specific IDs
    accessibleOrgIds: new Set(), // null = all (admin only), Set = specific IDs
  }

  // Guest user - return empty context
  if (!user || user.role === 'guest') {
    return ctx
  }

  // Extract user ID
  ctx.userId = getAuthUserId(user)
  ctx.email = user.email || user.primary_email || null
  ctx.activeProfileId = getAuthProfileId(user)

  // CRITICAL: Admin status is DB-backed ONLY (users.is_admin), with exactly two
  // DB-INDEPENDENT admins that are NOT JWT role claims:
  //   (a) a validated synthetic SERVICE token (ADMIN_TOKEN / Anya / health) that
  //       has no real users row — the validated token itself is the credential;
  //   (b) the server-CONFIGURED admin email (ADMIN_EMAIL/ADMIN_EMAILS).
  // A real user (users row) ALWAYS resolves from users.is_admin. A DB error or a
  // missing row FAILS CLOSED — we NEVER fall back to the token's role/is_admin
  // claim, or a demoted admin whose context DB read errors would still be admin.
  const syntheticServiceAdmin = isSyntheticServiceAdmin(user)
  try {
    // If we only have a profileId, resolve its owning user first.
    if (!ctx.userId && ctx.activeProfileId) {
      const profileRow = await db
        .prepare('SELECT user_id FROM profiles WHERE id = ?')
        .get(String(ctx.activeProfileId))
      if (profileRow?.user_id) ctx.userId = profileRow.user_id
    }

    if (syntheticServiceAdmin) {
      // Validated service token with no real user row — legitimate token admin.
      ctx.isAdmin = true
    } else if (ctx.userId && SYNTHETIC_SERVICE_ADMIN_USER_IDS.has(String(ctx.userId))) {
      // A synthetic service id arriving WITHOUT service-token provenance (e.g. a
      // JWT whose `sub` collides with system_admin_token) is an impersonation
      // attempt. Never admin — and do NOT honor the synthetic DB row that the real
      // service token's self-heal may have persisted (it's keyed by this id).
      ctx.isAdmin = false
    } else if (ctx.userId) {
      const row = await db
        .prepare('SELECT is_admin, primary_email FROM users WHERE id = ?')
        .get(String(ctx.userId))
      if (row) {
        ctx.isAdmin = Boolean(row.is_admin === true || row.is_admin === 1)
        // The configured-admin-email elevation is honored ONLY from the TRUSTED
        // stored email (row.primary_email), NEVER from the token-supplied
        // user.email — a JWT could otherwise carry the configured admin email and
        // self-promote (and this path even PERSISTS is_admin=TRUE). Hydrate
        // ctx.email from the row for downstream display, but decide on the DB email.
        const trustedEmail = row.primary_email ? String(row.primary_email).trim().toLowerCase() : null
        if (trustedEmail && !ctx.email) ctx.email = trustedEmail
        const dbEmailIsConfiguredAdmin = Boolean(trustedEmail && isAdminEmail(trustedEmail))

        // Configured admin email (from the DB row) whose flag isn't set: upgrade + persist.
        if (!ctx.isAdmin && dbEmailIsConfiguredAdmin) {
          ctx.isAdmin = true
          try {
            await db
              .prepare('UPDATE users SET is_admin = TRUE WHERE id = ? AND COALESCE(is_admin, FALSE) = FALSE')
              .run(ctx.userId)
          } catch (error) {
            console.warn('[requestContext] Failed to persist is_admin upgrade:', error?.message)
          }
        }
      } else {
        // Real user id but NO users row → FAIL CLOSED. A configured admin email
        // from a TOKEN is not trusted; only a validated service token elevates.
        ctx.isAdmin = false
      }
    } else {
      // No resolvable identity → not admin.
      ctx.isAdmin = false
    }
  } catch (error) {
    // FAIL CLOSED on DB error. Never trust the JWT role/is_admin/email claims. Only
    // a validated synthetic service token survives (its authority is the verified
    // token, not the DB).
    console.warn('[requestContext] Failed to resolve admin status from DB; failing closed:', error?.message)
    ctx.isAdmin = syntheticServiceAdmin
  }

  // Step 5: Compute accessible profiles and orgs
  if (ctx.isAdmin) {
    // Admin can access everything
    ctx.accessibleProfileIds = null
    ctx.accessibleOrgIds = null

    // Admin-only self-healing: ensure org profiles are shareable via organizations.email.
    // Best-effort and throttled.
    try {
      await adminSelfHealOrgProfileEmails(db, { actorUserId: ctx.userId ?? null, isAdmin: ctx.isAdmin })
    } catch {
      // ignore (best-effort)
    }
  } else {
    // Regular user - compute accessible resources.
    try {
      const profileIds = await getAccessibleProfileIds(db, user)
      const orgIds = await getAccessibleOrganizationIds(db, user)
      // SECURITY: ctx.isAdmin is FALSE here (a genuine non-admin, OR a fail-closed
      // admin resolution after a DB error). These helpers run their OWN admin
      // check and can independently return `null` (the ALL-ACCESS sentinel) — e.g.
      // if the earlier users lookup timed out but theirs succeeds. A non-admin
      // context must NEVER carry the null all-access sentinel, or consumers treat
      // it as admin and leak cross-tenant. Coerce any non-Set (null) result to an
      // empty Set = deny.
      ctx.accessibleProfileIds = profileIds instanceof Set ? profileIds : new Set()
      ctx.accessibleOrgIds = orgIds instanceof Set ? orgIds : new Set()
    } catch (error) {
      console.warn('[requestContext] Failed to compute accessible resources:', error?.message)
      ctx.accessibleProfileIds = new Set()
      ctx.accessibleOrgIds = new Set()
    }
  }

  // SECURITY: Never trust token-scoped activeProfileId blindly.
  // If the claimed activeProfileId is not in the DB-backed accessible set, drop it.
  // This prevents "profile bleed" across users when stale tokens/local storage carry an old profile id.
  if (!ctx.isAdmin && ctx.activeProfileId && ctx.accessibleProfileIds instanceof Set) {
    const active = String(ctx.activeProfileId)
    if (!ctx.accessibleProfileIds.has(active)) {
      const replacement = ctx.accessibleProfileIds.size > 0 ? Array.from(ctx.accessibleProfileIds)[0] : null
      console.warn('[requestContext] Invalid activeProfileId claim (not accessible); resetting', {
        userId: ctx.userId ?? null,
        email: ctx.email ?? null,
        claimedActiveProfileId: active,
        replacementActiveProfileId: replacement,
        accessibleProfileCount: ctx.accessibleProfileIds.size,
      })
      ctx.activeProfileId = replacement
    }
  }

  return ctx
}

/**
 * Express middleware to attach request context to req.ctx
 */
export function attachRequestContext() {
  return async (req, res, next) => {
    try {
      req.ctx = await buildRequestContext(req.db, req.user)
      // Attach db reference to ctx for convenience (single accessor pattern)
      req.ctx.db = req.db
      next()
    } catch (error) {
      console.error('[requestContext] Failed to build request context:', error)
      // Fail safe: provide guest context to avoid breaking the request
      req.ctx = {
        userId: null,
        email: null,
        isAdmin: false,
        activeProfileId: null,
        accessibleProfileIds: new Set(),
        accessibleOrgIds: new Set(),
        db: req.db, // Ensure db is always available
      }
      next()
    }
  }
}
