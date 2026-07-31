/**
 * canonicalProgramRegistry.js — well-known public funding programs whose
 * APPLICATION TARGET is a fixed, officially-owned URL.
 *
 * THE DEFECT CLASS THIS CLOSES (the "TN Promise opens a paramedic program
 * page" report, 2026-07-31, Anastasia's profile): the web lane reads a page
 * that merely MENTIONS a famous program ("this program is TN Promise
 * eligible") and emits an opportunity TITLED by the mention with the PAGE's
 * URL as source/application URL. The title is a real program; the URL is
 * whatever page happened to mention it. Measured in prod 2026-07-31:
 * 10 TN/Tennessee Promise rows, 6 pointing off the official properties —
 * clevelandstatecc.edu/academic-programs/healthcare/paramedic/, an EMT
 * program page, a nursing-alumna blog post; plus TN HOPE rows pointing at a
 * College Confidential FORUM THREAD. Clicking "Open" on such a card launches
 * a secure login for a page where the program cannot be applied for at all.
 *
 * THE RULE: when a row's title/sponsor identify a registered canonical
 * program AND its application_url is not on the program's official host set,
 * the application_url is repointed to the official application URL.
 * source_url / evidence_url are NEVER touched — where we READ the mention
 * stays honest evidence; only where we SEND THE USER is corrected.
 *
 * Enforced at the standard two layers (see CLAUDE.md "INVARIANTS"):
 *   - per-call gate: opportunityInserter.upsertFundingOpportunity
 *   - boot net:      enforceCanonicalProgramApplicationTargets()
 *                    (backend/startup/enforceInvariants.js)
 *
 * REGISTRY DISCIPLINE: an entry may only be added with its official URL
 * LIVE-VERIFIED (fetch it, watch it render the program's own site). Matching
 * must be precise enough that same-word strangers stay out — "Bank of Hope
 * Scholarship" and "AGC Hope Scholarship" are real, unrelated programs and
 * must never match a Tennessee HOPE entry (the #937 one-shared-word class).
 */

function normHost(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase() } catch { return null }
}

/**
 * Each entry:
 *   id / label        — identity for logs & tests
 *   likePrefilters    — cheap SQL LIKE fragments (lowercased) so the boot
 *                       sweep never full-scans; JS `matches` is authoritative
 *   matches({title, sponsor}) — precise identity test
 *   officialUrl       — the application target we repoint to (LIVE-VERIFIED)
 *   officialHosts     — RegExp over the bare hostname (www. stripped); a URL
 *                       on any of these hosts is left exactly as it is
 */
export const CANONICAL_PROGRAMS = Object.freeze([
  {
    id: 'tennessee_promise',
    label: 'Tennessee Promise',
    likePrefilters: ['%promise%'],
    matches: ({ title = '', sponsor = '' }) =>
      /\b(tn|tennessee)[\s-]+promise\b/i.test(String(title)) ||
      /\btennessee[\s-]+promise\b/i.test(String(sponsor)),
    // Verified live 2026-07-31 (302 → the program site). tnachieves.org is the
    // official partnering org where the application actually happens;
    // collegefortn.org + tn.gov are TSAC/state properties.
    officialUrl: 'https://www.tnpromise.gov/',
    officialHosts: /(^|\.)tnpromise\.gov$|(^|\.)tnachieves\.org$|(^|\.)collegefortn\.org$|(^|\.)tn\.gov$/i,
  },
  {
    id: 'tennessee_reconnect',
    label: 'Tennessee Reconnect',
    likePrefilters: ['%reconnect%'],
    matches: ({ title = '', sponsor = '' }) =>
      /\b(tn|tennessee)[\s-]+reconnect\b/i.test(String(title)) ||
      /\btennessee[\s-]+reconnect\b/i.test(String(sponsor)),
    // Verified live 2026-07-31 (200).
    officialUrl: 'https://tnreconnect.gov/',
    officialHosts: /(^|\.)tnreconnect\.gov$|(^|\.)collegefortn\.org$|(^|\.)tn\.gov$/i,
  },
  {
    id: 'tennessee_hope',
    label: 'Tennessee HOPE Scholarship (lottery)',
    likePrefilters: ['%hope%'],
    // Title must carry the STATE qualifier next to HOPE — "Bank of Hope
    // Scholarship" / "AGC Hope Scholarship" must never match.
    matches: ({ title = '' }) =>
      /\b(tn|tennessee)[\s-]+(nontraditional[\s-]+)?hope\b/i.test(String(title)),
    // Verified live 2026-07-31 (200): TSAC's CollegePays hub, which hosts the
    // HOPE/lottery program pages and links the TSAC student portal.
    officialUrl: 'https://www.tn.gov/collegepays',
    officialHosts: /(^|\.)tn\.gov$|(^|\.)collegepays\.org$|(^|\.)collegefortn\.org$/i,
  },
])

/** The registered program this row's identity names, or null. */
export function resolveCanonicalProgram({ title = null, sponsor = null } = {}) {
  if (!title && !sponsor) return null
  for (const p of CANONICAL_PROGRAMS) {
    try { if (p.matches({ title, sponsor })) return p } catch { /* never break a caller */ }
  }
  return null
}

/**
 * Decide whether a row's application target must be repointed.
 * Returns { program, officialUrl } when the row names a canonical program and
 * its application_url is missing or off the official host set; null otherwise
 * (including for rows that are not a registered program — this function never
 * has an opinion about programs it does not know).
 */
export function canonicalProgramTargetRepair({ title = null, sponsor = null, application_url = null } = {}) {
  const program = resolveCanonicalProgram({ title, sponsor })
  if (!program) return null
  const host = normHost(application_url)
  if (host && program.officialHosts.test(host)) return null
  return { program, officialUrl: program.officialUrl }
}

export default { CANONICAL_PROGRAMS, resolveCanonicalProgram, canonicalProgramTargetRepair }
