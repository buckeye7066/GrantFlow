// crawler-os/blindEvidenceValidator.js
//
// Phase 1a of the web-lane de-contamination program: the EVIDENCE-SPAN
// validator. An LLM extractor can assert a fact and attach an `evidence_snippet`
// that never appeared on the page (a paraphrase, a hallucination, or a snippet
// from its own training). This module CODE-VERIFIES every evidence_snippet: it
// must be a MEANINGFUL, normalized substring of the actual page text, or the
// fact is dropped. We never trust the model's claim that a snippet is real.
//
// CRUCIAL (the finding this closes): dropping a provenance entry is NOT enough —
// the corresponding TOP-LEVEL fact value must also be NEUTRALIZED, or a mapper
// downstream reads the fabricated value even though its citation was rejected.
// A load-bearing fact (eligibility, amount, the tri-state loan/cost-share/
// national, geography states) is EMITTED ONLY IF it carries a surviving evidence
// span; otherwise it is reset to its neutral/unknown value.
//
// PURE. No I/O, no profile input. Operates on ONE page-fact object; the input is
// never mutated (a shallow clone is returned).

// A snippet shorter than this (after normalization) is not a meaningful citation
// — a 1-char "a" or a stray token can be found on almost any page. It must also
// contain at least one alphanumeric character.
export const MIN_EVIDENCE_SNIPPET_CHARS = 6;

/**
 * The load-bearing facts that REQUIRE a surviving evidence span. Each maps a
 * `field_provenance` key to: an `isSet` predicate (is a non-neutral top-level
 * value present?) and a `neutralize` that resets the top-level value(s) to the
 * neutral/unknown state. Keys NOT listed here (e.g. title/sponsor/summary) are
 * page-derived by the extractor and are not snippet-gated.
 */
const LOAD_BEARING_FACTS = [
  {
    key: 'eligibility',
    isSet: (f) => (typeof f.eligibility_text === 'string' && f.eligibility_text.trim() !== '') ||
      (Array.isArray(f.eligibility_bullets) && f.eligibility_bullets.length > 0),
    neutralize: (f) => { f.eligibility_text = null; f.eligibility_bullets = []; },
  },
  {
    key: 'deadline',
    isSet: (f) => (typeof f.deadline === 'string' && f.deadline.trim() !== '') || f.is_rolling === true,
    neutralize: (f) => { f.deadline = null; f.is_rolling = false; },
  },
  {
    key: 'amount',
    isSet: (f) => f.amount_min != null || f.amount_max != null,
    neutralize: (f) => { f.amount_min = null; f.amount_max = null; },
  },
  {
    key: 'is_loan',
    isSet: (f) => f.is_loan === true,
    neutralize: (f) => { f.is_loan = false; },
  },
  {
    key: 'requires_cost_share',
    isSet: (f) => f.requires_cost_share === true,
    neutralize: (f) => { f.requires_cost_share = false; },
  },
  {
    key: 'national',
    isSet: (f) => f.geography && f.geography.national === true,
    neutralize: (f) => { f.geography = { ...(f.geography || {}), national: false }; },
  },
  {
    key: 'geography',
    isSet: (f) => f.geography && Array.isArray(f.geography.states) && f.geography.states.length > 0,
    neutralize: (f) => { f.geography = { ...(f.geography || {}), states: [] }; },
  },
];

/**
 * Normalize text for substring comparison: lowercase, collapse all whitespace
 * (incl. non-breaking spaces, which JS `\s` matches) to single spaces, trim.
 * Absorbs cosmetic differences (line wraps, doubled spaces, case) WITHOUT
 * letting a different string match.
 */
export function normalizeForEvidence(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Is `snippet` a MEANINGFUL, real, normalized substring of `pageText`? Rejects:
 * an empty/blank snippet, one shorter than MIN_EVIDENCE_SNIPPET_CHARS, one with
 * no alphanumeric character, and one not present in the page.
 */
export function isSupportedSnippet(snippet, pageText) {
  const needle = normalizeForEvidence(snippet);
  if (needle.length < MIN_EVIDENCE_SNIPPET_CHARS) return false;
  if (!/[a-z0-9]/.test(needle)) return false; // must carry real content, not punctuation
  const hay = normalizeForEvidence(pageText);
  if (!hay) return false;
  return hay.includes(needle);
}

/**
 * validateEvidenceSpans — verify every `evidence_snippet` in `field_provenance`
 * against the source page text AND neutralize any load-bearing top-level fact
 * that lacks a surviving span.
 *
 * Pure: returns a NEW facts object; the input is never mutated.
 *
 * @param {object} pageFacts a single page-fact object (Phase-0.1 shape).
 * @param {string} pageText the source page text the facts were extracted from.
 * @returns {{ facts:object, dropped:Array<{field:string, reason?:string,
 *   evidence_snippet?:string}>, kept:number }}
 */
export function validateEvidenceSpans(pageFacts, pageText) {
  const dropped = [];
  if (!pageFacts || typeof pageFacts !== 'object' || Array.isArray(pageFacts)) {
    return { facts: pageFacts, dropped, kept: 0 };
  }
  // Shallow clone; nested `geography` is only ever REPLACED (never mutated), so a
  // shallow copy is enough to keep the input pristine.
  const facts = { ...pageFacts };

  const prov = facts.field_provenance;
  const cleanedProv = {};
  let kept = 0;
  if (prov && typeof prov === 'object' && !Array.isArray(prov)) {
    for (const [field, entry] of Object.entries(prov)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        dropped.push({ field, reason: 'malformed_entry' });
        continue;
      }
      // EVERY provenance entry must carry a meaningful, page-supported snippet.
      // A missing/blank/too-short/unsupported snippet is not evidence — dropped.
      if (isSupportedSnippet(entry.evidence_snippet, pageText)) {
        cleanedProv[field] = entry;
        kept += 1;
      } else {
        dropped.push({ field, evidence_snippet: String(entry.evidence_snippet ?? '').slice(0, 200) });
      }
    }
  }
  facts.field_provenance = Object.keys(cleanedProv).length ? cleanedProv : null;

  // Neutralize every load-bearing fact whose evidence did not survive (its span
  // was dropped OR it never had one). This is what stops a fabricated value from
  // reaching the mapper after its citation was rejected.
  for (const cfg of LOAD_BEARING_FACTS) {
    if (!cleanedProv[cfg.key] && cfg.isSet(facts)) {
      cfg.neutralize(facts);
      if (!dropped.some((d) => d.field === cfg.key)) {
        dropped.push({ field: cfg.key, reason: 'unevidenced' });
      }
    }
  }

  if (dropped.length) {
    // Non-scoring metadata: record what was rejected so the crawler doctor / a
    // later reviewer can see the model cited (or asserted) something unsupported.
    facts.evidence_validation = { dropped };
  }
  return { facts, dropped, kept };
}

export default {
  validateEvidenceSpans,
  isSupportedSnippet,
  normalizeForEvidence,
  MIN_EVIDENCE_SNIPPET_CHARS,
};
