// crawler-os/blindPageFactExtractor.js
//
// Phase 1a of the web-lane de-contamination program: the PROFILE-BLIND page-fact
// extractor.
//
// WHY THIS EXISTS. The live web extractor (services/webGrantExtractor.js) is
// PROFILE-CONDITIONED: it is told the applicant's thesis and asked to keep only
// "opportunities THIS applicant could apply for" and to mark each `relevant`.
// That makes the LLM a hidden second scorer competing with the canonical match
// engine — eligibility/geo decisions leak into extraction instead of being
// decided once, deterministically, downstream. This module extracts what the
// page FACTUALLY states — with NO thesis, query, profile, or seed in its inputs
// (assert it: the signature has no such parameter) — so the match engine remains
// the sole authority on fit.
//
// GUARANTEES
//   - PROFILE-BLIND: inputs are { pageUrl, pageText, linkInventory } only.
//   - INJECTED LLM: `deps.llm` is a function; tests pass a deterministic mock.
//   - DETERMINISTIC: same page + same (mocked) LLM output => byte-identical
//     facts. No timestamps, no randomness, no profile to vary.
//   - GROUNDED URLS: the model SELECTS an apply/info link by inventory id; code
//     constructs the URL from the inventory and REJECTS any URL not in it.
//   - SAFE PARSING: malformed LLM output => [] (never throws).

import {
  cleanEligibilityText,
  cleanEligibilityBullets,
} from './pageFacts.js';
import { resolveInventoryLink, canonicalizeUrl } from './blindLinkInventory.js';
import { validateEvidenceSpans } from './blindEvidenceValidator.js';

// Version tags — these become content-addressing components for the Phase-0.2
// page-fact cache (services/pageFactCache.js) when this module is wired in a
// later sub-PR. Bump when the prompt or output shape changes.
export const EXTRACTOR_VERSION = 'blind-v1';
export const PROMPT_VERSION = 'blind-prompt-v1';
export const PAGE_FACT_SCHEMA_VERSION = 1;

// The feature flag that a LATER sub-PR will gate the live wiring on. Defined here
// (default OFF) so the name is registered, but NOTHING reads it in this PR — this
// module is additive and unused by the live lane.
export const WEB_LANE_PROFILE_BLIND_FLAG = 'WEB_LANE_PROFILE_BLIND';

const SYSTEM = [
  'You are a meticulous, literal grant-page reader.',
  'Extract every distinct funding opportunity (grant, scholarship, fellowship, or',
  'standing funding program) that the page FACTUALLY describes.',
  'Rules:',
  '- Report ONLY what the page states. Invent NOTHING. Do NOT judge whether any',
  '  particular applicant is eligible — just record the eligibility the page states.',
  '- Do NOT decide relevance, fit, or ranking. That is decided elsewhere.',
  '- For an apply/info link, choose an id from LINK INVENTORY. NEVER write a URL',
  '  that is not in the inventory; if no suitable link exists, use null.',
  '- For each fact you assert, quote the exact supporting substring from PAGE TEXT',
  '  in the `evidence` object. If you cannot quote it from the page, omit the fact.',
].join(' ');

/** Coerce whatever the injected LLM returns into a parsed object, or null. */
function coerceLlmJson(res) {
  if (res == null) return null;
  if (typeof res === 'object') {
    // Common shapes: { json }, { text }, or the object itself.
    if (res.json && typeof res.json === 'object') return res.json;
    if (typeof res.text === 'string') return parseJsonLoose(res.text);
    if (typeof res.content === 'string') return parseJsonLoose(res.content);
    return res;
  }
  if (typeof res === 'string') return parseJsonLoose(res);
  return null;
}

/** Parse JSON from a string, tolerating a ```json fence or surrounding prose. */
function parseJsonLoose(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  try { return JSON.parse(str); } catch { /* fall through */ }
  // ```json ... ``` fence
  const fence = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ }
  }
  // First balanced-looking {...}
  const first = str.indexOf('{');
  const last = str.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(str.slice(first, last + 1)); } catch { /* fall through */ }
  }
  return null;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(v) {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function cleanStates(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const s of v) {
    const code = String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
    if (code.length === 2 && !out.includes(code)) out.push(code);
  }
  return out;
}

