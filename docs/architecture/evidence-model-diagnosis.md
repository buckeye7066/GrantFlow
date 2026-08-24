# GrantFlow — the missing evidence layer (Stage-1 architectural diagnosis)

**Date:** 2026-08-24
**Question (owner):** Are the remaining false-positive classes (field-of-study,
study-abroad, residency, geography, profession, stage, service-commitment,
applicant-type, institutional, lead-gen, application-URL, hub decomposition)
*separate* problems, or manifestations of one missing **source-claim / evidence**
representation? And why do genuinely-qualifying narrow sources fail to reach
ACCEPT?

**Answer:** They are ONE problem. The system has a mature, shared *shape* of
gate, but no shared, typed, **scoped** representation of what a source asserts
about itself. Every gate re-mines raw text and silently assumes the fact it
found is an *applicant* restriction. The false-negative is the same defect seen
from the scoring side: the score measures *profile overlap* instead of
*requirement satisfaction*.

This was established by reading the code on `main`, not from assumptions. The
four maps are summarised below with file:line evidence.

---

## 1. What the code actually does today

### 1a. Eligibility gates (matchEngine.makeDecision + the standalone modules)

`makeDecision` (`backend/services/matchEngine.js:3787`) runs ~26 ordered gates,
plus an upstream `hardEligibilityReasons` union (`:4548`) and a parallel
`evaluateEligibility` bank. REJECT is only ever a hard categorical/scope gate;
low score never rejects (`:4373`); missing facts route to REVIEW, never REJECT.

Every eligibility gate has the **same shape**: detect a claim from the
opportunity's text → compare to a structured profile fact → return
conflict-or-null, silence-neutral. But:

- **Each gate re-detects its claim independently**, from its own private
  title/sponsor reader, returning its own bespoke shape:
  `fieldOfStudyEligibility.detectRequiredField` → `{id,label,phrase,field}`;
  `stageOfLifeEligibility.detectDeclaredStageRequirement` →
  `{declared,classId,label,phrase,field}`;
  `opportunityJurisdiction.detectForeignOpportunity` → `{foreign,cctld,host,funder}`;
  `professionEligibility.detectOpportunityProfessionLock` → a bare string;
  `serviceCommitmentEligibility` → a bare label; `applicantTypeGate` →
  buckets; `pipelinePrecision.opportunityNeedVocabulary` → canonical need ids.

- **Most flags are `Boolean(column) || textMatch(blob)`** where `blob` =
  `title + description + sponsor + eligibility` unioned
  (`opportunityNormalizer.js:791`). So a **sponsor name or a stray prose phrase
  can trip an applicant restriction**. Purely title-only, no-column flags:
  `isProceduralNotice` (`:939`), `titleIsResearchProgram` (`:933`).

- **Scope is never data.** No gate records whether the value it detected scopes
  the *applicant*, the *sponsor/administering body*, the *institution*, the
  *service area*, or the *beneficiary*. It is inferred from *which gate ran*.
  The gates mix three unlabeled scopes:
  - applicant-eligibility: veteran/student/nonprofit/gender/field/stage/disease
  - sponsor/administering-body identity: foreign (`#1`), website-purpose (`#6`),
    institutional/agency program-name (`#9–11`)
  - geography-of-service: `#25`, `#26`
  The tell: stage-of-life had to hand-add `identityPatterns` + `inclusionGuard`
  (`stageOfLifeEligibility.js:180,184`) *specifically because* "school of
  medicine" in a description is the **awardee**, not the audience — a scope
  distinction patched by hand, per gate, and not reusable.

- **The geography scope ambiguity is already a live bug in the code**:
  `matchEngine.js:4249` admits the `state` column is "stamped by whichever
  profile's crawl minted the row" — i.e. its scope is ambiguous between
  *service area* and *crawl provenance*, which is why `#26` must prefer a
  title-declared place to disambiguate.

**The only typed `{value, evidence}` record in the whole system is
profile-side**: `profileDerivedFacts.DERIVED_FACT_FIELDS` (`:159`), which every
derived fact tags with the field id it came from. There is **no opportunity-side
equivalent** — the source claim is re-mined from title text every time.

### 1b. Validity and Actionability already exist as separate layers

- **Validity** — `fundingResultFilters.classifyFundingResult` → `{not_a_grant |
  resource | fundable}` (title + sponsor identity only, never description).
  Plus `opportunityKindClasses` (pointer/benefit).
- **Actionability** — `sourceApplyability.classifyApplyability` → 4 tiers
  (`online_form | mail_or_pdf | account_portal | info_only`).

These are good, and they are already *orthogonal to eligibility*. They are just
not unified with eligibility/fit/confidence into one decision shape.

