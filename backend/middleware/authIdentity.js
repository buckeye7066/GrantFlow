/**
 * Auth Identity Middleware
 *
 * Resolves req.user from incoming request headers/tokens in priority order:
 *   1. X-Admin-Token header (or BULK_POPULATE_KEY match)
 *   2. X-Anya-Token header (autonomous bot)
 *   3. Authorization: Bearer — admin/bulk token match
 *   4. Authorization: Bearer — Anya API key match
 *   5. Authorization: Bearer — stateless JWT verification + optional DB session enrichment
 *   6. Legacy admin token fallback (duplicate check after JWT block)
 *   7. Legacy profile-id bearer token (gated by ALLOW_LEGACY_PROFILE_TOKEN + non-prod)
 *
 * If no credentials match, req.user is set to { role: 'guest', profileId: null }.
 *
 * Usage:
 *   import { createAuthIdentityMiddleware } from './middleware/authIdentity.js'
 *   app.use(createAuthIdentityMiddleware({ adminToken, adminName, adminEmail, jwtSecret, db, isProd }))
 *
 * @module middleware/authIdentity
 */

import jwt from 'jsonwebtoken'
import { safeTokenEqual } from '../utils/safeTokenEqual.js'
import { createLogger } from '../utils/logger.js'
const qualityLog = createLogger('middleware:authIdentity')

// better-sqlite3 is synchronous; no Promise wrapper needed.
// If the DB handle is ever swapped for an async driver, update call sites directly.
function resolveDbMaybePromise(value) {
  return value
}

/**
 * Factory that returns an Express middleware which resolves req.user.
 *
 * @param {object} config
 * @param {string|null} config.adminToken  - Configured admin token (ADMIN_TOKEN / ANYA_ADMIN_TOKEN)
 * @param {string}      config.adminName   - Display name for synthetic admin users
 * @param {string}      config.adminEmail  - Email for synthetic admin users
 * @param {string}      config.jwtSecret   - JWT signing secret
 * @param {object}      config.db          - better-sqlite3 (or compatible) database handle
 * @param {boolean}     config.isProd      - Whether the app is running in production mode
 * @returns {import('express').RequestHandler}
 */
