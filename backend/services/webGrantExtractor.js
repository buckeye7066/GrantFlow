// backend/services/webGrantExtractor.js
//
// Profile-blind, evidence-grounded extraction for the open-web discovery lane.
// Search is profile-keyed, but extraction is NOT: the profile may decide which
// pages GrantFlow fetches, never what facts those pages contain. Every
// load-bearing fact comes from the fetched page, every application/info URL is
// selected from that page's actual link inventory, and unsupported facts are
// neutralized before the canonical matcher sees the candidate. Search-query
// provenance is attached later by webLane as non-scoring diagnostic metadata.
//
// Strictly best-effort: any failure (no LLM key, malformed JSON, thin/junk page,
// timeout, or unsupported evidence) yields []. No caller-supplied thesis/query is
// accepted into the extractor, so this module cannot become a hidden second
// matcher again.
//
// FAILURE CLASS (2026-09-12). Every failure used to be the SAME empty array, so
// the web lane could not tell "this page lists no funding" from "no provider
// answered". Between 2026-09-03 and 09-12 every LLM route was dead (OpenAI 429
// credit exhausted, Anthropic 400 credit exhausted, both free Groq routes
// failing) and the lane recorded `ok:true extracted:0 reason:null` on ~1,700
// crawls, which the coverage audit then classified as recall gaps. The return
// stays an ARRAY (every caller iterates it) but now carries a NON-ENUMERABLE
// `extraction_failure` ({ class, detail, provider }) and `extraction_status`
// ('ok' | 'empty' | 'failed') — the same pattern webSearchEngine uses for
// `searchMeta`. Read it with `extractionFailureOf(result)`.

import * as cheerio from 'cheerio';
import { getOpenAIOptional, invokeJsonWithFallback } from '../utils/aiProviders.js';
import { buildLinkInventory } from '../crawler-os/blindLinkInventory.js';
import { canonicalizeUrl } from '../crawler-os/urlCanonical.js';
import { extractPageFactsBlind } from '../crawler-os/blindPageFactExtractor.js';
import { mapBlindFactsToCandidate } from '../crawler-os/blindFactsMapper.js';
import { classifyBlindOpportunityKind } from '../crawler-os/blindOpportunityKind.js';
import { OPPORTUNITY_KIND } from '../crawler-os/contract.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('service:webGrantExtractor');

export const MAX_WEB_EXTRACTION_HTML_CHARS = 500_000;
export const MAX_WEB_EXTRACTION_TEXT_CHARS = 12_000;
const MIN_TRUSTWORTHY_PAGE_TEXT_CHARS = 200;
const DEFAULT_EXTRACTION_TIMEOUT_MS = 20_000;

/** Strip a web page to readable text for the model (bounded). */
export function htmlToText(html, maxChars = 6000) {
  if (!html || typeof html !== 'string') return '';
  let $;
  try { $ = cheerio.load(html); } catch { return ''; }
  $('script, style, noscript, svg, header, footer, nav, form, iframe').remove();
  const text = ($('main').text() || $('body').text() || $.root().text() || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxChars);
}

/** Remove site chrome from link evidence without deleting application forms. */
function htmlForLinkInventory(html) {
  if (!html || typeof html !== 'string') return '';
  let $;
  try { $ = cheerio.load(html); } catch { return ''; }
  // Forms and their descendants are intentionally preserved: form[action] and
  // links inside forms are real application targets owned by this page.
  $('script, style, noscript, svg, header, footer, nav, iframe').remove();
  return $.html();
}

function boundedHtml(html) {
  if (typeof html !== 'string') return '';
  return html.length > MAX_WEB_EXTRACTION_HTML_CHARS
    ? html.slice(0, MAX_WEB_EXTRACTION_HTML_CHARS)
    : html;
}

/** The exact failure vocabulary the web lane's stage ledger tallies. */
export const EXTRACTION_FAILURE_CLASSES = Object.freeze([
  'llm_unavailable', 'llm_quota', 'llm_timeout', 'parse_error', 'page_too_short', 'unknown',
]);

const QUOTA_RX = /quota|credit|billing|insufficient|rate[_ ]?limit|\b429\b|\b402\b/i;

function errText(e) {
  if (e === null || e === undefined) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') {
    const parts = [e.message, e.code, e.type, e.status !== null && e.status !== undefined ? String(e.status) : null, e.reason];
    return parts.filter(Boolean).join(' ');
  }
  return String(e);
}

