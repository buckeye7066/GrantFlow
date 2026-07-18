// crawler-os/blindEvidenceValidator.js
//
// Phase 1a of the web-lane de-contamination program: the EVIDENCE-SPAN
// validator. An LLM extractor can assert a fact and attach an `evidence_snippet`
// that never appeared on the page (a paraphrase, a hallucination, or a snippet
// from its own training). This module CODE-VERIFIES every evidence_snippet: it
// must be a normalized substring of the actual page text, or the fact is dropped
// and flagged. We never trust the model's claim that a snippet is real.
//
// PURE. No I/O, no profile input. Operates on ONE page-fact object.

/**
 * Normalize text for substring comparison: lowercase, collapse all whitespace
 * (incl. non-breaking spaces) to single spaces, trim. This absorbs the cosmetic
 * differences (line wraps, doubled spaces, case) between how the model quotes a
 * snippet and how it sits in the source, WITHOUT letting a different string match.
 */
export function normalizeForEvidence(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Is `snippet` a real, normalized substring of `pageText`? An empty/blank
 * snippet is NOT evidence (returns false) — a fact must cite something.
 */
export function isSupportedSnippet(snippet, pageText) {
  const needle = normalizeForEvidence(snippet);
  if (!needle) return false;
  const hay = normalizeForEvidence(pageText);
  if (!hay) return false;
  return hay.includes(needle);
}

/**
 * validateEvidenceSpans — verify every `evidence_snippet` inside a page-fact
 * object's `field_provenance` against the source page text. A provenance entry
 * whose snippet is NOT found on the page is DROPPED from field_provenance and
 * recorded in `dropped`. Entries that carry no `evidence_snippet` at all are
 * left untouched (the caller decides how strict to be about un-cited facts;
 * this validator only rejects snippets that are demonstrably NOT on the page).
 *
 * Pure: returns a NEW facts object; the input is never mutated.
 *
 * @param {object} pageFacts a single page-fact object (Phase-0.1 shape).
 * @param {string} pageText the source page text the facts were extracted from.
 * @returns {{ facts:object, dropped:Array<{field:string, evidence_snippet:string}>,
 *   kept:number }}
 */
export function validateEvidenceSpans(pageFacts, pageText) {
  const dropped = [];
  if (!pageFacts || typeof pageFacts !== 'object') {
    return { facts: pageFacts, dropped, kept: 0 };
  }
  const prov = pageFacts.field_provenance;
  if (!prov || typeof prov !== 'object' || Array.isArray(prov)) {
    return { facts: pageFacts, dropped, kept: 0 };
  }

  const cleanedProv = {};
  let kept = 0;
  for (const [field, entry] of Object.entries(prov)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const snippet = entry.evidence_snippet;
    // A provenance entry with NO snippet is not snippet-verifiable — keep it as
    // stated (its `value` still carries the tri-state fact). Only a PRESENT but
    // unsupported snippet is a lie, and that is what we drop.
    if (snippet == null || snippet === '') {
      cleanedProv[field] = entry;
      continue;
    }
    if (isSupportedSnippet(snippet, pageText)) {
      cleanedProv[field] = entry;
      kept += 1;
    } else {
      dropped.push({ field, evidence_snippet: String(snippet).slice(0, 200) });
    }
  }

  const facts = {
    ...pageFacts,
    field_provenance: Object.keys(cleanedProv).length ? cleanedProv : null,
  };
  if (dropped.length) {
    // Non-scoring metadata: record what was rejected so the crawler doctor / a
    // later reviewer can see the model tried to cite something that wasn't there.
    facts.evidence_validation = { dropped };
  }
  return { facts, dropped, kept };
}

export default { validateEvidenceSpans, isSupportedSnippet, normalizeForEvidence };
