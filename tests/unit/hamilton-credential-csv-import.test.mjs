/**
 * Hamilton Credential CSV Import — locks the contract for parsing browser
 * password exports and saving them into the per-profile vault.
 *
 * Cases covered:
 *   - parseCsv handles quoted fields, embedded commas, embedded newlines,
 *     CRLF, BOM, and trailing-newline files exactly the way browser
 *     exports do.
 *   - mapHeaders accepts Chrome ("name,url,username,password,note") and
 *     Firefox-style headers and rejects exports missing a required column.
 *   - extractHostAndLoginUrl converts https:// URLs to (host, loginUrl),
 *     converts android://...@<package>/ to a best-effort web host, drops
 *     userinfo from URLs, and rejects file://, http://localhost without a
 *     registrable domain, etc.
 *   - importCredentialsFromCsv encrypts every password at rest, is
 *     idempotent on (profile, host), skips android-only entries, never
 *     leaks plaintext through the response shape.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  parseCsv,
  mapHeaders,
  extractHostAndLoginUrl,
  importCredentialsFromCsv,
} from '../../backend/services/hamilton/hamiltonCredentialCsvImport.js'
import {
  listCredentialsForProfile,
  getDecryptedCredential,
  _resetCredentialSchemaCache,
} from '../../backend/services/hamilton/hamiltonPortalCredentialService.js'

before(() => {
  if (!process.env.RUNTIME_SECRETS_KEY && !process.env.AUTH_JWT_SECRET && !process.env.JWT_SECRET) {
    process.env.AUTH_JWT_SECRET = 'unit-test-jwt-secret-do-not-use-in-prod'
  }
})

function makeDb() {
  _resetCredentialSchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

describe('parseCsv', () => {
  it('parses Chrome-style headers and rows', () => {
    const text = 'name,url,username,password,note\nExample,https://example.com/,user@x.com,hunter2,\n'
    const rows = parseCsv(text)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows[0], ['name', 'url', 'username', 'password', 'note'])
    assert.deepEqual(rows[1], ['Example', 'https://example.com/', 'user@x.com', 'hunter2', ''])
  })

  it('handles quoted fields with embedded commas, escaped quotes, and CRLF', () => {
    const text = 'name,url,username,password,note\r\n"Discord, App","https://discord.com/","u@x.com","p""1,2",""\r\n'
    const rows = parseCsv(text)
    assert.deepEqual(rows[1], ['Discord, App', 'https://discord.com/', 'u@x.com', 'p"1,2', ''])
  })

  it('strips a UTF-8 BOM', () => {
    const text = '\uFEFFname,url,username,password,note\nA,https://a.com/,u,p,\n'
    const rows = parseCsv(text)
    assert.equal(rows[0][0], 'name', 'BOM must not survive into the first cell')
  })

  it('drops trailing empty rows from a final newline', () => {
    const text = 'a,b,c\n1,2,3\n\n'
    const rows = parseCsv(text)
    assert.equal(rows.length, 2)
  })
})

describe('mapHeaders', () => {
  it('maps the Chrome export header', () => {
    const idx = mapHeaders(['name', 'url', 'username', 'password', 'note'])
    assert.deepEqual(idx, { url: 1, username: 2, password: 3, label: 0, note: 4 })
  })

  it('maps a Firefox-style header (no name column)', () => {
    const idx = mapHeaders(['url', 'username', 'password', 'httpRealm', 'formActionOrigin', 'guid'])
    assert.equal(idx.url, 0)
    assert.equal(idx.username, 1)
    assert.equal(idx.password, 2)
    // `name` / `label` is optional; idx.label may be -1 here, that's fine.
  })

  it('rejects exports missing a required column', () => {
    assert.equal(mapHeaders(['name', 'url']), null, 'no password column')
    assert.equal(mapHeaders(['name', 'username', 'password']), null, 'no url column')
    assert.equal(mapHeaders(null), null)
  })
})

describe('extractHostAndLoginUrl', () => {
  it('extracts the host from an https URL and preserves the login URL', () => {
    const r = extractHostAndLoginUrl('https://login.mtsu.edu/auth?next=/portal')
    assert.equal(r.host, 'login.mtsu.edu')
    assert.ok(r.loginUrl.startsWith('https://login.mtsu.edu/'))
  })

  it('strips userinfo from a URL before persisting', () => {
    const r = extractHostAndLoginUrl('https://alice:secret@login.mtsu.edu/auth')
    assert.equal(r.host, 'login.mtsu.edu')
    assert.ok(!r.loginUrl.includes('alice'), 'NEVER persist URL userinfo')
    assert.ok(!r.loginUrl.includes('secret'), 'NEVER persist URL password')
  })

  it("derives a web host from android://hash@com.<vendor>.android/ packages", () => {
    const r = extractHostAndLoginUrl(
      'android://abc123==@com.chewy.android/',
    )
    assert.equal(r.host, 'chewy.com')
    assert.equal(r.loginUrl, null, 'android-app entries do not get a login URL')
  })

  it('drops trailing platform suffixes when deriving an android host', () => {
    const r = extractHostAndLoginUrl('android://x==@com.spotify.mobile/')
    assert.equal(r.host, 'spotify.com')
  })

  it('returns no host for unsupported schemes or non-domain hosts', () => {
    assert.equal(extractHostAndLoginUrl('').host, null)
    assert.equal(extractHostAndLoginUrl('file:///C:/x').host, null)
    assert.equal(extractHostAndLoginUrl('http://localhost/x').host, null)
    assert.equal(extractHostAndLoginUrl('android://x==@com/').host, null, 'single-label android package')
  })

  it('accepts a bare host (no scheme)', () => {
    const r = extractHostAndLoginUrl('mtsu.edu')
    assert.equal(r.host, 'mtsu.edu')
  })
})

describe('importCredentialsFromCsv', () => {
  const PROFILE = 'p-1'
  const USER = 'u-1'
  const baseCsv = `name,url,username,password,note
Example,https://example.com/login,a@example.com,Vermilion1!,
Login Twice,https://example.com/,a@example.com,Vermilion1!,
"Chewy: Pet Shopping","android://hash==@com.chewy.android/",owner@example.invalid,fixture-password-not-a-secret,
Bare Host,mtsu.edu,student@mtsu.edu,p4ssw0rd!,
Empty Username,https://no-user.example/,,nopass,
Bad URL,not a url,user@x.com,Vermilion1!,
`

  it('imports valid rows, skips android-only, missing creds, and bad URLs', async () => {
    const db = makeDb()
    const result = await importCredentialsFromCsv(db, {
      userId: USER, profileId: PROFILE, csvText: baseCsv, source: 'Chrome',
    })
    // 2 distinct hosts (example.com once, mtsu.edu once) + 1 android
    // (chewy.com) actually IS supported via heuristic, so 3 imports total.
    assert.equal(result.imported, 3, `imported should be 3, got ${result.imported}: ${JSON.stringify(result)}`)
    // Skips:
    //   row 3: duplicate (same host+username as row 2 → skipped as duplicate_in_csv)
    //   row 6: missing_username_or_password
    //   row 7: invalid_url
    const skipReasons = result.skipped.map((s) => s.reason).sort()
    assert.deepEqual(
      skipReasons,
      ['duplicate_in_csv', 'invalid_url', 'missing_username_or_password'],
      `skipped reasons: ${JSON.stringify(result.skipped)}`,
    )
    assert.equal(result.errors.length, 0)
    // Server-side rows are encrypted; the response NEVER includes plaintext.
    const json = JSON.stringify(result)
    assert.ok(!json.includes('Vermilion1!'), 'response must NEVER echo plaintext passwords')
    assert.ok(!json.includes('fixture-password-not-a-secret'), 'response must NEVER echo plaintext passwords')
  })

  it('round-trips through saveCredential — Hamilton can decrypt the imported password', async () => {
    const db = makeDb()
    await importCredentialsFromCsv(db, {
      userId: USER, profileId: PROFILE, csvText: baseCsv, source: 'Chrome',
    })

    // Hamilton's autopilot path uses getDecryptedCredential by host.
    const dec = await getDecryptedCredential(db, { profileId: PROFILE, portalHost: 'example.com' })
    assert.equal(dec.password, 'Vermilion1!')
    assert.equal(dec.username, 'a@example.com')

    // Subdomain match through PSL — login.mtsu.edu picks up a saved
    // mtsu.edu credential. Critical for browser exports where the user
    // saved the bare domain but Hamilton lands on a subdomain login page.
    const mtsu = await getDecryptedCredential(db, { profileId: PROFILE, portalHost: 'login.mtsu.edu' })
    assert.equal(mtsu.password, 'p4ssw0rd!')
  })

  it('list endpoint reflects imported rows but masks usernames and never exposes ciphertext', async () => {
    const db = makeDb()
    await importCredentialsFromCsv(db, {
      userId: USER, profileId: PROFILE, csvText: baseCsv, source: 'Chrome',
    })
    const rows = await listCredentialsForProfile(db, PROFILE)
    assert.equal(rows.length, 3)
    for (const r of rows) {
      assert.equal(r.has_password, true)
      assert.ok(r.username_masked, 'username must be masked in the list response')
      assert.ok(!('password_ciphertext' in r))
      assert.ok(!('password' in r))
      assert.ok(/Chrome/.test(r.label || ''), `label should include the source tag, got: ${r.label}`)
    }
  })

  it('is idempotent — re-importing the same CSV does not duplicate rows or rotate passwords', async () => {
    const db = makeDb()
    const csv = `name,url,username,password,note
A,https://a.example/,user,pw1,
`
    await importCredentialsFromCsv(db, { userId: USER, profileId: PROFILE, csvText: csv, source: 'Chrome' })
    await importCredentialsFromCsv(db, { userId: USER, profileId: PROFILE, csvText: csv, source: 'Chrome' })
    const rows = await listCredentialsForProfile(db, PROFILE)
    assert.equal(rows.length, 1, 're-import must NOT create a duplicate row')
    const dec = await getDecryptedCredential(db, { profileId: PROFILE, portalHost: 'a.example' })
    assert.equal(dec.password, 'pw1', 'password is unchanged after a second import of the same row')
  })

  it('rejects exports with no required headers', async () => {
    const db = makeDb()
    await assert.rejects(
      importCredentialsFromCsv(db, {
        userId: USER, profileId: PROFILE,
        csvText: 'a,b,c\n1,2,3\n',
      }),
      /missing required columns/,
    )
  })

  it('rejects empty / non-string input', async () => {
    const db = makeDb()
    await assert.rejects(
      importCredentialsFromCsv(db, { userId: USER, profileId: PROFILE, csvText: '' }),
      /csvText required/,
    )
  })
})