export function createAuthIdentityMiddleware({ adminToken, adminName, adminEmail, jwtSecret, db, isProd }) {
  return async function authIdentityMiddleware(req, _res, next) {
    const authHeader = req.headers.authorization || ''
    const xAdminToken = req.headers['x-admin-token']
    const xAnyaToken = req.headers['x-anya-token']
    const xHealthToken = req.headers['x-admin-health-token']
    let user = { role: 'guest', profileId: null }
    let handled = false

    const expectedAdminToken = adminToken
    const expectedBulkKey = process.env.BULK_POPULATE_KEY || null
    const anyaApiKey = process.env.ANYA_API_KEY || null
    const healthToken = process.env.ADMIN_HEALTH_TOKEN || null

    // 0. Health-check service token — READ-ONLY scope.
    // Accepted only on GET/HEAD/OPTIONS so a stolen token cannot mutate data.
    // Admitted as a synthetic read-only admin so admin-gated diagnostics routes pass.
    if (
      !handled &&
      safeTokenEqual(xHealthToken, healthToken) &&
      ['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())
    ) {
      user = {
        role: 'health_check',
        is_admin: true,
        // serviceToken PROVENANCE (set ONLY in a safeTokenEqual branch): required
        // by isSyntheticServiceAdmin so a JWT with a colliding synthetic `sub`
        // cannot be treated as a service admin.
        serviceToken: true,
        readonly: true,
        scope: 'health_check',
        userId: 'system_health_token',
        profileId: null,
        full_name: 'Health Checker',
        email: 'health@grantflow.app',
      }
      handled = true
    }

    // 1. Check X-Admin-Token
    if (
      !handled &&
      xAdminToken &&
      (safeTokenEqual(xAdminToken, expectedAdminToken) ||
        safeTokenEqual(xAdminToken, expectedBulkKey))
    ) {
      user = {
        role: 'admin',
        // Canonical admin is DB-backed via req.ctx. We still mark this token flow as admin,
        // but requestContext will resolve the final answer from users.is_admin.
        is_admin: true,
        serviceToken: true,
        // Deterministic userId so we can back it with a real DB user row (users.is_admin = true).
        userId: 'system_admin_token',
        profileId: null,
        full_name: adminName,
        email: adminEmail,
      }
      handled = true
    }

    // 2. Check X-Anya-Token (autonomous bot)
    if (!handled && xAnyaToken && safeTokenEqual(xAnyaToken, anyaApiKey)) {
      user = {
        role: 'admin',
        is_admin: true,
        serviceToken: true,
        userId: 'system_anya_token',
        profileId: null,
        full_name: 'Anya Assistant',
        email: 'anya@grantflow.app',
      }
      handled = true
    }

    // 3. Check Authorization Bearer token
    if (!handled && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim()
      if (token) {
        // 3a. Accept admin/bulk tokens via Authorization header for frontend/dev compatibility.
        // This does NOT expand the trust boundary; these same tokens are already accepted via X-Admin-Token.
        if (
          safeTokenEqual(token, expectedAdminToken) ||
          safeTokenEqual(token, expectedBulkKey)
        ) {
          user = {
            role: 'admin',
            is_admin: true,
            serviceToken: true,
            userId: 'system_admin_token',
            profileId: null,
            full_name: adminName,
            email: adminEmail,
          }
          handled = true
        }

        // 3b. Allow the Anya API key to authenticate via Authorization bearer as well.
        if (!handled && safeTokenEqual(token, anyaApiKey)) {
          user = {
            role: 'admin',
            is_admin: true,
            serviceToken: true,
            userId: 'system_anya_token',
            profileId: null,
            full_name: 'Anya Assistant',
            email: 'anya@grantflow.app',
          }
          handled = true
        }

        // 3c. Stateless JWT verification + optional DB session enrichment
        if (!handled) {
          try {
            // Pin the algorithm: all GrantFlow tokens are HS256 (symmetric
            // secret). Prevents algorithm-confusion if an asymmetric key is
            // ever introduced into the environment.
            const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] })
            // Stateless JWT acceptance (important for multi-instance deployments where SQLite session storage
            // is not shared across instances). If the token is correctly signed and unexpired, trust its claims.
            // We still try to validate against DB sessions when available, but we do not require it.
            let tokenRoles = []
            let tokenIsAdmin = false
            let tokenEmail = null
            let tokenName = null

            if (payload && typeof payload === 'object') {
              tokenRoles = Array.isArray(payload.roles) ? payload.roles : []
              tokenIsAdmin = tokenRoles.includes('admin')
              tokenEmail = payload.email ?? null
              tokenName = payload.name ?? null

              if (payload.sub) {
                user = {
                  role: tokenIsAdmin ? 'admin' : 'user',
                  is_admin: Boolean(tokenIsAdmin),
                  userId: payload.sub,
                  profileId: payload.profile_id ?? null,
                  sessionId: payload.sid ?? null,
                  full_name: tokenName,
                  email: tokenEmail,
                  roles: tokenRoles,
                }
                handled = true
              } else {
                // JWT verified but has no sub â treat as guest to avoid identity confusion
                user = { role: 'guest', profileId: null }
                handled = true
              }
            }

            // Best-effort DB session validation/enrichment (when sessions are stored locally).
            if (payload?.sid) {
              let sessionRow
              try {
                const stmt = db.prepare(`
                  SELECT s.*, u.display_name, u.primary_email, u.is_admin
                  FROM user_sessions s
                  JOIN users u ON u.id = s.user_id
                  WHERE s.id = ?
                `)
                sessionRow = await resolveDbMaybePromise(stmt.get(payload.sid))
              } catch (error) {
                console.warn('Failed to validate session:', error?.message || error)
                if (error?.code === 'SQLITE_CORRUPT' || error?.code === 'ECONNRESET') {
                  // Critical DB errors: fail auth completely and stop processing immediately.
                  qualityLog.error('[authIdentity] Critical DB error during session validation:', error?.code, error?.message)
                  // Preserve the JWT-derived identity that was already set before DB enrichment was
                  // attempted. Demoting to guest here discards a verified JWT claim without audit trail.
                  // Keep the user object that was set from the valid JWT (handled is already true)
                  // and let the request continue with token-only identity rather than a silent guest demotion.
                  req.user = user
                  return next()
                }
                // Non-critical: continue with token-only authentication (handled already set)
              }
              if (
                sessionRow &&
                !sessionRow.revoked_at &&
                (!sessionRow.refresh_expires_at || new Date(sessionRow.refresh_expires_at) > new Date())
              ) {
                // Admin is DB-backed: users.is_admin.
                // Never downgrade admin if the token already claims it (e.g. admin token, DB lag).
                const effectiveIsAdmin = Boolean(tokenIsAdmin || sessionRow.is_admin)
                user = {
                  role: effectiveIsAdmin ? 'admin' : 'user',
                  is_admin: effectiveIsAdmin,
                  userId: sessionRow.user_id,
                  profileId: payload.profile_id ?? sessionRow.profile_id ?? null,
                  sessionId: sessionRow.id,
                  full_name: sessionRow.display_name ?? tokenName ?? null,
                  email: sessionRow.primary_email ?? tokenEmail ?? null,
                  roles: tokenRoles,
                }
                handled = true
              }
            }
          } catch (jwtErr) {
            // JWT verification failed (expired, bad signature, malformed).
            // Log for audit trail but do NOT set handled=true so legacy paths can still run.
            console.warn('[authIdentity] JWT verification failed:', jwtErr?.message || jwtErr)
          }
        }

        // 3d. (Intentionally removed â admin/bulk token check already handled in 3a.
        //      Keeping a duplicate branch here creates a false sense of fallback
        //      and risks divergence if 3a is ever modified.)

        // 3e. Legacy "profile-id bearer token" is unsafe; allow only in non-prod with explicit opt-in.
        //
        // ALLOW_LEGACY_PROFILE_TOKEN must be set to 'true' and the server must NOT be in production
        // mode for this path to be active. This gate must never be removed.
        const allowLegacyProfileToken =
          isProd === false &&
          String(process.env.ALLOW_LEGACY_PROFILE_TOKEN || '')
            .trim()
            .toLowerCase() === 'true'

        if (!handled && allowLegacyProfileToken) {
          // Guard: only attempt lookup if token looks like a UUID (not a JWT)
          const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          if (UUID_RE.test(token)) {
            try {
              const stmt = db.prepare('SELECT id, display_name FROM profiles WHERE id = ?')
              const profile = await resolveDbMaybePromise(stmt.get(token))
              if (profile) {
                user = {
                  role: 'user',
                  userId: profile.id,   // required for audit trails and Anya grounding
                  profileId: profile.id,
                  profileName: profile.display_name,
                }
                handled = true
              }
            } catch (error) {
              console.warn('Legacy profile token lookup failed:', error?.message || error)
            }
          }
        }
      }
    }

    req.user = user
    next()
  }
}
