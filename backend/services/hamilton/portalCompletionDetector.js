/**
 * portalCompletionDetector.js
 *
 * Owner requirement (b): "If [an upload] is, for example, an application for a
 * funding source like a completed FAFSA link, mark the link as complete (but not
 * merged)."
 *
 * When a profile uploads a document or imports a URL, this detector decides
 * whether that artifact corresponds to a KNOWN funding-source portal for the
 * profile, and whether it looks like a COMPLETED application (vs just a login
 * page). If both hold, it marks that portal complete-but-not-merged in
 * portalCompletionStore.js. completed ≠ merged: the portal stays out of "merged"
 * but is recorded as done, and the weekly reminder still nudges it until merged.
 *
 * Recognition is conservative and host-based (no model call):
 *   1. Collect candidate URLs from the artifact (the import URL, the document's
 *      file_url, and URLs found in its extracted text).
 *   2. Reduce each to its registrable host.
 *   3. Match that host against:
 *        a. the profile's KNOWN portal hosts (profilePortalIndex tiles +
 *           process portals — FAFSA/ACT/benefits/Grants.gov, the profile's own
 *           school, pipeline funding sources), AND/OR
 *        b. a small allowlist of unambiguous funding-application hosts (FAFSA
 *           studentaid.gov, CSS Profile, common scholarship platforms).
 *   4. Require a "completed" signal — either an explicit completion cue in the
 *      text/filename (e.g. "submitted", "confirmation", "SAR", "EFC", "award"),
 *      OR the URL path itself indicating a submitted/confirmation view. A bare
 *      login URL with no completion cue is NOT marked complete.
 *
 * Never throws — a detection failure must never fail a document upload.
 */

import { getProfilePortals } from './profilePortalIndex.js'
import { markPortalComplete, portalStatusKeyHost } from './portalCompletionStore.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:portal-completion-detector')

// Unambiguous funding-application hosts: a completed application for any of these
// is a funding source regardless of whether a tile already exists for it. Keyed
// on registrable host (eTLD+1).
const FUNDING_APPLICATION_HOSTS = new Set([
  'studentaid.gov', // FAFSA
  'fafsa.gov',
  'cssprofile.org', 'collegeboard.org', // CSS Profile / College Board
  'act.org',
  'academicworks.com', 'communityforce.com', 'smapply.io', 'smapply.org',
  'submittable.com', 'awardspring.com', 'scholarshipuniverse.com',
  'bold.org', 'goingmerry.com', 'scholarships.com', 'commonapp.org',
  'fastweb.com', 'mykaleidoscope.com', 'grantinterface.com', 'fluxx.io',
  'grants.gov', 'sam.gov',
  'ngwebsolutions.com', // NGWeb "Scholarship Manager" tenants
])

