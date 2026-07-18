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
export const AGGREGATOR_MIN_LINKS = 12;    // "many programs" floor (paired with directory language)
export const AGGREGATOR_STRONG_LINKS = 30; // a link-farm floor (still requires ≥1 directory cue)
export const AGGREGATOR_STRONG_CUES = 2;   // multiple distinct directory phrases = a STRONG list signal
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

/** Read a property without ever throwing (defends against throwing getters on a
 *  hostile input object). Returns undefined on any access failure. */
function safeGet(obj, key) {
  try {
    return obj == null ? undefined : obj[key];
  } catch {
    return undefined;
  }
}

/** Coerce any value to a string without throwing. `String(Object.create(null))`
 *  throws (no default toString / Symbol.toPrimitive); a throwing toString does
 *  too — both become '' here. */
function safeString(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return String(v);
  } catch {
    return '';
  }
}

/** Normalize text for substring cue matching: lowercase, collapse whitespace.
 *  Never throws (coerces via safeString first). */
function norm(s) {
  return safeString(s).replace(/\s+/g, ' ').trim().toLowerCase();
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
    const u = safeGet(l, 'url'); // never throws, even on a hostile getter
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) urls.add(u);
  }
  return urls.size;
}

/** Is `url` present as a real link ON the page (a member of the inventory)? A
 *  target that is only the page's own URL fallback is NOT a verified info target. */
