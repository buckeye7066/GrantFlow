/**
 * queryRelevance — the SINGLE definition of "does this search result actually
 * answer the query?", shared by every consumer that needs it.
 *
 * Two consumers, one rule:
 *   - searxngProvider  ranks relevant results ahead of weak ones BEFORE it
 *     truncates to the caller's `count`, so the recall budget is spent on real
 *     sources instead of first-word junk.
 *   - webSearchEngine.looksDegenerateSerp  decides whether a WHOLE result set
 *     is first-word junk and should be rerouted to the fallback engines.
 *
 * Keeping the tokenizer in one module is deliberate: the two used to drift
 * (the SERP gate used whole-word matching after substring matching let
 * "western United States" cover the term "west"), and a per-result rule that
 * tokenized differently from the per-SERP rule would make the two disagree
 * about the same SERP.
 *
 * Every function here is pure and exported for tests.
 */

/**
 * Words too generic to prove a result is on-topic. Every GrantFlow discovery
 * query contains several of them ("X disability housing GRANTS"), so counting
 * them as coverage would let any page mentioning "grants" look relevant.
 */
export const DEGENERATE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'near', 'about',
  'grants', 'grant', 'scholarships', 'scholarship', 'assistance', 'programs',
  'program', 'funding', 'financial',
])

/**
 * The query's distinctive terms, in order. Terms shorter than 4 characters and
 * bare numbers are dropped alongside the stopwords: they match too easily to
 * carry evidence.
 */
export function distinctiveTerms(query) {
  return String(query || '')
    .toLowerCase()
    // Site/file-type restrictions select sources, not the user's subject.
    // Counting "site" as the first term made dictionary pages about "notice"
    // look strong for site:grants.gov "notice of funding opportunity".
    .replace(/(^|\s)-?(?:site|filetype):(?:"[^"]*"|'[^']*'|[^\s]+)/g, '$1')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !DEGENERATE_STOPWORDS.has(t) && !/^\d+$/.test(t))
}

/** Whole-word regex for a term, with regex metacharacters escaped. */
function wordRe(term) {
  return new RegExp('\\b' + String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')
}

/**
 * Which of `terms` this result's url + title + snippet actually contains.
 * WHOLE-WORD matching: substring matching let "western United States" count as
 * covering "west", which is how a University-of-West-Florida junk SERP slipped
 * through the SERP gate (verified live 2026-07-27).
 */
export function coveredTerms(result, terms) {
  const hay = `${result?.url ?? ''} ${result?.title ?? ''} ${result?.snippet ?? ''}`.toLowerCase()
  return terms.filter((t) => wordRe(t).test(hay))
}

const FUNDING_EVIDENCE = /\b(?:grants?|scholarships?|fellowships?|bursar(?:y|ies)|funding|financial[ -]aid|financial[ -]assistance|tuition[ -]assistance|(?:government|public|employee|veterans?|disability|unemployment|survivor|retirement|social[ -]security|cash)[ -]benefits?|endowments?)\b/i

function hasFundingEvidence(result) {
  return FUNDING_EVIDENCE.test(`${result?.url ?? ''} ${result?.title ?? ''} ${result?.snippet ?? ''}`)
}

// In a subject-first funding query, the applicant/location suffix cannot
// substitute for the requested subject. Keep short item names (bus, DME)
// here; the broader distinctive-term contract stays unchanged.
function coversFundingSubject(query, result) {
  const clean = String(query || '').toLowerCase().replace(/(^|\s)-?(?:site|filetype):(?:"[^"]*"|'[^']*'|[^\s]+)/g, '$1');
  const intent = /\b(?:grants?|scholarships?|funding|assistance)\b/.exec(clean);
  if (!intent || intent.index === 0) return true;
  const terms = clean.slice(0, intent.index).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(term => term.length >= 3 && !DEGENERATE_STOPWORDS.has(term) && !/^\d+$/.test(term)
      && !['how','can','get','find','are','our','your','any','new'].includes(term));
  return terms.length === 0 || coveredTerms(result, terms).length > 0;
}

/** Shared exception for both ranking and whole-SERP health classification. */
export function hasTopicalFundingEvidence(query, result) {
  return FUNDING_EVIDENCE.test(String(query || '')) && hasFundingEvidence(result)
    && coveredTerms(result, distinctiveTerms(query)).length > 0 && coversFundingSubject(query, result)
}

/**
 * isWeakResult — does this ONE result lack evidence of the query's subject?
 *
 * THE FAILURE THIS CATCHES (measured live 2026-07-31 across 8 profile-shaped
 * queries): the SERP-level gate only asks whether SOME result covers a
 * majority of the query's terms, so a single good hit clears the whole set —
 * and the junk riding along with it was never removed. Live precision of the
 * returned top-8 was 46.9%: "Ohio - Wikipedia", "Texas Maps & Facts",
 * "THE 15 BEST Things to Do in Memphis" were occupying slots that real funders
 * needed, because scraped bing/yahoo answer the query's LEADING TOKEN while
 * yandex/seznam answer the actual question.
 *
 * Weak means one of:
 *   - the result covers NO distinctive term at all, or
 *   - it covers only ONE distinctive term without funding/assistance evidence
 *     (a generic page about a state, city or topic, regardless of word order).
 *
 * A query with fewer than 2 distinctive terms can never be weak — there is
 * nothing to discriminate on, and filtering there would be guesswork. This
 * mirrors looksDegenerateSerp's `terms.length < 2` guard so the per-result and
 * per-SERP rules never disagree.
 *
 * This is a RANKING signal, never a delete: callers must keep weak results as
 * backfill so filtering can only ever reorder, not shrink, a result set.
 */
export function isWeakResult(query, result) {
  const terms = distinctiveTerms(query)
  if (terms.length < 2) return false
  if (!coversFundingSubject(query, result)) return true
  const covered = coveredTerms(result, terms)
  if (covered.length === 0) return true
  if (covered.length > 1) return false
  // A live homeschool/El Paso query ranked Texas hotels ahead of homeschool
  // grants: Texas was not the FIRST token, while homeschool was. Word position
  // cannot distinguish those. Retain single-topic funders, demote generic hits;
  // this remains ranking-only, not proof of eligibility or a deletion gate.
  return !hasFundingEvidence(result)
}

/**
 * partitionByRelevance — stable split into [strong, weak].
 *
 * For funding queries, strong hits with funding evidence precede generic
 * topical pages. Engine order is preserved within each evidence tier; weak
 * hits remain backfill. That is what makes this safe:
 * the caller's `count` budget is filled with real sources when they exist, and
 * falls back to exactly the old result set when they do not.
 */
export function partitionByRelevance(query, results) {
  const funding = []
  const strong = []
  const weak = []
  const seeksFunding = distinctiveTerms(query).length >= 2 && FUNDING_EVIDENCE.test(String(query || ''))
  for (const r of Array.isArray(results) ? results : []) {
    if (isWeakResult(query, r)) weak.push(r)
    else if (seeksFunding && hasFundingEvidence(r)) funding.push(r)
    else strong.push(r)
  }
  return { strong: [...funding, ...strong], weak }
}
