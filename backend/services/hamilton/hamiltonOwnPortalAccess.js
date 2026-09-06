/**
 * hamiltonOwnPortalAccess.js — does Hamilton have a WAY IN to the student's own
 * institution's scholarship portal, and if not, what exactly is missing?
 *
 * Owner order 2026-09-05 ("Hamilton needs to be able to submit to portal e2e
 * in spite of captcha etc." / "ask for these upon user login, and safely store
 * them in the vault to use"). Live case: four MTSU scholarships were re-routed
 * to the PipelineMT scholarship portal (#1571). With no saved session, no
 * portal credential and no University SSO in the vault, the engine opened the
 * portal's PUBLIC landing page (the General Application sits behind the school
 * SSO) and ended "found no application form" — a dead end that named nothing
 * the person could fix. The honest state is a LOGIN wall: park as
 * waiting_for_login with the portal's login hint, queue the sign-in-once
 * capture, and ask for the vault kinds by name.
 *
 * Pure: no db, no browser. The orchestrator hands it what it already resolved
 * (credential, saved session, vault kinds) and gets back either null (a way in
 * exists, launch the browser) or the blocker to synthesize.
 */

/** The vault kinds a registered portal signs in with (registry default). */
const DEFAULT_SSO_KINDS = Object.freeze(['sso_username', 'sso_password'])

function kindsFor(ownPortal) {
  const kinds = Array.isArray(ownPortal?.vault_kinds) ? ownPortal.vault_kinds.filter(Boolean) : []
  return kinds.length > 0 ? kinds : [...DEFAULT_SSO_KINDS]
}

/**
 * Build the engine login credential from the identity vault's University SSO
 * pair, scoped to the portal host so the engine's origin check still holds.
 * Returns null unless BOTH halves are on file and non-empty.
 */
export function ssoCredentialFromVault({ ownPortal = null, identityValues = null } = {}) {
  if (!ownPortal || !identityValues || typeof identityValues !== 'object') return null
  const rawUsername = identityValues.sso_username
  const password = identityValues.sso_password
  if (!rawUsername || !password) return null
  // A school IdP signs students in by UPN ("username@mtmail.mtsu.edu"); a
  // bare portal username typed there is "We couldn't find an account". The
  // registry names the domain; a username that already carries one is kept.
  let username = String(rawUsername).trim()
  const upnDomain = String(ownPortal.sso_username_domain || '').trim().replace(/^@/, '')
  if (upnDomain && !username.includes('@')) username = `${username}@${upnDomain}`
  return {
    username,
    password: String(password),
    portal_host: ownPortal.portal_host || null,
    // Every host the engine may type this pair into: the portal itself plus
    // the identity providers its sign-in button hops through. The engine's
    // origin check (attemptLogin) reads this list; a host outside it never
    // sees the credential.
    allowed_hosts: [ownPortal.portal_host, ...(Array.isArray(ownPortal.idp_hosts) ? ownPortal.idp_hosts : [])].filter(Boolean),
    source: 'identity_vault_sso',
    institution: ownPortal.institution || null,
  }
}

/**
 * Decide whether a registered institution portal can be entered.
 *
 * @returns {null | { blocker_kind: 'login', blocker_detail: string, missing_kinds: string[], credential_use_unauthorized: boolean }}
 *   null  → not an own-institution portal, or a way in exists (saved session,
 *           portal credential, or the vault SSO pair under credential consent).
 *   object → synthesize this blocker instead of launching the browser.
 */
export function resolveOwnPortalAccess({
  ownPortal = null,
  loginCredential = null,
  storageState = null,
  vaultKinds = [],
  credentialUseAuthorized = false,
} = {}) {
  if (!ownPortal) return null
  if (storageState) return null
  if (loginCredential?.username && loginCredential?.password) return null
  const needed = kindsFor(ownPortal)
  const onFile = new Set((Array.isArray(vaultKinds) ? vaultKinds : []).map((k) => String(k?.kind ?? k)))
  const missing = needed.filter((k) => !onFile.has(k))
  const institution = ownPortal.institution || 'the student’s institution'
  const hint = ownPortal.login_hint ? ` — ${ownPortal.login_hint}` : ''
  if (missing.length === 0) {
    if (credentialUseAuthorized) return null
    return {
      blocker_kind: 'login',
      blocker_detail: `${institution}’s scholarship portal needs the University SSO login that is already in the identity vault, but saved-credential use is not authorized for this run. Authorize Hamilton to use saved logins (or sign in once side-by-side) and he resumes${hint}`,
      missing_kinds: [],
      credential_use_unauthorized: true,
    }
  }
  return {
    blocker_kind: 'login',
    blocker_detail: `${institution}’s scholarship portal sits behind the school login and Hamilton holds no saved session, no portal login, and no University SSO in the identity vault (missing: ${missing.join(', ')}). Hamilton did not open the browser${hint}`,
    missing_kinds: missing,
    credential_use_unauthorized: false,
  }
}

export default { resolveOwnPortalAccess, ssoCredentialFromVault }
