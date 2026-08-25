# Matching re-evaluation playbook

This playbook standardizes how GrantFlow decides **how much downstream work to run** after matching, scoring, or eligibility rules change.

It is designed to balance:

- **quality** (precision and recall)
- **latency** (how quickly changes are reflected)
- **cost** (compute, storage, network, and crawl spend)
- **blast radius** (how much of the corpus is touched)

Use this when changing:

- match scoring rules
- grant relevance rules
- eligibility thresholds
- geo proximity logic
- NAICS / industry mapping
- canonical identity resolution
- derived fields used in search, ranking, or filtering

## Recompute tiers

### Tier 1: Incremental re-score

Use when the change only affects scoring or gating logic and does **not** require new extraction, refetch, or recanonicalization.

**What runs**

- Re-run scoring / ranking / eligibility against already materialized fields
- Update stored match scores and ordering for touched entities only

**Typical relative cost**

- ~1x per touched item

**Typical quality impact**

- Precision usually stays within ±0–2%
- Recall may drop by up to ~5% for non-canonical or feature-dependent edits

**Choose this when**

- Fan-out is **<= 0.1% of the index** or **<= 10,000 items**
- Change is label-only or threshold-only
- Geo centroid movement is **< 5 km**
- NAICS change is minor, usually **4-digit**
- Revenue band changes but does **not** cross a hard eligibility boundary

### Tier 2: Targeted re-evaluation

Use when a rule change affects derived fields, extractors, secondary matchers, or other logic that cannot be safely handled by score-only recomputation.

**What runs**

- Re-run affected extraction / parsing / normalization / secondary matching steps
- Recompute scores and downstream eligibility for the touched subset only

**Typical relative cost**

- ~5–10x a re-score

**Typical quality impact**

- Commonly recovers +5–12% recall / precision versus re-score only when changes are materially feature-dependent

**Choose this when**

- Fan-out is **> 0.1% and <= 5%**
- 3-digit NAICS mapping changes
- Geo delta is **5–50 km**
- Revenue band crosses a hard eligibility threshold
- Parsed or normalized fields used by secondary rules have changed

### Tier 3: Full recrawl

Use when the source of truth, canonical identity, or authoritative state may have changed enough that stored data cannot be trusted.

**What runs**

- Refetch
- Reparse
- Renormalize
- Re-index
- Re-score

**Typical relative cost**

- ~50–200x a re-score, depending on network and storage overhead

**Typical quality impact**

- Restores near-baseline precision / recall when the issue is source drift, canonical identity drift, or major jurisdiction/state changes

**Choose this when**

- Fan-out is **> 5%**
- 2-digit NAICS change
- Entity type flips (for example nonprofit <-> for-profit)
- Canonical ID changes
- Jurisdiction moves across a state boundary or by **> 50 km**
- Publisher or authoritative status flips
- Targeted re-evaluation still leaves **> 8%** precision / recall gap

## Decision table

| Change type | Recommended tier |
|---|---|
| Label-only or copy-only logic change | Incremental re-score |
| Minor score weight tuning on existing features | Incremental re-score |
| Geo tweak under 5 km | Incremental re-score |
| 4-digit NAICS mapping adjustment | Incremental re-score |
| 3-digit NAICS mapping change | Targeted re-evaluation |
| Extractor or normalized field change | Targeted re-evaluation |
| Revenue threshold crossing | Targeted re-evaluation |
| Geo change 5–50 km | Targeted re-evaluation |
| Canonical ID change | Full recrawl |
| Entity-type flip | Full recrawl |
| 2-digit NAICS change | Full recrawl |
| State-boundary or >50 km jurisdiction change | Full recrawl |

## Operating thresholds and guardrails

### Latency targets

- **Incremental re-score**
  - P99 <= 2s for <= 100 items in interactive flows
  - <= 60s for <= 10,000 items in background jobs
- **Targeted re-evaluation**
  - P95 <= 5 minutes for <= 10,000 items
- **Full recrawl**
  - Scheduled within 24h
  - Roll out highest fan-out segments first

### Cost and blast-radius limits

- Auto-recrawl requires estimated compute + network + storage cost <= **10x daily maintenance budget**
- If projected touch volume is **> 20% of the index**, stop and request explicit operator confirmation
- If recrawl would materially impact ingestion SLA, queue by fan-out priority and state / source criticality

### Quality safety checks

- Run a **7-day shadow A/B** before automatic escalation thresholds are enabled in production
- Escalate one tier higher whenever observed precision / recall regression exceeds modelled bounds
- Keep rollback-ready snapshots for any recompute plan that touches >1% of the index

## Recommended implementation flow

1. **Compute the diff**
   - Identify what rule or dependency changed
   - Map the change to impacted fields, entities, and stored artifacts

2. **Estimate fan-out**
   - Count the affected entities
   - Express both raw count and percent of total index

3. **Select a tier**
   - Apply the thresholds in this doc
   - Prefer the cheapest tier that preserves expected quality

4. **Estimate cost and latency**
   - Compute budget impact
   - Fail closed if blast-radius or budget guardrails are exceeded

5. **Dry-run on a stratified sample**
   - Sample by entity type, geography, size, and source
   - Measure observed precision / recall changes versus expected values

6. **Shadow / A-B before automation**
   - Use a 7-day shadow evaluation for threshold changes that may auto-escalate future work

7. **Roll out in stages**
   - Highest fan-out or highest-impact groups first
   - Log expected versus observed outcomes

8. **Keep rollback simple**
   - Record tier selected
   - Record impacted entities and source ranges
   - Preserve previous match outputs where practical

## Logging requirements

Every recompute decision should log:

- changed rule or dependency
- estimated fan-out count and percent
- chosen tier
- projected cost and latency
- projected precision / recall delta
- observed precision / recall delta after rollout
- whether explicit scope confirmation was required
- rollback artifact or checkpoint reference

## Suggested future automation hook

GrantFlow can eventually expose a `recompute planner` that:

- classifies the change type
- estimates fan-out through dependency mapping
- recommends one of the three tiers
- blocks unsafe auto-recrawls when budget or blast-radius thresholds are exceeded
- emits a machine-readable execution plan for background workers

A minimal output shape could be:

```json
{
  "change_type": "geo_threshold_update",
  "estimated_fanout_count": 8421,
  "estimated_fanout_percent": 0.07,
  "recommended_tier": "incremental_rescore",
  "estimated_relative_cost": 1,
  "manual_approval_required": false
}
```

## Summary rule of thumb

- **Re-score** when stored features are still trustworthy
- **Targeted re-evaluate** when derived fields need regeneration
- **Recrawl** when the source, identity, or authoritative state may no longer be trustworthy
