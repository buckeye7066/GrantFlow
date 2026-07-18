// crawler-os/blindOpportunityKind.js
//
// Phase 1c of the web-lane de-contamination program: a PURE, TRUST-AWARE
// classifier that tells a REAL single-program page apart from an
// AGGREGATOR / DIRECTORY / list page.
//
// WHY THIS EXISTS. The blind extractor (Phase 1a) records what a page FACTUALLY
// states, and the shadow wiring (Phase 1b) re-runs it alongside the live lane.
// But a page-fact candidate carries no notion of "is this ONE fundable program,
// or a LIST of many?" — and treating a directory/index as a directly-applicable
// award is exactly the web-lane contamination this program exists to remove. A
// directory is a LOCATOR (a pointer to where to look), never an award; and an
// UNVERIFIED open-web list must NOT inherit the protections a durable, curated
// DIRECTORY earns (the "Recommended != strong match" locator rule, CLAUDE.md).
//
// WHAT IT DOES. Given a blind page-fact candidate + its page-derived link
// inventory + the page text (ALL page-derived — NO profile, NO thesis, NO query,
// NO seed), it returns:
//   kind  : DIRECT_PROGRAM | AGGREGATOR_INDEX | UNKNOWN
//   trust : PROTECTED | UNVERIFIED   (PROTECTED is only ever a durable locator)
//
// GUARANTEES
//   - PROFILE-BLIND: the signature accepts ONLY { candidate, linkInventory,
//     pageText }. There is no profile parameter to thread; blindness is enforced
//     by the signature, not by discipline (asserted in the tests).
//   - PURE + DETERMINISTIC: no I/O, no randomness, no clock. Same inputs =>
//     byte-identical output. Every signal is a code-checkable heuristic over
//     page-supported evidence; nothing trusts a model's say-so alone.
//   - CONSERVATIVE: defaults to UNKNOWN when the page signal is insufficient, and
//     to UNVERIFIED whenever the durable-locator bar is not fully met. PROTECTED
//     is NEVER over-claimed — it requires a named operator AND a verified info
//     target that is a real link on the page AND a page-derived trusted signal.
//   - ADDITIVE / SHADOW-ONLY: this module is consumed ONLY by the Phase-1b shadow
//     path to label shadow candidates and extend the read-only shadow counter. It
//     is NOT wired into the reality gate, the match engine, opportunity_kind
//     persistence, or any live DIRECTORY handling — reclassifying live traffic is
//     a later, separate live-behavior change.

/** The classifier's KIND axis. Distinct from contract.OPPORTUNITY_KIND (the
 *  persisted catalog enum) on purpose: these are SHADOW telemetry labels, never
 *  written to storage. DIRECT_PROGRAM folds DIRECT_GRANT/PROGRAM/SCHOLARSHIP —
 *  the classifier decides "single applicable program" vs "list", not the finer
 *  catalog kind. */
export const BLIND_OPPORTUNITY_KIND = Object.freeze({
  DIRECT_PROGRAM: 'DIRECT_PROGRAM',       // a specific fundable program w/ its own apply/info target + named sponsor
  AGGREGATOR_INDEX: 'AGGREGATOR_INDEX',   // a list/directory of MANY programs — a locator, never a directly-applicable award
  UNKNOWN: 'UNKNOWN',                     // insufficient page signal
});

/** The classifier's TRUST axis. PROTECTED is reserved for a durable locator; an
 *  open-web list with no named operator / verified target / trusted signal is
 *  UNVERIFIED and inherits NO directory protection. */
export const BLIND_TRUST = Object.freeze({
  PROTECTED: 'PROTECTED',       // a durable locator: named operator + verified info target + trusted signal
  UNVERIFIED: 'UNVERIFIED',     // an open-web list / anything short of the durable-locator bar
});

// --- Thresholds (page-derived structural bounds) ----------------------------
// A single real program page carries a handful of links (apply, home, contact,
// a few related). A directory/index links out to MANY distinct programs. These
// are deliberately high so a nav-heavy program page never trips the structural
// path on its own — the primary AGGREGATOR path ALSO requires directory LANGUAGE
// and the ABSENCE of a concrete apply target.
export const AGGREGATOR_MIN_LINKS = 12;    // "many programs" floor (paired with language + no-apply)
export const AGGREGATOR_STRONG_LINKS = 30; // a pure link-farm floor (no language cue required)
// Below this the page copy is too thin to assert anything → UNKNOWN.
export const MIN_PAGE_TEXT_CHARS = 120;