function looksLikeQuota(e) {
  if (e === null || e === undefined) return false;
  if (typeof e === 'object' && (e.status === 429 || e.status === 402 || e.credit_exhausted === true || e.isCreditExhaustion === true)) return true;
  return QUOTA_RX.test(errText(e));
}

/**
 * PURE: classify an extraction failure from either the provider ladder's
 * result object (`invokeJsonWithFallback` shape: { ok, timedOut, aborted,
 * openaiError, anthropicError, freeRouteErrors }) or a thrown error.
 *
 * @returns {{ class: string, detail: string|null }}
 */
export function classifyExtractionFailure(input) {
  if (input instanceof Error) {
    const msg = input.message || String(input);
    if (/timeout|timed out|abort/i.test(msg) || input.name === 'AbortError') return { class: 'llm_timeout', detail: msg.slice(0, 160) };
    if (looksLikeQuota(input)) return { class: 'llm_quota', detail: msg.slice(0, 160) };
    return { class: 'unknown', detail: msg.slice(0, 160) };
  }
  if (!input || typeof input !== 'object') return { class: 'unknown', detail: input === null || input === undefined ? 'no_provider_result' : null };
  if (input.timedOut === true || input.aborted === true) {
    return { class: 'llm_timeout', detail: input.aborted === true ? 'aborted' : 'provider_ladder_timed_out' };
  }
  const errors = [input.openaiError, input.anthropicError, ...(Array.isArray(input.freeRouteErrors) ? input.freeRouteErrors : [])];
  const seen = errors.filter((e) => e !== null && e !== undefined && e !== '');
  if (seen.some(looksLikeQuota)) {
    return { class: 'llm_quota', detail: seen.map(errText).filter(Boolean).join(' | ').slice(0, 200) || 'credit_or_quota_exhausted' };
  }
  if (seen.length === 0) return { class: 'llm_unavailable', detail: errText(input.error) || 'no_provider_configured' };
  return { class: 'llm_unavailable', detail: seen.map(errText).filter(Boolean).join(' | ').slice(0, 200) };
}

/** Read the non-enumerable failure record off an extractor result (null when healthy). */
export function extractionFailureOf(result) {
  const f = result && typeof result === 'object' ? result.extraction_failure : null;
  return f && typeof f === 'object' && f.class ? f : null;
}

function tagResult(list, { status, failure = null, provider = null }) {
  const arr = Array.isArray(list) ? list : [];
  Object.defineProperty(arr, 'extraction_status', { value: status, enumerable: false, configurable: true });
  Object.defineProperty(arr, 'extraction_failure', {
    value: failure ? Object.freeze({ class: failure.class, detail: failure.detail ?? null, provider: provider ?? failure.provider ?? null }) : null,
    enumerable: false,
    configurable: true,
  });
  return arr;
}