function cleanNeeds(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const n of v) {
    const s = String(n || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (s && s.length <= 60 && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 12);
}

/** Add a provenance entry ONLY when a real value AND a string snippet are present. */
function addProvenance(prov, key, value, snippet, source) {
  if (value === null || value === undefined) return;
  const snip = typeof snippet === 'string' ? snippet.trim() : '';
  if (!snip) return; // no citation => not recorded as provenance (blind + grounded)
  prov[key] = { value, evidence_snippet: snip, source };
}

/**
 * Build ONE page-fact object from a raw model opportunity + the link inventory.
 * Returns null if it lacks a concrete title AND sponsor (nothing to anchor on).
 */
function buildFacts(rawOpp, { pageUrl, pageUrlCanon, linkInventory }) {
  if (!rawOpp || typeof rawOpp !== 'object') return null;
  const title = String(rawOpp.title || '').replace(/\s+/g, ' ').trim();
  const sponsor = String(rawOpp.funder || rawOpp.sponsor || '').replace(/\s+/g, ' ').trim();
  if (!title || !sponsor) return null;

  const ev = (rawOpp.evidence && typeof rawOpp.evidence === 'object' && !Array.isArray(rawOpp.evidence))
    ? rawOpp.evidence : {};

  // --- Link selection: id (or url) MUST resolve inside the inventory ----------
  const applyEntry =
    resolveInventoryLink(linkInventory, rawOpp.apply_link_id, pageUrl) ||
    resolveInventoryLink(linkInventory, rawOpp.apply_url, pageUrl);
  const infoEntry =
    resolveInventoryLink(linkInventory, rawOpp.info_link_id, pageUrl) ||
    resolveInventoryLink(linkInventory, rawOpp.info_url, pageUrl);

  // apply_url is a REAL, distinct-from-the-page application link, or null. A
  // link that is just the page itself is a fallback, and a fallback NEVER lands
  // in apply_url — it goes to info_url below.
  let apply_url = applyEntry && applyEntry.url !== pageUrlCanon ? applyEntry.url : null;
  let info_url = infoEntry ? infoEntry.url : null;
  if (info_url && info_url === apply_url) info_url = null; // keep the two distinct
  // Fallback (no real apply link found): record page_url as info_url, never apply.
  if (!apply_url && !info_url) info_url = pageUrlCanon;

  const eligibility_text = cleanEligibilityText(rawOpp.eligibility_text);
  const eligibility_bullets = cleanEligibilityBullets(rawOpp.eligibility_bullets);
  const amount_min = numOrNull(rawOpp.amount_min);
  const amount_max = numOrNull(rawOpp.amount_max);
  const national = boolOrNull(rawOpp.national);
  const states = cleanStates(rawOpp.states);
  const is_loan = boolOrNull(rawOpp.is_loan);
  const requires_cost_share = boolOrNull(rawOpp.requires_cost_share);
  const need_categories = cleanNeeds(rawOpp.need_categories);

  // field_provenance: canonical tri-state keys (is_loan / requires_cost_share /
  // national) + eligibility + amount, each ONLY when the model cited page text.
  const field_provenance = {};
  addProvenance(field_provenance, 'eligibility', eligibility_text, ev.eligibility, pageUrl);
  if (amount_min !== null || amount_max !== null) {
    addProvenance(field_provenance, 'amount', { amount_min, amount_max }, ev.amount, pageUrl);
  }
  addProvenance(field_provenance, 'is_loan', is_loan, ev.is_loan, pageUrl);
  addProvenance(field_provenance, 'requires_cost_share', requires_cost_share, ev.requires_cost_share, pageUrl);
  addProvenance(field_provenance, 'national', national, ev.national, pageUrl);

  const facts = {
    title,
    sponsor,
    summary: (String(rawOpp.summary || '').replace(/\s+/g, ' ').trim() || null)?.slice(0, 800) ?? null,
    eligibility_text,
    eligibility_bullets,
    need_categories,
    geography: { national: national === true, states, states_stated: national !== null || states.length > 0 },
    amount_min,
    amount_max,
    is_loan: is_loan === true,
    requires_cost_share: requires_cost_share === true,
    page_url: pageUrlCanon,
    info_url,
    apply_url,
    field_provenance: Object.keys(field_provenance).length ? field_provenance : null,
    page_fact_schema_version: PAGE_FACT_SCHEMA_VERSION,
    extractor_version: EXTRACTOR_VERSION,
  };
  return facts;
}

/**
 * extractPageFactsBlind — extract profile-blind page facts for one page.
 *
 * @param {{ pageUrl:string, pageText:string, linkInventory:Array }} input
 *   NOTE: no thesis / query / profile / seed — profile-blindness is enforced by
 *   the SIGNATURE, not by discipline.
 * @param {{ llm: Function }} deps  `llm` is an async function
 *   `({ system, prompt }) => string|object` (a JSON string or parsed object).
 * @returns {Promise<Array<object>>} page-fact objects (Phase-0.1 shape), evidence
 *   spans validated. [] on any malformed/empty/failed extraction (never throws).
 */
export async function extractPageFactsBlind(input = {}, deps = {}) {
  const { pageUrl, pageText, linkInventory } = input;
  const llm = deps.llm;
  if (typeof llm !== 'function') return [];
  if (!pageUrl || typeof pageText !== 'string' || pageText.trim().length < 40) return [];
  const inventory = Array.isArray(linkInventory) ? linkInventory : [];
  const pageUrlCanon = canonicalizeUrl(pageUrl) || String(pageUrl);

  const prompt = [
    `PAGE URL: ${pageUrlCanon}`,
    '',
    'LINK INVENTORY (choose apply/info links by these ids ONLY):',
    inventory.length
      ? inventory.map((l) => `  ${l.id}\t${l.apply_intent ? '[apply]' : '[info ]'}\t${l.text || '(no text)'}\t${l.url}`).join('\n')
      : '  (none)',
    '',
    'PAGE TEXT:',
    pageText.slice(0, 12000),
    '',
    'Return JSON of EXACTLY this shape:',
    '{"opportunities":[{',
    '  "title": string, "funder": string, "summary": string,',
    '  "eligibility_text": string, "eligibility_bullets": string[],',
    '  "need_categories": string[],',
    '  "amount_min": number|null, "amount_max": number|null,',
    '  "national": boolean|null, "states": string[],',
    '  "is_loan": boolean|null, "requires_cost_share": boolean|null,',
    '  "apply_link_id": string|null, "info_link_id": string|null,',
    '  "evidence": { "eligibility": string, "amount": string, "is_loan": string, "requires_cost_share": string, "national": string }',
    '}]}',
    'If the page describes no funding opportunity, return {"opportunities":[]}.',
  ].join('\n');

  let raw;
  try {
    raw = await llm({ system: SYSTEM, prompt });
  } catch {
    return []; // an LLM failure is an empty extraction, never a throw
  }

  const parsed = coerceLlmJson(raw);
  const list = parsed && Array.isArray(parsed.opportunities) ? parsed.opportunities : [];
  const out = [];
  for (const rawOpp of list) {
    let facts;
    try {
      facts = buildFacts(rawOpp, { pageUrl, pageUrlCanon, linkInventory: inventory });
    } catch {
      facts = null;
    }
    if (!facts) continue;
    // CODE-VERIFY every evidence snippet against the real page text; drop any the
    // model cited that is not actually on the page.
    const { facts: validated } = validateEvidenceSpans(facts, pageText);
    out.push(validated);
  }
  return out;
}

export default { extractPageFactsBlind, EXTRACTOR_VERSION, PROMPT_VERSION, WEB_LANE_PROFILE_BLIND_FLAG };