// Directory / index / "browse a list" language. Each is a phrase a listing page
// uses and a single-program page does not. Matched as a normalized substring of
// the page text (word boundaries where a bare token would be too greedy).
const DIRECTORY_CUES = [
  'list of grants', 'list of scholarships', 'list of funding', 'grants directory',
  'funding directory', 'scholarship directory', 'resource directory', 'directory of',
  'browse grants', 'browse scholarships', 'browse funding', 'browse our', 'browse all',
  'search grants', 'search scholarships', 'search for grants', 'search our database',
  'grant database', 'scholarship database', 'funding database', 'searchable database',
  'find grants', 'find scholarships', 'find funding', 'explore grants', 'explore funding',
  'filter by', 'sort by', 'view all grants', 'view all scholarships', 'all opportunities',
  'grant opportunities below', 'available grants', 'available scholarships',
  'matching grants', 'matching scholarships', 'showing results', 'results found',
];

/** Normalize text for substring cue matching: lowercase, collapse whitespace. */
function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Count DISTINCT directory-language cues present in the (normalized) page text. */
function countDirectoryCues(hay) {
  let n = 0;
  for (const cue of DIRECTORY_CUES) if (hay.includes(cue)) n += 1;
  return n;
}

/**
 * Count DISTINCT http(s) links in the inventory (the page's real outbound
 * targets). buildLinkInventory already de-dupes by canonical url and drops
 * same-page fragments / non-http schemes, so this is a faithful "how many real
 * places does this page point to" proxy. Robust to a hostile/loose caller array.
 */
