// backend/services/webGrantExtractor.js
//
// The missing "LLM extraction" half of open-web funding discovery. Given a real
// fetched web page and the applicant's funding thesis, extract ONLY real,
// currently-open funding opportunities the applicant could actually apply for —
// structured (funder, deadline, amount, eligibility, apply URL) so they can flow
// through the Crawler OS reality gate + matcher like any federal-API candidate.
//
// Strictly best-effort: any failure (no LLM key, bad JSON, junk page) yields [].
// The model is told to invent nothing and to drop closed/expired/directory pages.

import * as cheerio from 'cheerio';
import { getOpenAIOptional, invokeJsonWithFallback } from '../utils/aiProviders.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('service:webGrantExtractor');

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

/** One-line applicant description for the extraction prompt. */
function describeThesis(thesis = {}) {
  const types = (thesis.applicant_types || []).filter((t) => t && t !== '*');
  const loc = thesis.location || {};
  const where = [loc.city, loc.county, loc.state].filter(Boolean).join(', ');
  const needs = (thesis.needs || []).slice(0, 8);
  const parts = [];
  parts.push(`Applicant type: ${types.length ? types.join(', ') : 'unspecified'}`);
  if (where) parts.push(`Location: ${where}`);
  if (needs.length) parts.push(`Funding needs / focus: ${needs.join(', ')}`);
  if (thesis.is_org) parts.push('This is an organization (not an individual).');
  if (thesis.is_student) parts.push('This is a student (scholarships are relevant).');
  if (!thesis.loan_allowed) parts.push('Does NOT want loans — grants/awards only.');
  return parts.join('\n');
}

const SYSTEM = [
  'You are a meticulous grant-research analyst.',
  'From the provided web page, extract ONLY real, currently-open funding opportunities',
  '(grants, scholarships, fellowships, or standing funding programs) that the specific',
  'applicant described could actually apply for.',
  'Hard rules:',
  '- Invent NOTHING. Every field must be supported by the page text.',
  '- EXCLUDE closed/expired opportunities, pure directories/lists, news articles,',
  '  blog posts, login pages, and anything that is not an applyable funding opportunity.',
  '- If the page is not a real funding opportunity for this applicant, return an empty list.',
  '- A loan is NOT a grant; only include loans if the applicant allows loans.',
].join(' ');

/**
 * extractOpportunitiesFromPage — run the LLM extraction for one page.
 *
 * @param {object} args
 * @param {string} args.pageUrl
 * @param {string} args.html
 * @param {object} args.thesis
 * @param {string} [args.query]
 * @param {object} [deps]   injectable: { invoke, openai } for tests
 * @returns {Promise<Array<object>>} raw extracted opportunity objects (pre-reality-gate)
 */
export async function extractOpportunitiesFromPage(
  { pageUrl, html, thesis = {}, query = '' } = {},
  deps = {},
) {
  const invoke = deps.invoke || invokeJsonWithFallback;
  const text = htmlToText(html);
  if (text.length < 200) return []; // not enough real content to trust

  const prompt = [
    `APPLICANT PROFILE:\n${describeThesis(thesis)}`,
    `PAGE URL: ${pageUrl}`,
    query ? `FOUND VIA SEARCH: ${query}` : '',
    `PAGE TEXT:\n${text}`,
    '',
    'Return JSON of this exact shape:',
    '{"opportunities":[{',
    '"title": string,',
    '"funder": string,                // the organization giving the money',
    '"summary": string,               // 1-2 sentences, from the page',
    '"eligibility": string,           // who can apply',
    '"amount_min": number|null, "amount_max": number|null,',
    '"deadline": "YYYY-MM-DD"|"rolling"|null,',
    '"apply_url": string,             // real https URL to apply/details on this site; if unknown use the PAGE URL',
    '"national": boolean, "state": "XX"|null,',
    '"is_loan": boolean,',
    '"relevant": boolean,             // true ONLY if a strong fit for THIS applicant',
    '"relevance_reason": string',
    '}]}',
    'If there are no real, open, relevant opportunities on this page, return {"opportunities":[]}.',
  ].filter(Boolean).join('\n');

  let res;
  try {
    res = await invoke({
      openai: deps.openai !== undefined ? deps.openai : getOpenAIOptional(),
      system: SYSTEM,
      prompt,
      temperature: 0.1,
      maxTokens: 1600,
      anthropicModel: process.env.WEB_DISCOVERY_MODEL_ANTHROPIC || 'claude-haiku-4-5',
      openaiModel: process.env.WEB_DISCOVERY_MODEL_OPENAI || 'gpt-4o-mini',
    });
  } catch (err) {
    log.warn(`[webGrantExtractor] extraction failed for ${pageUrl}: ${err?.message ?? err}`);
    return [];
  }
  if (!res?.ok || !res.json) return [];
  const list = Array.isArray(res.json.opportunities) ? res.json.opportunities : [];
  // Keep only model-marked-relevant rows with the minimum identity fields.
  return list.filter(
    (o) => o && o.relevant !== false && o.title && (o.funder || o.sponsor),
  );
}

export default { extractOpportunitiesFromPage, htmlToText };