// Text / filename cues that indicate a COMPLETED (submitted/confirmed) funding
// application rather than merely a login page or blank form.
const COMPLETION_CUES = [
  // Typed portal-issued references. Generic "submitted", "accepted", or a
  // /status URL is deliberately insufficient.
  /\b(?:confirmation|tracking|receipt|submission)\s*(?:number|no\.?|#|id|code)\s*[:#.-]?\s*[A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*\d[A-Za-z0-9-]*\b/i,
  /\bstudent\s+aid\s+report\b/i, // FAFSA SAR
  /\bSAR\b/,
  /\bexpected\s+family\s+contribution\b/i,
  /\bEFC\b/,
  /\bstudent\s+aid\s+index\b/i,
  /\bSAI\b/,
  /\baward\s+letter\b/i,
  /\bfinancial\s+aid\s+award\b/i,
  /\bweb\s+confirmation\s*(?:number|no\.?|#|id|code)\s*[:#.-]?\s*[A-Za-z0-9-]*\d[A-Za-z0-9-]*\b/i,
]

/** Extract candidate URLs from a string (best-effort, capped). */
function extractUrls(text, cap = 50) {
  if (!text) return []
  const out = []
  const re = /https?:\/\/[^\s"'<>)\]]+/gi
  let m
  while ((m = re.exec(String(text))) !== null) {
    out.push(m[0])
    if (out.length >= cap) break
  }
  return out
}

/** Does the artifact carry a "this application is complete" signal? */
function hasCompletionSignal({ text, fileName, urls }) {
  const haystack = `${fileName || ''}\n${text || ''}`
  if (COMPLETION_CUES.some((re) => re.test(haystack))) return true
  // A URL is target context, not evidence. /confirmation, /status, /summary,
  // and similar routes are frequently drafts or navigation chrome.
  void urls
  return false
}

/**
 * Detect a completed funding-source application in an uploaded artifact and, when
 * found, mark the matching portal(s) complete-but-not-merged.
 *
 * @param {object} db
 * @param {object} artifact
 * @param {string} artifact.profileId
 * @param {string} [artifact.documentId]
 * @param {string} [artifact.grantId]
 * @param {string} [artifact.importUrl]   the imported URL (if any)
 * @param {string} [artifact.fileUrl]     the document's stored file_url (if any)
 * @param {string} [artifact.text]        extracted text (scanned for URLs + cues)
 * @param {string} [artifact.fileName]    document name (scanned for cues)
 * @returns {Promise<{ marked: Array<{ host: string }>, reason?: string }>}
 */
export async function detectAndMarkCompletedApplications(db, artifact = {}) {
  const result = { marked: [] }
  try {
    const profileId = artifact.profileId
    if (!db || !profileId) return { marked: [], reason: 'no_profile' }

    const text = artifact.text || ''
    const fileName = artifact.fileName || ''

    // 1. Candidate hosts from explicit URLs + URLs found in the text.
    const rawUrls = []
    if (artifact.importUrl) rawUrls.push(artifact.importUrl)
    if (artifact.fileUrl) rawUrls.push(artifact.fileUrl)
    rawUrls.push(...extractUrls(text))
    const candidateHosts = new Set()
    for (const u of rawUrls) {
      const h = portalStatusKeyHost(u)
      if (h) candidateHosts.add(h)
    }
    if (candidateHosts.size === 0) return { marked: [], reason: 'no_candidate_hosts' }

    // 2. A completion signal is REQUIRED — a bare login link with no "submitted/
    //    confirmation/SAR/award" cue is not a completed application.
    if (!hasCompletionSignal({ text, fileName, urls: rawUrls })) {
      return { marked: [], reason: 'no_completion_signal' }
    }

    // 3. The profile's KNOWN funding-source portal hosts (tiles + process portals).
    //    Only funding_source / process-funding tiles count — a school login page
    //    is not a funding application by itself.
    const knownFundingHosts = new Set()
    try {
      const { portals } = await getProfilePortals(db, profileId, { refresh: false })
      for (const p of portals || []) {
        if (!p?.portalHost) continue
        const kind = p.kind || ''
        // funding_source tiles and process portals scoped to funding (FAFSA/ACT/
        // benefits/Grants.gov) are eligible; a plain 'school' login tile is not.
        if (kind === 'funding_source' || p.isProcessPortal) {
          knownFundingHosts.add(portalStatusKeyHost(p.portalHost))
        }
      }
    } catch (err) {
      log.warn('known_portals_lookup_failed', { profileId: String(profileId), err: err?.message })
    }

    // 4. Match: a candidate host is a funding application if it is either a known
    //    funding portal for THIS profile, or an unambiguous funding-application
    //    host from the allowlist.
    const matched = new Set()
    for (const host of candidateHosts) {
      if (knownFundingHosts.has(host) || FUNDING_APPLICATION_HOSTS.has(host)) {
        matched.add(host)
      }
    }
    if (matched.size === 0) return { marked: [], reason: 'no_funding_host_match' }

    // 5. Mark each matched portal complete-but-not-merged (never regresses a
    //    merged portal — see markPortalComplete).
    for (const host of matched) {
      const row = await markPortalComplete(db, {
        profileId,
        portalHost: host,
        source: artifact.importUrl ? 'url_import' : 'document_upload',
        evidence: (fileName || artifact.importUrl || '').slice(0, 240) || null,
        grantId: artifact.grantId || null,
        documentId: artifact.documentId || null,
      })
      if (row) result.marked.push({ host, status: row.status })
    }
    if (result.marked.length > 0) {
      log.info('marked_completed_applications', {
        profileId: String(profileId),
        hosts: result.marked.map((m) => m.host),
      })
    }
    return result
  } catch (err) {
    // Never fail an upload on detection.
    log.warn('detect_failed', { err: err?.message })
    return { marked: [], reason: 'error' }
  }
}

export default { detectAndMarkCompletedApplications, FUNDING_APPLICATION_HOSTS }