function makeProfileBlindLlm(deps = {}, deadlineAt, outcome) {
  const invoke = deps.invoke || invokeJsonWithFallback;
  const openai = deps.openai !== undefined ? deps.openai : getOpenAIOptional();
  const record = (res) => {
    outcome.calls += 1;
    if (res && typeof res === 'object' && res.ok === true) {
      outcome.ok = true;
      outcome.provider = res.provider ?? null;
      outcome.json = res.json ?? null;
    } else {
      outcome.failure = classifyExtractionFailure(res);
    }
    return res;
  };
  return async ({ system, prompt, signal }) => {
    const timeoutMs = deadlineAt - Date.now();
    if (signal?.aborted || timeoutMs <= 0) {
      outcome.calls += 1;
      outcome.failure = { class: 'llm_timeout', detail: signal?.aborted ? 'aborted' : 'deadline_exhausted' };
      return null;
    }
    let call;
    try {
      call = Promise.resolve(invoke({
        openai,
        system,
        prompt,
        temperature: 0.1,
        maxTokens: 1800,
        timeoutMs,
        signal,
        anthropicModel: process.env.WEB_DISCOVERY_MODEL_ANTHROPIC || 'claude-haiku-4-5',
        openaiModel: process.env.WEB_DISCOVERY_MODEL_OPENAI || 'gpt-4o-mini',
      })).then(record, (err) => { outcome.calls += 1; outcome.failure = classifyExtractionFailure(err); throw err; });
    } catch (err) {
      outcome.calls += 1;
      outcome.failure = classifyExtractionFailure(err);
      throw err;
    }
    if (!signal) return call;
    let onAbort;
    try {
      return await Promise.race([
        call,
        new Promise(resolve => {
          onAbort = () => { if (!outcome.ok) outcome.failure = outcome.failure ?? { class: 'llm_timeout', detail: 'aborted' }; resolve(null); };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
}

// Generic scholarship/grant words carry no identity — an award's distinctive
// tokens are what let us match it to its OWN link on a hub page.
const GENERIC_AWARD_WORDS = new Set([
  'scholarship', 'scholarships', 'grant', 'grants', 'award', 'awards', 'fund',
  'foundation', 'program', 'programs', 'fellowship', 'bursary', 'prize',
  'the', 'of', 'for', 'and', 'a', 'an', 'in', 'to', 'college', 'student',
  'students', 'financial', 'aid', 'application', 'apply', 'now', 'more',
  'learn', 'view', 'details', 'annual', 'memorial', 'endowed',
]);

function distinctiveTitleTokens(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !GENERIC_AWARD_WORDS.has(t));
}

function normUrl(u) {
  const c = canonicalizeUrl(String(u || ''), null);
  return c ? c.replace(/\/+$/, '').toLowerCase() : '';
}

/**
 * CRAWL-TIME HUB DECOMPOSITION (owner design ruling 2026-08-23).
 *
 * When more than one distinct award is extracted from ONE page, that page is
 * functioning as a HUB/listing (oregongoestocollege.org/pay/scholarships served
 * both "The Coolidge Scholarship" and "Live Más Scholarship" AND a "General
 * Manager" job posting, each stamped with the LISTING URL as its apply target —
 * the measured Coolidge/Live Más class). A hub is a SOURCE, not an apply target:
 * an award's apply_url must be a page-OWN OUTBOUND link (a real anchor on the
 * page, distinct from the page's own URL), or nothing at all.
 *
 * So for a multi-award page, each award's apply_url is kept ONLY when it is a
 * real outbound link in the page's inventory that is not the page itself.
 * Otherwise Hamilton's fabrication discipline applies: try to DECOMPOSE — find
 * the award's OWN link by matching its distinctive title tokens to an anchor,
 * adopting it only on an UNAMBIGUOUS single match; failing that, null the
 * apply_url (info-only research lead pointing at the hub via info_url), never a
 * false "apply here" that sends every applicant to the listing.
 *
 * A SINGLE-award page is untouched: applying on the page itself (a real
 * application form — the U.S. Bank scholarship form) is legitimate.
 */
export function decomposeHubApplyTargets(candidates, { pageUrl, linkInventory }) {
  const reals = candidates.filter((c) => !c.is_directory && c.apply_url);
  if (reals.length <= 1) return candidates; // single-award page or none — leave alone
  const pageKey = normUrl(pageUrl);
  const inventory = Array.isArray(linkInventory) ? linkInventory : [];
  const outboundKeys = new Set(
    inventory.map((l) => normUrl(l?.url)).filter((k) => k && k !== pageKey),
  );
  const findOwnLink = (title) => {
    const tokens = distinctiveTitleTokens(title);
    if (tokens.length === 0) return null;
    const matches = inventory.filter((l) => {
      const k = normUrl(l?.url);
      if (!k || k === pageKey) return false;
      const text = String(l?.text || '').toLowerCase();
      return tokens.every((t) => text.includes(t));
    });
    const distinct = [...new Set(matches.map((l) => normUrl(l.url)))];
    return distinct.length === 1 ? matches.find((l) => normUrl(l.url) === distinct[0]).url : null;
  };
  return candidates.map((c) => {
    if (c.is_directory || !c.apply_url) return c;
    const key = normUrl(c.apply_url);
    // A real per-award outbound link on the page → keep it.
    if (key && key !== pageKey && outboundKeys.has(key)) return c;
    // Otherwise the apply_url is the hub itself (or off-page). Decompose to the
    // award's own link, else demote to info-only.
    const own = findOwnLink(c.title);
    if (own) {
      return { ...c, apply_url: own, raw: { ...(c.raw || {}), hub_decomposed: true, hub_page: pageUrl } };
    }
    return {
      ...c,
      apply_url: null,
      info_url: c.info_url || c.raw?.page_url || pageUrl,
      raw: { ...(c.raw || {}), hub_apply_url_stripped: true, hub_page: pageUrl },
    };
  });
}

/**
 * Extract profile-independent candidates from one fetched page.
 *
 * Backward-compatible callers may still pass `thesis` or `query`; destructuring
 * intentionally ignores them. That is a code-level boundary, not a prompt rule.
 */
export async function extractOpportunitiesFromPage(
  { pageUrl, html } = {},
  deps = {},
) {
  const cappedHtml = boundedHtml(html);
  const pageText = htmlToText(cappedHtml, MAX_WEB_EXTRACTION_TEXT_CHARS);
  if (!pageUrl) return tagResult([], { status: 'failed', failure: { class: 'unknown', detail: 'no_page_url' } });
  if (pageText.length < MIN_TRUSTWORTHY_PAGE_TEXT_CHARS) {
    return tagResult([], { status: 'failed', failure: { class: 'page_too_short', detail: `text_chars=${pageText.length}<${MIN_TRUSTWORTHY_PAGE_TEXT_CHARS}` } });
  }

  const linkInventory = buildLinkInventory(htmlForLinkInventory(cappedHtml), { baseUrl: pageUrl });
  const timeoutMs = Number.isFinite(Number(deps.timeoutMs)) && Number(deps.timeoutMs) > 0
    ? Number(deps.timeoutMs)
    : DEFAULT_EXTRACTION_TIMEOUT_MS;

  // The provider outcome is recorded by the LLM wrapper: extractPageFactsBlind
  // deliberately never throws (every failure is [] inside it), so this is the
  // ONLY place the failure class can be observed.
  const outcome = { calls: 0, ok: false, failure: null, provider: null, json: null };
  let facts = [];
  try {
    facts = await extractPageFactsBlind(
      { pageUrl, pageText, linkInventory },
      {
        llm: makeProfileBlindLlm(deps, Date.now() + timeoutMs, outcome),
        timeoutMs,
        signal: deps.signal,
      },
    );
  } catch (err) {
    log.warn(`[webGrantExtractor] profile-blind extraction failed for ${pageUrl}: ${err?.message ?? err}`);
    return tagResult([], { status: 'failed', failure: outcome.failure ?? classifyExtractionFailure(err), provider: outcome.provider });
  }
  if (outcome.failure && !outcome.ok) {
    log.warn(`[webGrantExtractor] extraction failed (${outcome.failure.class}) for ${pageUrl}: ${outcome.failure.detail ?? ''}`);
    return tagResult([], { status: 'failed', failure: outcome.failure, provider: outcome.provider });
  }
  if (outcome.calls === 0) {
    // extractPageFactsBlind bailed before asking the model (unparseable page
    // URL scheme, sanitizer refusal). Not a provider fact — but not a healthy
    // empty either.
    return tagResult([], { status: 'failed', failure: { class: 'unknown', detail: 'llm_not_invoked' } });
  }
  if (outcome.ok && !(outcome.json && Array.isArray(outcome.json.opportunities))) {
    return tagResult([], { status: 'failed', failure: { class: 'parse_error', detail: 'provider_answer_missing_opportunities_array' }, provider: outcome.provider });
  }

  const classified = (Array.isArray(facts) ? facts : [])
    .map(mapBlindFactsToCandidate)
    .filter(Boolean)
    .map((candidate) => {
      const { kind: blindKind, trust: blindTrust } = classifyBlindOpportunityKind({
        candidate,
        linkInventory,
        pageText,
      });
      const kind = blindKind === 'AGGREGATOR_INDEX'
        ? OPPORTUNITY_KIND.DIRECTORY
        : candidate.kind;
      const isDirectory = kind === OPPORTUNITY_KIND.DIRECTORY;
      const pageInfoUrl = candidate.raw?.page_url || candidate.info_url || null;
      return {
        ...candidate,
        kind,
        is_directory: isDirectory,
        // A list/index can contain child application links. Those links belong to
        // child opportunities, not to the directory itself, so the directory
        // record must never expose one as its own application action.
        apply_url: isDirectory ? null : candidate.apply_url,
        info_url: isDirectory ? pageInfoUrl : candidate.info_url,
        raw: {
          ...(candidate.raw || {}),
          blind_kind: blindKind,
          blind_trust: blindTrust,
          ...(isDirectory && candidate.apply_url
            ? { directory_child_apply_url: candidate.apply_url }
            : {}),
        },
      };
    });

  // CRAWL-TIME HUB DECOMPOSITION: a multi-award page's per-award apply targets
  // must be page-OWN outbound links, never the hub URL (owner ruling
  // 2026-08-23). This is the ROOT fix for the Coolidge/Live Más class — the
  // enforceSharedListingApplicationTargets boot sweep (#1324) is only the net.
  const decomposed = decomposeHubApplyTargets(classified, { pageUrl, linkInventory });
  return tagResult(decomposed, { status: decomposed.length > 0 ? 'ok' : 'empty', provider: outcome.provider });
}

export default {
  extractOpportunitiesFromPage,
  htmlToText,
  decomposeHubApplyTargets,
  classifyExtractionFailure,
  extractionFailureOf,
  EXTRACTION_FAILURE_CLASSES,
};
