// crawler-os/realityGate.js
//
// THE reality gate. Every candidate passes here before it can become a stored
// opportunity. This is where honesty is enforced; nothing that fails enters the
// catalog as if it were real. Every verdict is explicit in verdict_reasons.
//
// Checks: placeholder/mock content, real sponsor, geo-stub rejection, safe URL
// (search-URL-as-apply rejected), loan gating (per profile), cost-share gating
// (per profile), deadline classification, evidence-driven reality status, dedup.
//
// Pure, no I/O. Operates on a candidate + the profile thesis + source context.

import { isSafeUrl } from './safeUrl.js';
import {
  REALITY_STATUS, REASON, OPPORTUNITY_KIND, APPLICABLE_KINDS,
  TRUST_TIER_WEIGHT, deterministicOpportunityId,
} from './contract.js';

const PLACEHOLDER_TEXT = [
  /lorem ipsum/i, /\bplaceholder\b/i, /\bmock(ed)?\b/i, /\bdummy\b/i,
  /\bsample (grant|opportunity)\b/i, /\btodo\b/i, /\bxxxx+\b/i,
  /\btest (grant|opportunity|funder)\b/i, /\bfoo\s*bar\b/i,
];

// Geo-stub signature: a "county/city-specific direct grant" whose title is a
// templated locator phrase (the synthesized stubs the legacy crawler produced).
const GEO_STUB_TITLE = [
  /\bnear\b\s+\w+/i,
  /\bin\s+[A-Z][a-z]+\s+County\b/,
  /community foundations? (in|near|around)\b/i,
  /\b(funders?|grants?) (in|near|around)\s+[A-Z]/i,
];

/**
 * enforceReality — the single verdict function.
 *
 * @param {object} candidate parser candidate
 * @param {{ thesis?:object, source?:object, evidence?:object }} ctx
 * @returns {{ ok:boolean, reality_status:string, trust_score:number,
 *   verdict_reasons:string[], dedup_key:string, kind:string, reason?:string }}
 */
export function enforceReality(candidate, ctx = {}) {
  const thesis = ctx.thesis ?? {};
  const source = ctx.source ?? {};
  const reasons = [];
  const kind = classifyKind(candidate, source);
  const isApplicable = APPLICABLE_KINDS.includes(kind);
  const isDirectory = kind === OPPORTUNITY_KIND.DIRECTORY;
  const isIntel = kind === OPPORTUNITY_KIND.PAST_AWARD_INTEL;

  if (hasPlaceholderContent(candidate)) {
    return reject(REASON.PLACEHOLDER_CONTENT, ['placeholder/mock/lorem content detected'], kind, candidate, source);
  }
  if (!candidate.sponsor || String(candidate.sponsor).trim().length < 2) {
    return reject(REASON.NO_SPONSOR, ['missing sponsor / funding org'], kind, candidate, source);
  }
  if (isApplicable && looksLikeGeoStub(candidate)) {
    return reject(REASON.GEO_STUB, ['templated geo-stub presented as a direct opportunity'], kind, candidate, source);
  }

  // URL checks. Direct-apply rows need a safe https apply_url. Standing
  // PROGRAM rows may be honest program/intake records with only an info_url
  // (SAM.gov assistance listings are the canonical example), so they are stored
  // for REVIEW rather than rejected as fake direct applications.
  if (isApplicable) {
    const urlForGate = candidate.apply_url || (kind === OPPORTUNITY_KIND.PROGRAM ? candidate.info_url : null);
    const urlKind = candidate.apply_url ? 'apply' : 'info';
    // An applicable opportunity we surface must use https, whether the gate URL
    // is an apply_url or a PROGRAM info_url. Validating the PROGRAM info_url as
    // kind 'info' alone would allow http (a downgrade), so enforce https here.
    if (/^http:\/\//i.test(String(urlForGate ?? ''))) {
      return reject(REASON.BAD_URL, [`${urlKind}_url must be https`], kind, candidate, source);
    }
    const urlCheck = isSafeUrl(urlForGate ?? '', { kind: urlKind });
    if (!urlCheck.ok) {
      if (urlCheck.reason === 'search_url_as_apply') {
        return reject(REASON.SEARCH_URL_AS_APPLY, ['apply_url is a search-engine result URL'], kind, candidate, source);
      }
      return reject(REASON.BAD_URL, [`${urlKind}_url unsafe/invalid: ${urlCheck.reason}`], kind, candidate, source);
    }
  } else if (candidate.info_url) {
    const infoCheck = isSafeUrl(candidate.info_url, { kind: 'info' });
    if (!infoCheck.ok) {
      return reject(REASON.BAD_URL, [`info_url unsafe/invalid: ${infoCheck.reason}`], kind, candidate, source);
    }
  }

  // Loan gating (per profile).
  if (candidate.is_loan === true && !thesis.loan_allowed) {
    return reject(REASON.LOAN_NOT_ALLOWED, ['loan product but profile does not allow loans'], kind, candidate, source);
  }
  // Cost-share / matching-fund gating (per profile).
  if (candidate.requires_cost_share === true && !thesis.cost_share_allowed) {
    return reject(REASON.COST_SHARE_NOT_ALLOWED, ['requires cost-share/match but profile disallows'], kind, candidate, source);
  }

  // Deadline classification.
  const dl = classifyDeadline(candidate);
  if (dl.expired) {
    return reject(REASON.EXPIRED_DEADLINE, [`deadline clearly expired: ${candidate.deadline}`], kind, candidate, source);
  }

  // Reality status + evidence-driven confidence.
  const hasEvidence = Boolean(ctx.evidence?.url && ctx.evidence?.content_hash);
  let realityStatus;
  if (isDirectory) realityStatus = REALITY_STATUS.DIRECTORY;
  else if (isIntel) realityStatus = REALITY_STATUS.INTEL_ONLY;
  else if (dl.rolling) {
    realityStatus = REALITY_STATUS.ROLLING;
    if (!hasEvidence) reasons.push('rolling, evidence not yet captured');
  } else if (hasEvidence) realityStatus = REALITY_STATUS.VERIFIED;
  else { realityStatus = REALITY_STATUS.LINK_UNVERIFIED; reasons.push('safe URL but no captured evidence hash yet'); }

  const trustScore = computeTrustScore(source, hasEvidence, realityStatus);
  const dedupKey = deterministicOpportunityId({
    source_id: candidate.source_id ?? source.source_id,
    sponsor: candidate.sponsor, title: candidate.title,
    apply_url: candidate.apply_url, external_id: candidate.external_id,
  });
  reasons.unshift(`accepted as ${kind} (${realityStatus})`);
  return { ok: true, reality_status: realityStatus, trust_score: trustScore,
    verdict_reasons: reasons, dedup_key: dedupKey, kind };
}