function isInventoryMember(url, inv) {
  if (typeof url !== 'string' || !url || !Array.isArray(inv)) return false;
  for (const l of inv) {
    if (safeGet(l, 'url') === url) return true; // never throws
  }
  return false;
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

/** A page-derived TRUSTED signal: the given host (the SOURCE PAGE / operator's
 *  own host) is an official / institutional / known-durable-directory host.
 *  Purely code-checkable. Applied to the operator page URL, never to a host the
 *  page merely links to. */
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
  // Absolute backstop: no input, however hostile/malformed, may throw. Any
  // unexpected failure below degrades to the conservative UNKNOWN/UNVERIFIED.
  try {
    const src = (input && typeof input === 'object') ? input : {};
    const candidate = safeGet(src, 'candidate');
    const linkInventory = safeGet(src, 'linkInventory');
    const cand = (candidate && typeof candidate === 'object') ? candidate : {};
    const inv = Array.isArray(linkInventory) ? linkInventory : [];
    const hay = norm(safeGet(src, 'pageText')); // safeString/norm never throw

    // Page-derived candidate signals, all read defensively (a hostile candidate
    // may carry throwing getters). sponsor/title are page-derived by the blind
    // extractor; we treat them literally and read via safeGet.
    const sponsorRaw = safeGet(cand, 'sponsor');
    const sponsor = typeof sponsorRaw === 'string' ? sponsorRaw.trim() : '';
    const hasNamedOperator = sponsor.length >= 2;

    const applyRaw = safeGet(cand, 'apply_url');
    const infoRaw = safeGet(cand, 'info_url');
    const applyUrl = typeof applyRaw === 'string' && /^https?:\/\//i.test(applyRaw) ? applyRaw : null;
    const infoUrl = typeof infoRaw === 'string' && /^https?:\/\//i.test(infoRaw) ? infoRaw : null;

    // The SOURCE PAGE (operator) URL — the directory's OWN host, not a host it
    // links to. This is what the trust axis validates: a blog that links to
    // benefits.gov is not itself a trusted operator. Read from the page-fact
    // (`page_url`) or the mapped candidate's provenance (`raw.page_url`).
    const rawMeta = safeGet(cand, 'raw');
    const pageUrl = (() => {
      const direct = safeGet(cand, 'page_url');
      if (typeof direct === 'string' && direct) return direct;
      const viaRaw = safeGet(rawMeta, 'page_url');
      return typeof viaRaw === 'string' && viaRaw ? viaRaw : null;
    })();

    // A CONCRETE apply target: a distinct apply link the extractor resolved inside
    // the page inventory (never the page-URL fallback — the extractor puts that in
    // info_url only). Its presence is a strong "single applicable program" cue.
    const hasConcreteApply = !!applyUrl;
    // A VERIFIED info target: an apply/info URL that is a REAL link on the page
    // (a member of the inventory), not merely the page's own URL fallback.
    const verifiedInfoTarget = isInventoryMember(applyUrl, inv) ? applyUrl
      : (isInventoryMember(infoUrl, inv) ? infoUrl : null);
    const hasVerifiedInfoTarget = !!verifiedInfoTarget;

    const directoryCues = countDirectoryCues(hay);
    const linkCount = countInventoryLinks(inv);
    const manyLinks = linkCount >= AGGREGATOR_MIN_LINKS;

    // A SINGLE-PROGRAM signal: a named sponsor + a concrete program title, with
    // NO directory language. Such a page is a program even when it carries dozens
    // of ordinary NAVIGATION links (the .edu-with-nav-links class) — raw anchor
    // count is NOT aggregator evidence on its own.
    const titleRaw = safeGet(cand, 'title');
    const hasProgramTitle = typeof titleRaw === 'string' && titleRaw.trim().length >= 3;
    const singleProgramSignal = hasNamedOperator && hasProgramTitle && directoryCues === 0;

    // A STRONG aggregator signal: unambiguous "this is a list/directory". Requires
    // directory LANGUAGE in every case (so navigation-heavy program pages, which
    // carry no directory cues, never qualify no matter how many anchors they have),
    // and is strong enough to WIN even when the page also exposes one apply link
    // (a directory can contain apply links — finding 3a).
    const strongAggregator = manyLinks
      && (directoryCues >= AGGREGATOR_STRONG_CUES || (directoryCues >= 1 && linkCount >= AGGREGATOR_STRONG_LINKS));
    // A WEAK aggregator signal: directory language + many links + no single apply
    // target. An apply link is enough to pull a WEAK signal back to DIRECT.
    const weakAggregator = directoryCues >= 1 && manyLinks && !hasConcreteApply;

    const sparse = hay.length < MIN_PAGE_TEXT_CHARS
      || (linkCount === 0 && !hasConcreteApply && !hasVerifiedInfoTarget);

    const signals = {
      has_named_operator: hasNamedOperator,
      has_program_title: hasProgramTitle,
      has_concrete_apply: hasConcreteApply,
      has_verified_info_target: hasVerifiedInfoTarget,
      directory_cue_count: directoryCues,
      link_count: linkCount,
      many_links: manyLinks,
      strong_aggregator: strongAggregator,
      weak_aggregator: weakAggregator,
      single_program_signal: singleProgramSignal,
      sparse,
      operator_host_trusted: false,
    };

    // --- KIND ----------------------------------------------------------------
    // Conservative, order-sensitive. Directory LANGUAGE is REQUIRED for any
    // aggregator verdict; a STRONG list beats a lone apply link; otherwise a
    // concrete apply target (or a single-program signal) means DIRECT_PROGRAM.
    let kind;
    if (sparse) {
      kind = BLIND_OPPORTUNITY_KIND.UNKNOWN;
    } else if (strongAggregator) {
      // A clear multi-program list wins even when it also contains an apply link.
      kind = BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX;
    } else if (hasNamedOperator && hasConcreteApply) {
      // One resolved apply link + a named sponsor, without a STRONG list signal.
      kind = BLIND_OPPORTUNITY_KIND.DIRECT_PROGRAM;
    } else if (weakAggregator) {
      // Directory language + many links + no apply target.
      kind = BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX;
    } else if (singleProgramSignal || (hasNamedOperator && hasVerifiedInfoTarget && directoryCues === 0)) {
      // A named single program with a real info target and no directory language —
      // regardless of how many navigation links surround it.
      kind = BLIND_OPPORTUNITY_KIND.DIRECT_PROGRAM;
    } else {
      kind = BLIND_OPPORTUNITY_KIND.UNKNOWN;
    }

    // --- TRUST ---------------------------------------------------------------
    // PROTECTED is reserved for a DURABLE LOCATOR (an AGGREGATOR_INDEX) whose
    // OPERATOR is trustworthy. All THREE bars must hold: a named operator, the
    // SOURCE PAGE's OWN host on the trusted allowlist (.gov/.edu/durable
    // directories — NOT merely a host it links to), AND a verified info target
    // that is a real inventory link. A blog that links to benefits.gov is not a
    // trusted operator → UNVERIFIED. Every non-directory kind is UNVERIFIED.
    let trust = BLIND_TRUST.UNVERIFIED;
    if (kind === BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX) {
      const operatorTrusted = hasTrustedHost(pageUrl);
      signals.operator_host_trusted = operatorTrusted;
      if (hasNamedOperator && operatorTrusted && hasVerifiedInfoTarget) {
        trust = BLIND_TRUST.PROTECTED;
      }
    }

    return { kind, trust, signals };
  } catch {
    return {
      kind: BLIND_OPPORTUNITY_KIND.UNKNOWN,
      trust: BLIND_TRUST.UNVERIFIED,
      signals: { error: true },
    };
  }
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
