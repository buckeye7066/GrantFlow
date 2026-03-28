# Retrieve-then-Rerank Matching Architecture

This document proposes a practical matching architecture for GrantFlow that improves precision without sacrificing recall. It is intended for opportunity matching, deduplication support, and future pipeline ranking work.

## Why this pattern

A single scoring pass tends to create one of two problems:

- overly strict filtering that misses good opportunities
- overly broad matching that pollutes the pipeline with weak results

A staged **retrieve-then-rerank** design solves both:

1. **Eligibility gates** remove obvious non-matches and hard failures
2. **Candidate retrieval** expands recall using sparse and dense search
3. **Final reranking** blends all signals into one score for ordering and thresholding

This mirrors modern search and recommendation pipelines while remaining simple enough to ship incrementally inside GrantFlow.

---

## Stage 1: Eligibility gates

Eligibility gates are deterministic checks that run before retrieval and reranking.

### Goals

- eliminate obvious false positives early
- preserve low latency
- keep behavior auditable for admins and support staff
- provide explicit rejection reasons for diagnostics

### Recommended gate types

#### 1. Exact identifier matches

Use hard accepts for highly trusted identifiers when present.

Examples:

- UEI exact match
- EIN exact match
- state registration number exact match
- Grants.gov opportunity ID exact match

**Policy:** if an exact identifier match is found for the intended entity or opportunity, mark as high-confidence and skip downstream filters when appropriate.

#### 2. Name and address verification

Use normalized text plus fuzzy similarity.

Examples:

- organization legal name
- DBA / alternate name
- street address
- city/state/ZIP

**Suggested threshold:**

- fuzzy similarity **>= 0.92** for auto-accept when name + address align

#### 3. Entity-type allowlists and denylists

Examples:

- nonprofit
- tribal government
- city or county government
- public school district
- small business / C-corp / LLC
- individual applicant
- disabled applicant

These should be evaluated against both profile data and normalized opportunity eligibility text.

#### 4. NAICS / taxonomy normalization

Normalize NAICS codes to canonical forms and evaluate at multiple levels.

Examples:

- exact NAICS
- 5-digit parent
- 3-digit prefix family

**Suggested policy:**

- exact match = strongest boost
- 3-digit prefix match = strong boost
- explicit non-match = optional hard reject for highly constrained opportunities

#### 5. Numeric eligibility caps

Normalize and compare:

- annual revenue
- employee count
- years in operation
- age or grade windows for student programs
- household income or benefits participation where applicable

#### 6. Geo gates

Compare applicant geography with opportunity geography.

Examples:

- profile ZIP radius
- school ZIP radius for student opportunities
- city, county, state eligibility
- remote / national / local-only flags

**Suggested default:**

- accept within declared radius plus a small buffer
- example buffer: **declared radius + ~0.005 degrees** as a tolerance guardrail, then verify with a proper geodesic distance check

#### 7. Deadline and state checks

Reject opportunities that are:

- closed
- expired
- archived
- cancelled
- clearly past the submission deadline

#### 8. Admin overrides

Allow:

- forced accept
- forced reject
- source-level trust overrides
- curated allowlists for known programs

---

## Stage 2: Candidate retrieval

After gate checks, retrieve a broader set of plausible candidates so strong opportunities are not missed.

### Retrieval modes

#### Sparse retrieval

Use BM25 or equivalent lexical ranking for:

- exact keywords
- sponsor names
- program names
- acronyms
- jurisdiction terms
- structured phrases from profile sections

Sparse retrieval is especially strong for exact-title and terminology-heavy opportunities.

#### Dense retrieval

Use embeddings for semantic recall across:

- opportunity titles
- summaries
- eligibility text
- profile narrative fields
- goals / mission / use-of-funds language

Dense retrieval is especially useful when profile language and opportunity language are conceptually similar but not phrased the same way.

**Suggested semantic candidate threshold:**

- include candidates with cosine similarity **>= 0.78**

#### Hybrid merge

Merge sparse and dense candidate pools, dedupe, then pass the union to reranking.

### Candidate features produced here

- BM25 score
- embedding cosine score
- source provenance
- retrieval channel flags (sparse hit, dense hit, both)
- geo distance
- taxonomy overlaps

---

## Stage 3: Final reranking

Final ranking should be handled by a lightweight learning-to-rank model or a transparent weighted scorer during initial rollout.

### Recommended model options

- **LambdaMART / XGBoost ranking**
- **TensorFlow Ranking**
- fallback: weighted linear score for first release

### Features to include

#### Semantic and lexical features