### 1c. Confidence is already orthogonal (this is correct)

`computeMatchConfidence` (`matchEngine.js:262`) is a weighted average of
source-trust / actionability / eligibility-text / freshness, set on
`match_explain.confidence` and **never** feeds the score
(`matchThresholds.js:275`: "Confidence NEVER alters the match score"). Keep this.

### 1d. Evidence inheritance (hub decomposition) is mostly scoped — one leak

`listingDecomposition.buildOpportunityRecord` (`:128`) builds each child from
**that item's own fields**, with fabrication guards (`extractListingAwardItems`,
`llmPageExtract.js:560`): title must appear on the page (`title_not_on_page`),
applyUrl must be one of the page's own links (`apply_url_not_on_page`).
Geography and eligibility are **not extracted at all**, so a page-level "open to
nursing students" **cannot** become a structured claim on a child. Residual
leak: a sponsor-less child inherits the **hub host** as its sponsor
(`listingHostSponsor`, `:134`) — and sponsor *does* feed eligibility gates, so
that is a genuine scope leak. The per-item `evidence` quote lands in
`description` (display/drafting), which no gate reads.

### 1e. Provenance contamination is already prevented (this is correct)

The discovering query is stored as `source_query`/`discovered_via` on the
**match row only** (`crawlerOsPersistenceCore.js:1027`), consumed only by the
crawler doctor — never copied to any `funding_opportunities` fact. The extractor
is deliberately **profile-blind**: "categorical facts come from the page
extraction, never the profile" (`webLane.js:125`; `:108-111`).
`opportunity_sources` has no query/terms column at all. The WHY-found /
WHAT-claimed boundary **exists** — its one dependency is that the extractor stay
blind; nothing downstream re-checks it.

`docs/canonical_rules.md:463-476` already formalises a page-fact
`field_provenance {value, evidence_snippet, source}`. **The typed-claim object
partially exists on the extraction side — it just lacks *scope* and is not
*consumed* by the gates.**

### 1f. The false-negative: the score is profile-overlap, not requirement-satisfaction

The live `data_point` score is
`dataPointCredit / max(profileInventory.total, 15)` (`matchEngine.js:3237`) —
**matched ÷ the profile's ENTIRE inventory**. A fund stating 2 criteria Robert
meets touches ~2 of ~70 → **3-6% coverage → REVIEW**. This is the 2/70 problem,
verbatim.

There **is** a correction — the full-satisfaction floor
(`matchEngine.js:3256-3312`, `SATISFACTION_ACCEPT_COVERAGE=15`): if the profile
satisfies **every** canonical need the funder *states*, and gates are clean, it
floors coverage to ACCEPT. **But its trigger is keyed solely on
`need_types_supported ∩ declared canonical needs`** (`:3287`). It does **not**
count profession / field-of-study / geography / applicant-type satisfaction. So
a "Tennessee paramedic students" fund that Robert satisfies on
profession+geo+student — but whose need vocabulary is empty or `education` —
gets `fullSatisfaction=false → no lift → 2/70 → REVIEW`. **That gap is where
"0 ACCEPT for genuinely-qualifying narrow funds" comes from.** (A sibling bug —
`applicantTypeGate` omitting the `disabled_adult`/`senior`/`medical_need`
individual roots, which forced whole profiles to `applicant_type_missing` below
ACCEPT — was already fixed 2026-08-23.)

---

## 2. The unifying diagnosis

Every item above is one abstraction seen from different sides:

> A source makes **claims about itself**. Each claim has a **value**, a
> **scope** (what the value is about — applicant / sponsor / institution /
> service-area / beneficiary / award), a **strength**, and **evidence** (which
> field, what text). GrantFlow represents claims *implicitly and per-gate*, and
> **omits scope entirely**. Every downstream failure follows from that.

- **False positives** = a claim whose scope is *not applicant* (a sponsor named
  "…Nurses Foundation", a program-name, a description phrase) is treated as an
  applicant restriction. Adding a 13th gate does not fix this; adding scope does.
- **False negatives** = the score asks "how much of the *profile* does the source
  touch?" (overlap) instead of "how much of what the *source requires* does the
  profile satisfy?" (requirement satisfaction over the source's applicant-scoped
  claims).

The same claim model fixes both. That is why it is the right layer.

---

## 3. The five judgments (the target output shape)

For each (opportunity, profile) pair, produce five *independent* verdicts and
derive the final from them:

