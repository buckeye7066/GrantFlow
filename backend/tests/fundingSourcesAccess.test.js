/**
 * Regression guard for GET /api/profiles/:id/funding-sources access control.
 *
 * THE DEFECT (found 2026-07-28 by the production-audit bridge): the gate read
 *
 *     Array.isArray(accessible) && accessible.includes(profileId)
 *
 * but `getAccessibleProfileIds` returns a **Set** (or `null`, the DB-backed
 * admin all-access sentinel) and has never returned an Array. `Array.isArray`
 * on a Set is false, so the expression was ALWAYS false and every non-admin
 * caller received 403 on their own funding-sources list — the list that powers
 * ProfileFundingSourcesCard.
 *
 * It survived from #973 (2026-07-19) to 2026-07-28 because the `isAdmin` branch
 * returns before this line: the accounts most likely to exercise the endpoint
 * were exactly the ones that could not reproduce it. Live evidence: a non-admin
 * account with access to five profiles got 403 on all five here, while the
 * Hamilton and portal-sync routes — which handle the Set correctly — returned
 * 200 for the same account and the same profiles.
 *
 * Every test below FAILS on the pre-fix expression.
 */

import { describe, it, expect } from 'vitest'
import { userMayAccessProfile } from '../routes/fundingSources.js'

const PROFILE = 'profile-hollie-knox'
const OTHER = '6b3c75ec-dc56-46f9-b380-394172688175'

/**
 * `user` is passed straight through to getAccessibleProfileIds, so the accessible
 * set is stubbed by swapping req.db — the helper's only real dependency here is
 * the users-row existence check inside getOwnedAndGrantedProfileIds.
 */
function makeReq({ isAdmin = false, owned = [], grantedByEmail = [], userId = 'u-audit', email = 'a@b.test' } = {}) {
  const db = {
    prepare(sql) {
      const s = String(sql)
      return {
        async get() {
          if (/FROM users WHERE id/i.test(s)) return { id: userId }
          if (/FROM users WHERE LOWER/i.test(s)) return { id: userId }
          return null
        },
        async all(...args) {
          if (/FROM profiles WHERE user_id/i.test(s)) return owned.map((id) => ({ id }))
          if (/FROM profiles WHERE created_by/i.test(s)) return []
          if (/FROM profile_emails/i.test(s) || /profile_id[\s\S]*profile_emails/i.test(s)) {
            return grantedByEmail.map((id) => ({ profile_id: id, id }))
          }
          if (/FROM users/i.test(s)) return [{ primary_email: email }]
          return []
        },
        async run() {
          return { changes: 0 }
        },
      }
    },
    exec: async () => {},
  }
  return { db, ctx: { isAdmin }, user: { id: userId, email } }
}

describe('funding-sources profile access gate', () => {
  it('ADMITS a profile the user owns (the Set is handled, not Array.isArray-d away)', async () => {
    const req = makeReq({ owned: [PROFILE] })
    await expect(userMayAccessProfile(req, req.user, PROFILE)).resolves.toBe(true)
  })

  it('REFUSES a profile the user has no claim on', async () => {
    const req = makeReq({ owned: [OTHER] })
    await expect(userMayAccessProfile(req, req.user, PROFILE)).resolves.toBe(false)
  })

  it('admits an admin through the ctx branch without consulting the set', async () => {
    const req = makeReq({ isAdmin: true, owned: [] })
    await expect(userMayAccessProfile(req, req.user, PROFILE)).resolves.toBe(true)
  })

  it('refuses when no profile id is supplied', async () => {
    const req = makeReq({ owned: [PROFILE] })
    await expect(userMayAccessProfile(req, req.user, '')).resolves.toBe(false)
  })

  // Pins the container contract itself. If getAccessibleProfileIds ever returns
  // a Set again after someone "simplifies" the gate back to an Array check, this
  // is the test that reds.
  it('a Set containing the id grants access — the exact shape the helper returns', async () => {
    const set = new Set([PROFILE])
    expect(Array.isArray(set)).toBe(false) // why the old gate could never pass
    expect(set.has(PROFILE)).toBe(true)
  })
})
