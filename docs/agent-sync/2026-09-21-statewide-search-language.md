# Disambiguate statewide scholarship searches

The live SearXNG query `CA state scholarship programs` led with the Canadian
government's international-scholarship page at educanada.ca. On the same service,
`California state scholarship programs` instead returned California scholarship
and state-funding sources. Search results alone do not establish eligibility.

The shared web-query builder now spells out state names in its statewide
scholarship-program query, using the existing dependency-free state registry. Local
city/state wording and stored geographic codes are unchanged; territory-specific
names and Spanish-language Puerto Rico queries remain intact. The query's core
priority and planner budget are unchanged, and its changed text naturally avoids
reusing cached abbreviated-query results.

The California and Tennessee regressions failed before the repair. All 30 query
planner Node tests and 60 query/web-lane Vitest tests passed, exit 0. The repair
changes query language, not scoring, eligibility, acceptance gates or the model
route. The owner retired the fixed 50-profile benchmark on September 21; this query repair does not establish full workflow acceptance.
