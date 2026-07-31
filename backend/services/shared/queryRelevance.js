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

/**
 * isWeakResult — is this ONE result the first-word-collapse signature?
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
 *   - it covers EXACTLY the query's first distinctive term and nothing else
 *     (a page about the state/city, not about the need).
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
  const covered = coveredTerms(result, terms)
  if (covered.length === 0) return true
  return covered.length === 1 && covered[0] === terms[0]
}

/**
 * partitionByRelevance — stable split into [strong, weak].
 *
 * Order WITHIN each group is preserved, so a caller that concatenates
 * `[...strong, ...weak]` gets the engine's original ranking with the
 * first-word junk demoted rather than removed. That is what makes this safe:
 * the caller's `count` budget is filled with real sources when they exist, and
 * falls back to exactly the old result set when they do not.
 */
export function partitionByRelevance(query, results) {
  const strong = []
  const weak = []
  for (const r of Array.isArray(results) ? results : []) {
    if (isWeakResult(query, r)) weak.push(r)
    else strong.push(r)
  }
  return { strong, weak }
}
