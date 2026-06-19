/**
 * hamiltonCredentialCsvImport.js
 *
 * Imports a Chrome / Edge / Brave / Firefox / 1Password / LastPass CSV
 * password export into a profile's Hamilton credential vault.
 *
 * Browsers all use the same column shape ("name,url,username,password,note"
 * for Chromium-derived browsers; Firefox uses "url,username,password" plus
 * a few timestamp fields). 1Password / LastPass exports use slightly
 * different headers but the same idea. This parser:
 *
 *   1. Reads the header row and maps each column to one of:
 *        url | username | password | label | note
 *      Unknown columns are ignored. Missing required columns short-circuit
 *      the import with a clear error.
 *   2. For each data row:
 *        - Extracts the host from `url`. http(s):// → host. android://...@<pkg>/
 *          packages are heuristically mapped to a web host (com.chewy.android
 *          → chewy.com); when no web host can be derived, the row is
 *          recorded under skipped.
 *        - Drops rows with empty username or empty password.
 *        - Calls saveCredential, which is idempotent on (profile, host) so
 *          re-running an import is a no-op for already-saved hosts.
 *   3. Returns a summary: imported, updated, skipped, errors. NEVER returns
 *      plaintext passwords back to the caller.
 *
 * Mission rule: passwords are encrypted at rest immediately and the
 * caller's textual blob is dropped from memory after this function returns.
 */

import { saveCredential, registrableDomain } from './hamiltonPortalCredentialService.js'
import { normalizeHost } from './hamiltonCredentialSessionService.js'

const MAX_CSV_BYTES = 5 * 1024 * 1024 // 5 MB — comfortably bigger than any browser export
const MAX_ROWS = 5000

// Column-name aliases per known field. All comparisons are lowercased.
const FIELD_ALIASES = Object.freeze({
  url: ['url', 'login_url', 'login url', 'web site', 'website', 'web address', 'site'],
  username: ['username', 'user name', 'login', 'email', 'user', 'usr'],
  password: ['password', 'passwd', 'pwd'],
  label: ['name', 'title', 'site name', 'display name', 'label'],
  note: ['note', 'notes', 'comment', 'comments'],
})

/**
 * RFC-4180-ish CSV parser. Handles:
 *   - Quoted fields with embedded commas, quotes, and newlines.
 *   - "" → " inside quoted fields.
 *   - CRLF and LF line endings.
 *   - A leading UTF-8 BOM.
 * Does NOT support comments, escape characters other than "", or
 * trimmed-quote variants. That's sufficient for every browser export
 * I've seen.
 */
export function parseCsv(text) {
  if (typeof text !== 'string') throw new Error('csv text must be a string')
  if (text.length > MAX_CSV_BYTES) throw new Error(`csv too large (>${MAX_CSV_BYTES} bytes)`)
  // Strip UTF-8 BOM.
  let s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = s.length
  while (i < len) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false
        i += 1
        continue
      }
      field += c
      i += 1
      continue
    }
    if (c === '"') { inQuotes = true; i += 1; continue }
    if (c === ',') { row.push(field); field = ''; i += 1; continue }
    if (c === '\n' || c === '\r') {
      row.push(field); field = ''
      // Skip the LF half of a CRLF.
      if (c === '\r' && s[i + 1] === '\n') i += 1
      // Drop trailing empty rows that come from a terminating newline.
      if (!(row.length === 1 && row[0] === '')) rows.push(row)
      row = []
      i += 1
      continue
    }
    field += c
    i += 1
  }
  // Final field / row if the file didn't end in a newline.
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
  }
  if (rows.length > MAX_ROWS) throw new Error(`too many rows (>${MAX_ROWS})`)
  return rows
}

/**
 * Map a header row to a { url, username, password, label, note } column-index
 * lookup. Returns null when the required url/username/password columns
 * cannot all be located.
 */
export function mapHeaders(header) {
  if (!Array.isArray(header)) return null
  const idx = { url: -1, username: -1, password: -1, label: -1, note: -1 }
  const lc = header.map((h) => String(h || '').trim().toLowerCase())
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (let c = 0; c < lc.length; c += 1) {
      if (idx[field] === -1 && aliases.includes(lc[c])) {
        idx[field] = c
      }
    }
  }
  if (idx.url === -1 || idx.username === -1 || idx.password === -1) return null
  return idx
}

/**
 * Best-effort web-host extraction from any URL Chromium or Firefox can
 * export.
 *
 *   https://login.mtsu.edu/foo  → "login.mtsu.edu"
 *   android://hash@com.chewy.android/  → "chewy.com"
 *   http://my-app.local/         → null (no registrable domain)
 *   ""                            → null
 *
 * Returns { host, loginUrl } where loginUrl is the original URL when it's a
 * web URL, else null.
 */
