/**
 * timedFetch host pinning — the verification providers legitimately put
 * profile-derived values (EIN / name / ZIP) in the QUERY STRING, so the HOST
 * is the security boundary: it must be one of the two fixed public APIs, over
 * https, or the fetch is refused before any request leaves the process
 * (js/request-forgery class — this helper must never become an open proxy
 * toward internal addresses).
 */
import { describe, expect, it } from 'vitest'
import { timedFetch, VERIFICATION_ALLOWED_HOSTS } from '../services/verification/verificationCache.js'

describe('timedFetch SSRF host pinning', () => {
  it('refuses a non-allowlisted host before any request is made', async () => {
    await expect(timedFetch('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(/not allowlisted/)
    await expect(timedFetch('https://localhost:8080/admin')).rejects.toThrow(/not allowlisted/)
    await expect(timedFetch('https://evil.example.com/?ein=123')).rejects.toThrow(/not allowlisted/)
  })

  it('refuses plain http even toward an allowlisted host', async () => {
    await expect(timedFetch('http://projects.propublica.org/nonprofits/api/v2/search.json')).rejects.toThrow(/not allowlisted/)
  })

  it('refuses a lookalike host that merely CONTAINS an allowlisted name (substring class)', async () => {
    await expect(timedFetch('https://projects.propublica.org.evil.example/x')).rejects.toThrow(/not allowlisted/)
    await expect(timedFetch('https://evilgeocoding.geo.census.gov.attacker.net/x')).rejects.toThrow(/not allowlisted/)
  })

  it('refuses malformed URLs loudly instead of fetching', async () => {
    await expect(timedFetch('not a url')).rejects.toThrow()
  })

  it('the allowlist names exactly the two provider hosts (grow only by review)', () => {
    expect(Array.from(VERIFICATION_ALLOWED_HOSTS).sort()).toEqual([
      'geocoding.geo.census.gov',
      'projects.propublica.org',
    ])
  })
})
