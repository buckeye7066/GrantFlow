/**
 * Grants.gov API client (shared infrastructure).
 *
 * Relocated out of the legacy grantsDotGovCrawler.js during the Crawler OS
 * cutover: fetchGrantsGov + transformGrantsGovOpportunity are a self-contained
 * Grants.gov REST client (no crawler-engine deps) used by the live federal
 * search (services/shared/liveFederalSearch.js) and the connector ingest path.
 * Keeping them here lets the legacy crawler engine become unreachable while the
 * API client remains available. search2 works without GRANTS_GOV_API_KEY; when
 * set, X-API-Key is sent.
 */
import axios from 'axios';
import { createLogger } from '../../utils/logger.js';
import {
  GRANTS_GOV_SEARCH2_URL as GRANTS_GOV_SEARCH2,
  GRANTS_GOV_DETAIL_URL as GRANTS_GOV_VIEW,
} from '../../config/grantsGovEndpoints.js';
import { parseApiAmount } from '../sources/grantsGovAmountAdapter.js';

const log = createLogger('grantsGovApiClient');
const GRANTS_GOV_API_KEY = process.env.GRANTS_GOV_API_KEY || '';

export async function fetchGrantsGov(params = {}) {
  const {
    keyword = '',
    oppStatus = 'forecasted|posted',
    rows = 25,
    startRow = 0,
    fundingCategories = null,
    eligibilities = null,
  } = params;

  const payload = {
    rows: Number(rows) || 25,
    oppStatuses: String(oppStatus || 'forecasted|posted'),
    keyword: String(keyword || ''),
    startRecordNum: Number(startRow) || 0,
    agencies: '',
    fundingCategories: Array.isArray(fundingCategories) ? fundingCategories.join('|') : '',
    eligibilities: Array.isArray(eligibilities) ? eligibilities.join('|') : '',
    aln: '',
    oppNum: '',
  };

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.info(`[GrantsGov] search2 request (attempt ${attempt}/${MAX_RETRIES}):`, JSON.stringify(payload));
      const response = await axios.post(GRANTS_GOV_SEARCH2, payload, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(GRANTS_GOV_API_KEY ? { 'X-API-Key': GRANTS_GOV_API_KEY } : {}),
        },
      });
      const body = response?.data ?? null;
      if (!body) return null;
      const hitsNode = body?.data?.oppHits ? body.data : body?.data?.data?.oppHits ? body.data.data : body;
      const oppHits = Array.isArray(hitsNode?.oppHits) ? hitsNode.oppHits : [];
      log.info('[GrantsGov] search2 oppHits returned:', oppHits.length);
      return hitsNode;
    } catch (error) {
      const status = error?.response?.status;
      const detail = error?.response?.data ? JSON.stringify(error.response.data).slice(0, 400) : null;
      if (status && status >= 400 && status < 500 && status !== 429) {
        log.error('[GrantsGov] Permanent API error, not retrying:', status, detail || error.message);
        return null;
      }
      if (attempt === MAX_RETRIES) {
        log.error('[GrantsGov] API error after all retries:', status ? `${status}` : error.message, detail || '');
        return null;
      }
      const delayMs = BASE_DELAY_MS * (2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

export function transformGrantsGovOpportunity(opp) {
  const oppId = opp?.id ?? opp?.oppId ?? null;
  const oppNumber = opp?.number || opp?.oppNum || opp?.oppNumber || opp?.opportunityNumber || '';
  const id = `grants-gov-${oppNumber || oppId || cryptoSafeId(opp)}`;
  const agencyName = opp?.agencyName || opp?.agency || null;
  const agencyCode = opp?.agencyCode || null;
  const openDate = opp?.openDate || null;
  const closeDate = opp?.closeDate || null;
  const oppStatus = opp?.oppStatus || null;
  const alnlist = opp?.alnlist ?? null;
  const detailUrl = (oppId !== null && oppId !== undefined)
    ? `${GRANTS_GOV_VIEW}${oppId}`
    : oppNumber ? `https://www.grants.gov/search-results-detail/${encodeURIComponent(String(oppNumber))}` : null;
  return {
    id,
    title: opp?.title || opp?.opportunityTitle || opp?.oppTitle || 'Federal Grant Opportunity',
    // NULL, never an anonymized placeholder (2026-08-14). "Federal Agency" is
    // the fabricated-funder class the owner banned on 2026-08-03; the
    // crawler-os federalRegisterAdapter was fixed to keep a NULL sponsor and
    // this client was missed. A NULL rides the existing no-sponsor handling;
    // an invented name states a fact about the funder that nobody verified —
    // and `ANONYMIZED_FUNDER_RX` is anchored on a `U.S.` prefix this string
    // lacks, so the boot net could never catch it either.
    sponsor: agencyName || agencyCode || null,
    source: 'grants.gov',
    source_id: oppNumber || null,
    source_url: detailUrl,
    application_url: detailUrl,
    description: opp?.synopsis || opp?.description || `Grants.gov opportunity ${oppNumber}${oppStatus ? ` (${oppStatus})` : ''}`.trim(),
    amount_min: parseAmount(opp?.awardFloor) || null,
    amount_max: parseAmount(opp?.awardCeiling) || null,
    deadline: closeDate || null,
    deadline_type: closeDate ? 'fixed' : 'rolling',
    is_national: true,
    state: 'nationwide',
    categories: [
      opp?.categoryOfFunding || 'federal', 'government', 'grants.gov',
      ...(Array.isArray(opp?.eligibilities) ? opp.eligibilities.map((e) => String(e).toLowerCase()) : []),
      ...(Array.isArray(opp?.applicantTypes) ? opp.applicantTypes.map((a) => String(a).toLowerCase()) : []),
    ].filter(Boolean),
    keywords: extractKeywords(opp),
    opportunity_type: 'grant',
    type: 'OPPORTUNITY',
    requires_501c3: false,
    requires_match: false,
    eligibility_bullets: buildEligibility({ oppNumber, agencyName, agencyCode, openDate, closeDate, oppStatus, alnlist }),
  };
}

function cryptoSafeId(opp) {
  try {
    const text = JSON.stringify(opp ?? {});
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return String(hash);
  } catch {
    return String(Date.now());
  }
}
/**
 * Award figures come from the ONE canonical parser (2026-08-14).
 *
 * The local implementation this replaces STRIPPED every non-digit instead of
 * REFUSING a value it could not parse, so it concatenated numbers rather than
 * failing:
 *     "$50,000-$100,000" -> 50000100000   (fifty billion dollars)
 *     "1,000 to 5,000"   -> 10005000
 *     "1.5M"             -> 1.5
 *     "0"                -> 0
 * Nothing downstream catches these: grants.gov is an `isOfficialAmountSource`,
 * which CLAUDE.md records as DELIBERATELY EXEMPT from the $100–$10M
 * plausibility demotion, so a fabricated ceiling persists unchallenged onto the
 * catalog row and into every "Pipeline $" surface.
 *
 * `parseApiAmount` (services/sources/grantsGovAmountAdapter.js) is the parser
 * written for exactly this API and already handles the `"none"` / `"0"` trap
 * documented in that module's header. Delegating keeps ONE rule instead of two.
 */
function parseAmount(val) {
  return parseApiAmount(val);
}
function extractKeywords(opp) {
  const keywords = [];
  if (opp?.categoryOfFunding) keywords.push(String(opp.categoryOfFunding).toLowerCase());
  if (opp?.agencyName) keywords.push(String(opp.agencyName).toLowerCase());
  if (opp?.agencyCode) keywords.push(String(opp.agencyCode).toLowerCase());
  if (opp?.oppStatus) keywords.push(String(opp.oppStatus).toLowerCase());
  keywords.push('grants.gov', 'federal', 'government', 'grant');
  return keywords;
}
function buildEligibility({ oppNumber, agencyName, agencyCode, openDate, closeDate, oppStatus, alnlist }) {
  const bullets = [];
  if (oppNumber) bullets.push(`Opportunity number: ${oppNumber}`);
  if (agencyName) bullets.push(`Agency: ${agencyName}${agencyCode ? ` (${agencyCode})` : ''}`);
  if (oppStatus) bullets.push(`Status: ${oppStatus}`);
  if (openDate) bullets.push(`Open date: ${openDate}`);
  if (closeDate) bullets.push(`Close date: ${closeDate}`);
  if (alnlist) bullets.push(`ALN list: ${Array.isArray(alnlist) ? alnlist.join(', ') : String(alnlist)}`);
  bullets.push('Apply through Grants.gov');
  return bullets;
}

export default { fetchGrantsGov, transformGrantsGovOpportunity };