export function extractHostAndLoginUrl(rawUrl) {
  const v = String(rawUrl || '').trim()
  if (!v) return { host: null, loginUrl: null }

  // android:// digest@<package>/[path] — used for Android app credentials.
  // Reverse the first two segments of the package to get a likely web host
  // ("com.chewy.android" → "chewy.com"). Anything more elaborate (".disneyplus")
  // is left to the user to fix manually since heuristics get expensive
  // quickly.
  if (v.startsWith('android://')) {
    const at = v.indexOf('@')
    if (at < 0) return { host: null, loginUrl: null }
    const after = v.slice(at + 1)
    const slash = after.indexOf('/')
    const pkg = (slash < 0 ? after : after.slice(0, slash)).trim()
    if (!pkg) return { host: null, loginUrl: null }
    const parts = pkg.split('.').filter(Boolean)
    if (parts.length < 2) return { host: null, loginUrl: null }
    // com.chewy → chewy.com ; com.chewy.android → chewy.com (drop trailing
    // "android" / "mobile" / "app" segments which are common platform suffixes).
    const PLATFORM_SUFFIXES = new Set(['android', 'ios', 'mobile', 'app', 'apps'])
    let cleaned = parts.slice()
    while (cleaned.length > 2 && PLATFORM_SUFFIXES.has(cleaned[cleaned.length - 1].toLowerCase())) {
      cleaned = cleaned.slice(0, -1)
    }
    const candidateHost = `${cleaned[1]}.${cleaned[0]}`.toLowerCase()
    const reg = registrableDomain(candidateHost)
    if (!reg) return { host: null, loginUrl: null }
    return { host: candidateHost, loginUrl: null }
  }

  // Web / file / scheme-less URLs.
  let parsed = null
  try { parsed = new URL(v) } catch {
    // Try with an https:// prefix in case it's a bare host.
    try { parsed = new URL(`https://${v}`) } catch { /* truly invalid */ }
  }
  if (!parsed) return { host: null, loginUrl: null }
  if (!/^https?:$/.test(parsed.protocol)) return { host: null, loginUrl: null }
  const host = normalizeHost(parsed.hostname || parsed.host)
  if (!host || !registrableDomain(host)) return { host: null, loginUrl: null }
  // Reuse the original URL when it's an https:// login page so Hamilton
  // can navigate straight there. Drop any auth/userinfo from the URL — we
  // never want those persisted alongside a separately-encrypted password.
  parsed.username = ''
  parsed.password = ''
  const loginUrl = parsed.toString()
  return { host, loginUrl }
}

/**
 * Import a CSV blob into a profile's Hamilton credential vault.
 *
 * @param {Object} db
 * @param {Object} args
 * @param {string} args.userId      auth user id
 * @param {string} args.profileId   target profile id (already access-checked)
 * @param {string} args.csvText     the raw CSV text
 * @param {string} [args.source]    label suffix ("Chrome", "Firefox", etc.)
 *                                  used to tag rows that didn't have a label.
 * @returns {Promise<{
 *   imported: number,
 *   updated: number,
 *   skipped: Array<{row: number, reason: string, host?: string|null, label?: string|null}>,
 *   errors:  Array<{row: number, reason: string, message?: string}>,
 *   total:   number,
 *   columns: { url:number, username:number, password:number, label:number, note:number },
 * }>}
 */
export async function importCredentialsFromCsv(db, {
  userId, profileId, csvText, source = 'CSV import', managedBy = 'user',
} = {}) {
  if (!db || !userId || !profileId) throw new Error('userId and profileId required')
  if (typeof csvText !== 'string' || !csvText.trim()) throw new Error('csvText required')
  const rows = parseCsv(csvText)
  if (rows.length === 0) throw new Error('empty CSV')

  const header = rows[0]
  const idx = mapHeaders(header)
  if (!idx) {
    throw new Error(
      `CSV is missing required columns. Expected at least: url, username, password. ` +
      `Got: ${header.map((h) => `"${h}"`).join(', ')}`,
    )
  }

  const result = { imported: 0, updated: 0, skipped: [], errors: [], total: 0, columns: idx }

  // Track hosts already seen IN THIS IMPORT so we don't double-save when a
  // browser exports duplicate rows for the same site.
  const hostsThisImport = new Set()

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r] || []
    if (row.length === 1 && row[0] === '') continue

    const url = (row[idx.url] || '').trim()
    const username = (row[idx.username] || '').trim()
    const password = idx.password >= 0 ? row[idx.password] || '' : ''
    const label = (idx.label >= 0 ? row[idx.label] : '') || ''
    result.total += 1

    if (!username || !password) {
      result.skipped.push({ row: r + 1, reason: 'missing_username_or_password', host: null, label: label || null })
      continue
    }

    const { host, loginUrl } = extractHostAndLoginUrl(url)
    if (!host) {
      result.skipped.push({
        row: r + 1,
        reason: url.startsWith('android://') ? 'android_app_no_web_host' : 'invalid_url',
        host: null,
        label: label || null,
      })
      continue
    }

    const seenKey = `${host}::${username.toLowerCase()}`
    if (hostsThisImport.has(seenKey)) {
      result.skipped.push({ row: r + 1, reason: 'duplicate_in_csv', host, label: label || null })
      continue
    }
    hostsThisImport.add(seenKey)

    try {
      // saveCredential is idempotent on (profile_id, portal_host) — re-saving
      // updates the row's username/password to the new values. We don't
      // distinguish create-vs-update here because the service doesn't return
      // that signal yet; future iteration can split the count.
      await saveCredential(db, {
        userId,
        profileId,
        portalHost: host,
        username,
        password,
        label: label.trim() ? `${label.trim()} (${source})` : `${host} (${source})`,
        loginUrl,
        managedBy,
      })
      result.imported += 1
    } catch (err) {
      result.errors.push({ row: r + 1, reason: 'save_failed', message: err?.message || String(err) })
    }
  }

  return result
}