- embedding cosine similarity
- BM25 / lexical score
- title similarity
- sponsor similarity

#### Rule-derived features

- exact ID match
- fuzzy name/address pass
- entity-type compatibility
- hard eligibility pass count
- admin override flags

#### Geographic features

- distance in miles / km
- same ZIP / same county / same state flags
- school ZIP match flags for student profiles

#### Taxonomy features

- exact NAICS match
- 3-digit NAICS prefix match
- category overlap / Jaccard-style measures

#### Source quality features

- publisher trust score
- government / foundation / local registry source class
- source freshness
- crawl confidence

#### Numeric fit features

- revenue within cap
n- employee count within cap
- applicant size relative to program limits
- deadline recency

### Output

The reranker returns a single score used for:

- final ordering on Discover / Funding Opportunities
- minimum match slider thresholds
- pipeline auto-population decisions
- diagnostics and admin review

---

## Canonical default thresholds

These are proposed starting defaults, not permanent constants.

| Signal | Default |
|---|---:|
| Exact ID match | auto-accept |
| Name + address fuzzy similarity | >= 0.92 |
| Dense retrieval candidate cosine | >= 0.78 |
| NAICS 3-digit prefix | strong boost |
| Geo tolerance | declared radius + small buffer |

These should ultimately be moved into configuration so production tuning does not require code redeploys.

---

## Serving flow

```text
1. Normalize profile + opportunity records
2. Apply hard gates
3. Accept exact high-confidence matches immediately when allowed
4. Retrieve sparse candidates
5. Retrieve dense candidates
6. Merge and dedupe candidates
7. Compute ranking features
8. Score with reranker
9. Threshold and sort results
10. Persist explanations / debug reasons
```

### Pseudocode

```js
if (exactIdMatch(profile, opp)) return ACCEPT
if (fuzzyNameAddress(profile, opp) >= 0.92) return ACCEPT
if (!entityTypeCompatible(profile, opp)) return DROP
if (deadlineExpired(opp)) return DROP

const sparse = bm25Search(profileQuery, { topK: 200 })
const dense = vectorSearch(profileEmbedding, { topK: 200, minCosine: 0.78 })

const candidates = mergeAndDedupe(sparse, dense)
  .filter((c) => geoEligible(profile, c))

for (const c of candidates) {
  c.features = buildRankingFeatures(profile, c)
  c.score = reranker.predict(c.features)
}

return candidates
  .filter((c) => c.score >= minMatchThreshold)
  .sort((a, b) => b.score - a.score)
```

---

## Rollout plan

### Phase 1: Rules + weighted scoring

Ship immediately with:

- deterministic gates
- BM25 retrieval
- optional embeddings
- weighted score combining existing signals

This gives fast wins and cleaner diagnostics.

### Phase 2: Hybrid retrieval

Add:

- vector index
- dense retrieval candidate pool
- merged sparse+dense recall

### Phase 3: Learning-to-rank

Train on:

- accepted vs rejected opportunities
- user clicks / saves / pipeline adds
- admin adjudications
- downstream conversion outcomes where available

### Phase 4: Continuous tuning

Add:

- offline evaluation set
- threshold tuning by crawler type
- calibration by profile type
- source-level quality monitoring

---

## Metrics to monitor

### Quality

- precision@k
- recall@k
- false-positive rate in pipeline
- percentage of irrelevant admin removals
- user save / open / apply rates

### Operational

- retrieval latency
- rerank latency
- candidate set size
- % of opportunities rejected by hard gates
- % of results recovered only by dense retrieval

### Safety / trust

- % of results missing real URLs
- % of expired opportunities shown
- duplicate rate across sources
- disagreement rate between admin overrides and model rank

---

## GrantFlow implementation notes

This proposal fits GrantFlow's current direction:

- keep policy enforcement deterministic where correctness matters
- use profile-driven matching for non-geo crawlers
- preserve admin override capability
- expose rejection and scoring diagnostics for debugging
- integrate with existing `min_match_score` behavior rather than replacing it abruptly

A practical first implementation would introduce this architecture behind a feature flag, starting with:

1. shared normalization utilities
2. explicit gate result objects
3. hybrid retrieval adapters
4. a transparent weighted scorer
5. structured explanation payloads in crawler debug responses

---

## Recommendation

Adopt this as the target matching architecture for future crawler and opportunity-ranking work.

It gives GrantFlow:

- better precision from hard gates
- better recall from hybrid retrieval
- better ranking from learned or weighted reranking
- cleaner diagnostics for production support
- a clear migration path from current rule-heavy matching to a more modern, testable ranking stack
