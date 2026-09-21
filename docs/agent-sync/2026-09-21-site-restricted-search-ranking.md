# Site-restricted search ranking

## Changed

The shared relevance tokenizer now excludes `site:` and `filetype:` restrictions
from subject terms. A live search for
`site:grants.gov "notice of funding opportunity" 2026` placed dictionary entries
for "notice" in positions one and four because `site` became the first
distinctive term. The first-word-collapse detector therefore missed the junk.
Both provider ranking and the search fallback detector consume this tokenizer.
Weak results remain available as backfill; eligibility and acceptance policies
are unchanged.

## Verified

The captured dictionary regression failed against the previous implementation.
After the repair, all 79 tests across relevance, SearXNG provider, search engine,
cache, and cancellation suites passed. Targeted ESLint passed.

A fresh live SearXNG request with `WEB_SEARCH_CACHE_TTL_HOURS=0` returned funding
notices and the federal eligibility page in all five slots, with live/ok
provenance. The previous cached response was explicitly rejected as validation
of the repair. Local receipt: `audit-reports/search-ranking-live-20260921.json`.

The existing production public smoke also passed, including backend readiness
and the public profile schema. That probe predates deployment of this repair.

## Still required

This ranking repair is not a passing exact-50 result. The canonical runner still
requires an authenticated extraction route, clean pinned source, all 50 clean
evaluations, the unchanged web-parity threshold, and cleanup proof. Its current
disposable mode deliberately disables applied learning; durable learning needs
a separate verified handoff and must not be inferred from this search probe.
