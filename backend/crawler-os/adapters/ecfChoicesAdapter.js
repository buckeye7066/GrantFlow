// crawler-os/adapters/ecfChoicesAdapter.js
//
// TennCare ECF CHOICES (Employment and Community First CHOICES) — Tennessee's
// Medicaid HCBS waiver program: employment and community-living supports for
// people with intellectual/developmental disabilities, plus Essential Family
// Supports for their family caregivers.
//
// Ported from the legacy backend/services/crawlers/ecfBenefitsCrawler.js on
// 2026-07-07. The legacy crawler was never registered in the OS sourceRegistry
// or adapter FACTORIES, so after the crawler-os cutover the ECF lane was
// structurally uncrawlable — discovery only runs registry sources, and actual
// ECF CHOICES members (the Gilbert/Kim class) never saw their own program.
// The extraction logic now lives HERE (crawler-os owns it); the legacy file is
// untouched for any remaining legacy callers.
//
// Two requests per run, both honest:
//
//   1. family 'directory' — a config-driven BENEFIT candidate for the ECF
//      CHOICES program itself (the page IS the program's official entry
//      point; enrollment is ongoing, so it is a rolling benefit). Emitted
//      ONLY when the page actually fetches: tn.gov intermittently
//      ECONNRESETs, and per the sbir_gov precedent a failed fetch must
//      surface as an honest FETCH_ERROR source run — never a fabricated row.
//      (The pipeline's fetch-failure survival applies solely to
//      DIRECTORY-kind locator candidates; this BENEFIT is skipped honestly.)
//
//   2. family 'html' — the legacy crawler's conservative live-discovery pass
//      over the page's anchors: program-keyword anchor text only, nav/utility
//      links blocklisted, relative hrefs resolved against the page URL.
//      Candidates carry NO invented amounts or deadlines (the legacy curated
//      dollar figures are deliberately not ported — amount enrichment reads
//      real amounts from source pages). Loan-looking links are flagged
//      is_loan so the reality gate applies the profile's loan preference.
//      The reality gate + match engine remain the sole decision authorities.
//
// Self-contained: imports only from within crawler-os.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';

// Anchor-text patterns treated as "this link points to a real program/benefit".
// Conservative — better to miss a candidate than fabricate one. (Legacy
// LIVE_LINK_KEYWORDS, verbatim.)
const LIVE_LINK_KEYWORDS = [
  'scholarship',
  'grant',
  'program',
  'benefit',
  'support',
  'reimbursement',
  'waiver',
  'assistance',
  'subsidy',
  'stipend',
  'voucher',
];

// Noisy navigation links that always appear on government info pages.
// Matched against href OR anchor text. (Legacy LIVE_LINK_BLOCKLIST, verbatim.)
const LIVE_LINK_BLOCKLIST = [
  /^javascript:/i,
  /^mailto:/i,
  /^tel:/i,
  /#/,
  /\/contact/i,
  /\/about/i,
  /\/privacy/i,
  /\/accessibility/i,
  /\/sitemap/i,
  /\/feedback/i,
  /\/translate/i,
  /\/help-?center/i,
];

// Loan-product detector (legacy isLoan): flag, never silently drop — the
// reality gate enforces the profile's loan preference.
const LOAN_KEYWORDS = ['loan', 'repay', 'interest', 'borrow'];

// Anchor rows: each <a href=...>text</a> with 4-220 chars of plain anchor text
// (legacy anchor-length bounds).
const ANCHOR_ROW_PATTERN = /<a\b[^>]*href\s*=\s*["'][^"']+["'][^>]*>[^<]{4,220}<\/a>/gi;

function matchesProgramKeyword(text) {
  const lower = String(text || '').toLowerCase();
  return LIVE_LINK_KEYWORDS.some((kw) => lower.includes(kw));
}

function passesBlocklist(href, anchorText) {
  const haystacks = [String(href || ''), String(anchorText || '')];
  return !LIVE_LINK_BLOCKLIST.some((re) => haystacks.some((s) => re.test(s)));
}