// ---- internals ------------------------------------------------------------
function classifyKind(candidate, source) {
  if (candidate.is_directory) return OPPORTUNITY_KIND.DIRECTORY;
  if (candidate.is_intel) return OPPORTUNITY_KIND.PAST_AWARD_INTEL;
  if (source.directory) return OPPORTUNITY_KIND.DIRECTORY;
  if (candidate.kind) return candidate.kind;
  if (source.default_kinds?.length) return source.default_kinds[0];
  return OPPORTUNITY_KIND.DIRECT_GRANT;
}

function hasPlaceholderContent(candidate) {
  const blob = `${candidate.title ?? ''} ${candidate.summary ?? ''} ${candidate.sponsor ?? ''}`;
  return PLACEHOLDER_TEXT.some((re) => re.test(blob));
}

function looksLikeGeoStub(candidate) {
  const title = String(candidate.title ?? '');
  const templated = GEO_STUB_TITLE.some((re) => re.test(title));
  if (!templated) return false;
  const hasConcreteId = Boolean(candidate.external_id);
  const url = String(candidate.apply_url ?? '');
  const looksLikeDetailPage = /\/(detail|opportunity|grant|award|nofo|program)\//i.test(url);
  return !(hasConcreteId || looksLikeDetailPage);
}

function classifyDeadline(candidate) {
  if (candidate.is_rolling) return { rolling: true, expired: false };
  const raw = candidate.deadline;
  if (!raw) return { rolling: false, expired: false, unknown: true };
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return { rolling: false, expired: false };
  const now = Date.now();
  if (ts < now - 24 * 3600 * 1000) return { rolling: false, expired: true };
  return { rolling: false, expired: false };
}

function computeTrustScore(source, hasEvidence, realityStatus) {
  const base = TRUST_TIER_WEIGHT[source.trust_tier] ?? 0.25;
  let score = base;
  if (hasEvidence) score = Math.min(1, score + 0.1);
  if (realityStatus === REALITY_STATUS.LINK_UNVERIFIED) score = Math.max(0, score - 0.1);
  return Math.round(score * 100) / 100;
}

function reject(reasonCode, details, kind, candidate, source) {
  return {
    ok: false, reality_status: REALITY_STATUS.REJECTED, trust_score: 0,
    verdict_reasons: [reasonCode, ...details],
    dedup_key: deterministicOpportunityId({
      source_id: candidate.source_id ?? source.source_id, sponsor: candidate.sponsor,
      title: candidate.title, apply_url: candidate.apply_url, external_id: candidate.external_id,
    }),
    kind, reason: reasonCode,
  };
}

export default { enforceReality };