| Judgment | Question | Today's owner |
| --- | --- | --- |
| **Validity** | Is this a real, presentable funding source? | `fundingResultFilters` + `opportunityKindClasses` (already exists) |
| **Eligibility** | Is there a **provable** reason the applicant cannot receive it? | the hard gates — but only over **applicant-scoped** claims |
| **Fit** | Does it satisfy what the profile needs, and how completely does the profile satisfy what the source *requires*? | requirement-satisfaction (generalise the floor) + need relevance |
| **Actionability** | Can the applicant actually act on it? | `sourceApplyability` (already exists) |
| **Confidence** | How much evidence supports the above? | `computeMatchConfidence` (already orthogonal) |

Hard eligibility operates **outside** ranking (a provable conflict is REJECT
regardless of score); everything else ranks.

---

## 4. The smallest architecture (Stage 2) — an extension, not a rewrite

### 4a. One typed, scoped claim (the opportunity-side twin of `DERIVED_FACT_FIELDS`)

```js
// A source claim: what the opportunity asserts about itself.
{
  dimension: 'field_of_study' | 'residency' | 'entity_type' | 'academic_stage'
           | 'profession' | 'gender' | 'condition' | 'military_service'
           | 'aid_type' | 'need' | 'award_ceiling' | 'jurisdiction' | ...,
  value:  'nursing' | 'OH' | 'nonprofit' | ...,
  scope:  'applicant' | 'sponsor' | 'institution' | 'service_area'
        | 'beneficiary' | 'award',        // THE MISSING DIMENSION
  strength: 'explicit' | 'inferred' | 'detected',
  evidence: { field: 'title', text: 'Marybelle Huggins NURSING Scholarship' },
}
```

`deriveSourceClaims(opportunity) -> Claim[]` — ONE producer that reads the
opportunity's fields and emits typed, scoped claims. It **wraps the existing
detectors** at first (field-of-study, stage, jurisdiction, applicant-type,
profession, service-commitment, gender, disease…), each now emitting a Claim
with an explicit `scope` instead of a bespoke shape.

### 4b. One comparator family, keyed on scope

`applicantConflicts(claims, profileFacts) -> Conflict[]` — for each claim whose
`scope === 'applicant'` (or `beneficiary`), compare to the matching profile fact
(`DERIVED_FACT_FIELDS` already provides these). A provable mismatch is REJECT.
Claims scoped `sponsor` / `institution` / `service_area` are **never** applicant
rejects — they inform Fit / geography-of-service / ranking. **This is the single
change that dissolves the sponsor-name-trips-applicant class of false positive.**

### 4c. Requirement-satisfaction fit (fixes the false negative)

`fit = satisfied(applicant-scoped source claims + stated needs) /
       (applicant-scoped source claims + stated needs)`

The "TN paramedic student" fund states 3 applicant claims (residency=TN,
field/profession=paramedic, stage=student); Robert satisfies 3/3 = 100% → high
fit, independent of his 70 profile facts. This **subsumes** the existing
needs-only satisfaction floor and extends it to profession/field/geo/type — the
exact gap in `§1f`.

### 4d. Migration path (each phase measurable, no big-bang)

1. Build `deriveSourceClaims` as a **wrapper** over today's detectors; emit
   claims; log them beside the live decision. Behaviour unchanged; measurable.
2. Add `scope` to the conflation-prone dimensions first (field-of-study,
   profession, entity-type/institutional). **Measure** on the 12 profiles that
   sponsor-scoped claims stop tripping applicant rejects, and that today's
   correct rejects are preserved.
3. Refactor the gates to **consume** claims from the one producer; delete the
   duplicate title/sponsor readers. Existing gate tests pin behaviour.
4. Generalise the satisfaction floor to requirement-satisfaction over
   applicant-scoped claims. **Measure** ACCEPT recovery across the 12 profiles.
5. Fix the hub sponsor-bleed (`§1d`) by scoping the inherited hub sponsor as
   `scope: 'sponsor'` (so it can never be read as an applicant bar), and
   optionally tie evidence-completeness into confidence.

### 4e. The proof-of-concept slice (first, low-risk, measurable)

Implement `deriveSourceClaims` for **field-of-study + profession + jurisdiction**
*with scope*, and run `applicantConflicts` **alongside** (not replacing) the
current gates. Assert it (a) reproduces every current correct reject and (b)
withholds the rejects the current gates would wrongly fire when the field/
profession word is in a **sponsor** rather than an applicant statement. That
single measurement validates the whole model before any gate is refactored.

---

## 5. The principle to keep at the top

> Discovery may be wrong about what is **interesting**. The matcher must never be
> wrong about what is **impossible**.

Broad discovery feeding an evidence-based qualification system; hard gates answer
only "can we *prove* this applicant cannot receive it?"; everything else
(validity, fit, actionability, confidence) ranks. Scope is what lets a hard gate
be certain, and requirement-satisfaction is what stops a certain-eligible narrow
fund from being buried.