function looksLikeLoan(text) {
  const lower = String(text || '').toLowerCase();
  return LOAN_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Resolve a possibly-relative href against the page URL; http(s) only. */
function resolveAbsoluteUrl(href, baseUrl) {
  try {
    const u = new URL(String(href || '').trim(), baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function ecfLiveParseCfg() {
  return {
    rowPattern: ANCHOR_ROW_PATTERN,
    fieldPatterns: {
      href: /href\s*=\s*["']([^"']+)["']/i,
      text: />([^<]{4,220})<\/a>/i,
    },
  };
}

export function createEcfChoicesAdapter() {
  return createBaseAdapter({
    source_id: 'tn_ecf_choices',
    family: 'html',
    requiredEnv: [],
    buildRequests(_thesis, source) {
      const pageUrl = source?.base_url
        ?? 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html';
      return [
        {
          // The program itself — config-driven, kind BENEFIT (not DIRECTORY),
          // so a failed tn.gov fetch is an honest FETCH_ERROR, never a
          // fabricated "the program exists and we verified it" row.
          family: 'directory',
          url: pageUrl,
          parseCfg: {
            directoryCandidate: {
              kind: OPPORTUNITY_KIND.BENEFIT,
              title: source?.resource_title || 'Employment and Community First CHOICES (ECF CHOICES)',
              sponsor: source?.sponsor_name || 'TennCare',
              summary: source?.resource_summary ?? null,
              info_url: pageUrl,
              apply_url: pageUrl,
            },
          },
        },
        {
          // Conservative live discovery of additional program links on the page.
          family: 'html',
          url: pageUrl,
          parseCfg: ecfLiveParseCfg(),
        },
      ];
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw) return null;
      const geography = source?.geography ?? { national: false, states: ['TN'] };
      const applicantTypes = source?.applicant_types ?? ['individual', 'family', 'disabled', 'caregiver'];
      const needCategories = source?.need_categories ?? ['disability', 'healthcare', 'employment', 'caregiving'];

      // Branch 1: the config-driven program candidate (directory-family request).
      // parseDirectory stamps is_directory:true, but this source row is
      // directory:false and the honest kind is BENEFIT — re-assert it.
      if (!raw.href) {
        if (!raw.title) return null;
        return {
          kind: OPPORTUNITY_KIND.BENEFIT,
          title: raw.title,
          sponsor: raw.sponsor ?? source?.sponsor_name ?? 'TennCare',
          summary: raw.summary ?? null,
          info_url: raw.info_url ?? source?.base_url ?? null,
          apply_url: raw.apply_url ?? source?.base_url ?? null,
          is_directory: false,
          // ECF CHOICES enrollment is ongoing (legacy deadline: 'Ongoing').
          is_rolling: true,
          deadline: null,
          applicant_types: applicantTypes,
          need_categories: needCategories,
          geography,
          is_loan: false,
          requires_cost_share: false,
          raw,
        };
      }

      // Branch 2: a live-discovered anchor. Legacy extraction rules, verbatim:
      // keyword-positive anchor text, blocklist-negative, absolute http(s) URL.
      const title = String(raw.text ?? '').trim().replace(/\s+/g, ' ');
      if (title.length < 4 || title.length > 220) return null;
      if (!matchesProgramKeyword(title)) return null;
      if (!passesBlocklist(raw.href, title)) return null;
      const absUrl = resolveAbsoluteUrl(raw.href, source?.base_url);
      if (!absUrl) return null;
      return {
        kind: OPPORTUNITY_KIND.PROGRAM,
        title,
        sponsor: source?.sponsor_name ?? 'TennCare',
        summary: `Discovered from ${source?.name ?? 'TennCare ECF CHOICES'}: ${title}`,
        info_url: absUrl,
        apply_url: absUrl,
        is_directory: false,
        is_rolling: false,
        // Amounts/deadlines are intentionally absent — never invented.
        deadline: null,
        applicant_types: applicantTypes,
        need_categories: needCategories,
        geography,
        is_loan: looksLikeLoan(title),
        requires_cost_share: false,
        raw,
      };
    },
  });
}

export default { createEcfChoicesAdapter, ecfLiveParseCfg };