function countInventoryLinks(inv) {
  if (!Array.isArray(inv)) return 0;
  const urls = new Set();
  for (const l of inv) {
    if (l && typeof l.url === 'string' && /^https?:\/\//i.test(l.url)) urls.add(l.url);
  }
  return urls.size;
}

/** Is `url` present as a real link ON the page (a member of the inventory)? A
 *  target that is only the page's own URL fallback is NOT a verified info target. */
function isInventoryMember(url, inv) {
  if (!url || !Array.isArray(inv)) return false;
  const u = String(url);
  return inv.some((l) => l && typeof l.url === 'string' && l.url === u);
}

/** Extract a lowercased hostname from an absolute http(s) URL, or '' if unparsable. */
function hostOf(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

// A small allowlist of durable, curated public directory operators. Kept narrow
// on purpose: over-listing manufactures PROTECTED (G0 no-over-claim). gov/edu
// hosts are covered structurally below; these are the well-known non-gov durable
// locators. A host matches by exact base-domain suffix (never a substring, so
// `not211.org.evil.com` cannot spoof `211.org`).
const DURABLE_DIRECTORY_HOSTS = Object.freeze([
  '211.org', 'findhelp.org', 'auntbertha.com', 'benefits.gov', 'usa.gov',
  'grants.gov', 'candid.org', 'foundationcenter.org',
]);

/** A page-derived TRUSTED signal: the verified info-target host is an official /
 *  institutional / known-durable-directory host. Purely code-checkable. */
function hasTrustedHost(url) {
  const host = hostOf(url);
  if (!host) return false;
  if (host === 'gov' || host.endsWith('.gov')) return true;
  if (host === 'edu' || host.endsWith('.edu')) return true;
  return DURABLE_DIRECTORY_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * classifyBlindOpportunityKind — classify ONE blind page-fact candidate using
 * ONLY page-derived signals.
 *
 * @param {object} input
 * @param {object} input.candidate    a blind page-fact candidate (mapBlindFactsToCandidate
 *   output OR a raw page-fact object). Page-derived: title, sponsor, apply_url,
 *   info_url. NO profile fields are read.
 * @param {Array}  input.linkInventory the page's link inventory (buildLinkInventory output).
 * @param {string} input.pageText     the page's text.
 * @returns {{ kind:string, trust:string, signals:object }} deterministic verdict
 *   + the page-derived signals it was decided on (for shadow observability).
 */
export function classifyBlindOpportunityKind(input) {
  const { candidate, linkInventory, pageText } = (input && typeof input === 'object') ? input : {};
  const cand = (candidate && typeof candidate === 'object') ? candidate : {};
  const inv = Array.isArray(linkInventory) ? linkInventory : [];
  const hay = norm(pageText);

  // Page-derived candidate signals. sponsor/title are page-derived by the blind
  // extractor (it drops any not found on the page); we still treat them literally.
  const sponsor = typeof cand.sponsor === 'string' ? cand.sponsor.trim() : '';
  const hasNamedOperator = sponsor.length >= 2;
  const applyUrl = typeof cand.apply_url === 'string' && /^https?:\/\//i.test(cand.apply_url) ? cand.apply_url : null;
  const infoUrl = typeof cand.info_url === 'string' && /^https?:\/\//i.test(cand.info_url) ? cand.info_url : null;
  // A CONCRETE apply target: a distinct apply link the extractor resolved inside
  // the page inventory (never the page-URL fallback — the extractor puts that in
  // info_url only). Its presence is the strongest "single applicable program" cue.
  const hasConcreteApply = !!applyUrl;
  // A VERIFIED info target: an apply/info URL that is a REAL link on the page
  // (a member of the inventory), not merely the page's own URL fallback.
  const verifiedInfoTarget = isInventoryMember(applyUrl, inv) ? applyUrl
    : (isInventoryMember(infoUrl, inv) ? infoUrl : null);
  const hasVerifiedInfoTarget = !!verifiedInfoTarget;

  const directoryCues = countDirectoryCues(hay);
  const linkCount = countInventoryLinks(inv);
  const manyLinks = linkCount >= AGGREGATOR_MIN_LINKS;
  const linkFarm = linkCount >= AGGREGATOR_STRONG_LINKS;
  const sparse = hay.length < MIN_PAGE_TEXT_CHARS
    || (linkCount === 0 && !hasConcreteApply && !hasVerifiedInfoTarget);

  const signals = {
    has_named_operator: hasNamedOperator,
    has_concrete_apply: hasConcreteApply,
    has_verified_info_target: hasVerifiedInfoTarget,
    directory_cue_count: directoryCues,
    link_count: linkCount,
    many_links: manyLinks,
    link_farm: linkFarm,
    sparse,
    trusted_host: false,
  };

  // --- KIND ------------------------------------------------------------------
  // Order matters and every branch is conservative.
  let kind;
  if (sparse) {
    // Too little page signal to assert either way.
    kind = BLIND_OPPORTUNITY_KIND.UNKNOWN;
  } else if (
    // AGGREGATOR: a list of MANY programs with NO single applicable target.
    // Primary path needs directory LANGUAGE + many links + no concrete apply;
    // the structural fallback needs a genuine link-farm (very high link count).
    !hasConcreteApply && ((directoryCues >= 1 && manyLinks) || linkFarm)
  ) {
    kind = BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX;
  } else if (
    // DIRECT_PROGRAM: a named sponsor + a concrete apply/info target. A concrete
    // apply link settles it even if the page mentions other grants; an info-only
    // page qualifies only when it does NOT read like a directory.
    hasNamedOperator && (hasConcreteApply || (hasVerifiedInfoTarget && directoryCues === 0))
  ) {
    kind = BLIND_OPPORTUNITY_KIND.DIRECT_PROGRAM;
  } else {
    kind = BLIND_OPPORTUNITY_KIND.UNKNOWN;
  }

  // --- TRUST -----------------------------------------------------------------
  // PROTECTED is reserved for a DURABLE LOCATOR (an AGGREGATOR_INDEX) that clears
  // ALL THREE bars: a named operator, a verified info target that is a real link
  // on the page, AND a page-derived trusted signal (an official / institutional /
  // known-durable-directory host on that target). Anything short of that — and
  // every non-directory kind — is UNVERIFIED and inherits NO directory protection.
  let trust = BLIND_TRUST.UNVERIFIED;
  if (kind === BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX) {
    const trustedHost = hasTrustedHost(verifiedInfoTarget);
    signals.trusted_host = trustedHost;
    if (hasNamedOperator && hasVerifiedInfoTarget && trustedHost) {
      trust = BLIND_TRUST.PROTECTED;
    }
  }

  return { kind, trust, signals };
}

/**
 * emptyKindBreakdown / accumulateKindBreakdown — the ONE place the shadow
 * counter's per-kind buckets are defined and tallied, so producer and consumer
 * cannot drift. INVARIANT: protected_directory + unverified_index ===
 * aggregator_index (the trust axis only ever splits the aggregator bucket; a
 * DIRECT_PROGRAM / UNKNOWN never contributes to the directory-protection split).
 *
 * NOTE: these helpers are for the Phase-1b shadow builder (crawlerOsService),
 * the ONE sanctioned seam that imports blind modules. The web lane itself must
 * stay blind-import-free, so it tallies the labels it is handed rather than
 * importing this module.
 */
export function emptyKindBreakdown() {
  return { direct: 0, aggregator_index: 0, unknown: 0, protected_directory: 0, unverified_index: 0 };
}

export function accumulateKindBreakdown(breakdown, verdict) {
  const b = breakdown && typeof breakdown === 'object' ? breakdown : emptyKindBreakdown();
  const kind = verdict && verdict.kind;
  const trust = verdict && verdict.trust;
  if (kind === BLIND_OPPORTUNITY_KIND.DIRECT_PROGRAM) {
    b.direct += 1;
  } else if (kind === BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX) {
    b.aggregator_index += 1;
    if (trust === BLIND_TRUST.PROTECTED) b.protected_directory += 1;
    else b.unverified_index += 1;
  } else {
    b.unknown += 1;
  }
  return b;
}

export default {
  classifyBlindOpportunityKind,
  emptyKindBreakdown,
  accumulateKindBreakdown,
  BLIND_OPPORTUNITY_KIND,
  BLIND_TRUST,
  AGGREGATOR_MIN_LINKS,
  AGGREGATOR_STRONG_LINKS,
  MIN_PAGE_TEXT_CHARS,
};
