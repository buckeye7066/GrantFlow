# Backend Services Audit — matching / pricing / profile* / documentIngestion / seed

Read-only audit of `backend/services/{matching,pricing,profile,profileIntelligence,profileSignals,documentIngestion,seed}/`. Findings are tagged `[critical|important|nit]` with real file:line references.

---

## matching/

### backend/services/matching/qualityGate.js

- **[important]** `backend/services/matching/qualityGate.js:89` — `stripReferralQuery` is called with a synthetic record `{ url: record?.source_url ?? record?.application_url ?? record?.url }`. When those are all undefined the function returns `null`, silently nulling `normalized.source_url` even though the broader `pickUrl` chain (which also checks `apply_url`/`evidence_url`) had found a usable URL. The two URL-resolution paths diverge and can drop a valid source URL.
- **[nit]** `backend/services/matching/qualityGate.js:73` — `ARTICLE_PATH_RX` is only tested against `url.pathname`, but its character class includes `?#&` delimiters that never appear in a pathname; those alternation branches are dead at the only call site.

### backend/services/matching/reasons.js

- **[nit]** `backend/services/matching/reasons.js:32` — `/\bkeyword|intent|need alignment\b/` has misplaced word boundaries: alternation precedence makes it `(\bkeyword)|(intent)|(need alignment\b)`, so `intent` matches unanchored substrings (e.g. "intentional" trips KEYWORD_MATCH).
- **[nit]** `backend/services/matching/reasons.js:79` — `.filter((code) => MATCH_REASON_CODE_SET.has(code))` is dead/defensive: every code in the set was added from `MATCH_REASON_CODES` literals, so the filter never removes anything.

### backend/services/matching/resultEnricher.js

- **[important]** `backend/services/matching/resultEnricher.js:104-120` — Directory records that would be hard-rejected are converted REJECT→REVIEW and kept (`if (directory && preserveDirectories) { decision = { ...decision, decision: 'REVIEW', ... } }`) with no cap/limit, so a flood of low-trust directory rows can dominate results; `canonicalizeOpportunityList` (line 198) sorts by `match_score` only with no trust/decision tiebreaker.
- **[nit]** `backend/services/matching/resultEnricher.js:159-166` — Trust fields use `opportunity.<field> ?? trustMeta.<field>`, preferring a possibly-stale pre-existing value over the freshly recomputed trust assessment (e.g. `trust_tier: opportunity.trust_tier ?? trustMeta.trust_tier`).

### backend/services/matching/professionalDevelopmentPolicy.js

- **[important]** `backend/services/matching/professionalDevelopmentPolicy.js:249-258` — Cross-category score cap compares `capped !== opp.match_score` where `capped` is a Number and `opp.match_score` may be a string from a DB row (`Number(opp.match_score ?? 0)`), so an already-capped `"25"` rebuilds the object needlessly; also an unscored `undefined` match_score is coerced to 0 then written back as `match_score: 0`.
- **[nit]** `backend/services/matching/professionalDevelopmentPolicy.js:63-74` — `parseCategories`: a string that `JSON.parse`s to a non-array (e.g. `"42"` → `42`) falls past the `Array.isArray` block and returns `[]` without the comma/pipe split fallback (which runs only in `catch`).
- **[nit]** `backend/services/matching/professionalDevelopmentPolicy.js:151` — `programCategories: [...new Set([...expandedCats, ...PD_CATEGORY_CODES])]` always appends the full constant `PD_CATEGORY_CODES`, making per-query `expandedCats` nearly always redundant.
- **[nit]** `backend/services/matching/professionalDevelopmentPolicy.js:268` — `recordLowCoverageEvent` catch logs every failure as "table may not exist yet"; real DB errors (connection loss, constraint violation) are masked behind the benign message while the event is returned as if persisted.

(SQL in this file at lines ~294-307 is parameterized `db.prepare(...).run(...)`; no injection.)

---

## pricing/

### backend/services/pricing/pricingEngine.js

- **[important]** `backend/services/pricing/pricingEngine.js:71,86,131-133` — All money math runs in floating-point dollars (`round2` = `Math.round(n*100)/100`) rather than the integer-cents convention defined in `pricingTypes.toCents/fromCents`. Subtotals, totals, and `base_price*quantity` accumulate float dollars; persisted to `*_cents` only later via `toCents`. Functionally close but diverges from the stated "money as integer cents" invariant and is susceptible to accumulation drift on large multi-line quotes.
- **[nit]** `backend/services/pricing/pricingEngine.js:189-193` — `roundToFriendlyDollars` is only used to build a client-facing estimate string; values < 200 round to nearest 25, fine, but the message at line 186 uses `start.toLocaleString()` with no currency/locale guard (acceptable for USD-only).

### backend/services/pricing/chargeResolver.js

- **[important]** `backend/services/pricing/chargeResolver.js:332-339` — Quote line-item selection uses a fuzzy substring match on the first 6 chars of the service name (`String(li.service_name).toLowerCase().includes(String(catalogService?.name||'').toLowerCase().slice(0,6))`). Two catalog services sharing a 6-char prefix (e.g. "Standard Foundation…" vs another "Standard…") would cross-attribute line-item subtotals into the chargeable base. Prefer matching on `service_key`.
- **[important]** `backend/services/pricing/chargeResolver.js:341-345` — Dead branch: `out.pricing_model === 'milestone' ? expectedDollars : expectedDollars` — both arms are identical, so the ternary has no effect (likely intended to differ).
- **[nit]** `backend/services/pricing/chargeResolver.js:54-58` — `dollarsToCents` returns `0` for non-finite input rather than signaling an error, so a malformed catalog dollar value silently becomes a $0 charge component (mitigated downstream by the catalog-drift guard).
- **[nit]** `backend/services/pricing/chargeResolver.js:314-316` — Milestone split duplicates the `Math.round(totalCents * 0.4)` literal for kickoff and draft in two places (here and lines 370-372); the 40/40/20 split is correct (submission = remainder) but the magic factors are repeated and should be a shared constant to avoid drift with `PAYMENT_TERMS`.

### backend/services/pricing/discountEngine.js

- **[important]** `backend/services/pricing/discountEngine.js:238` — `const approvalNeeded = rule.requires_admin_approval || requireAdminApproval || !autoEnabled`. With defaults (`requireAdminApproval=true`), every recommended discount is forced to `requires_admin_approval=true` and `approved=false` — which is the intended conservative posture, but it means the `autoEnabled`/`rule.requires_admin_approval=false` auto-apply path is effectively unreachable unless `PRICING_REQUIRE_ADMIN_APPROVAL_FOR_DISCOUNTS=false` is also set. Worth confirming this is intended (the discount can never auto-apply on default config).
- **[nit]** `backend/services/pricing/discountEngine.js:314-316` — `fixed` discounts ignore `applies_to_services` weighting: a fixed-amount rule uses `Number(rule.value)` regardless of which line items it applies to, only later clamped to `applicableSubtotal` (line 319). Correct for a flat $ off, but the `applicableSubtotal>0` gate at line 312 still requires the filtered subtotal be positive.
- **[nit]** `backend/services/pricing/discountEngine.js:316` — `Number.isFinite(rule.max_amount) && rule.max_amount > 0`: a `max_amount` of exactly `0` is treated as "no cap" (skips the clamp), which is the right behavior here but is implicit; `null` is the documented "no cap" sentinel.

### backend/services/pricing/pricingRules.js

- **[important]** `backend/services/pricing/pricingRules.js:82,90` — Budget-band boundaries: `annualBudget < small_max` → SMALL else `annualBudget <= mid_size_max` → MID_SIZE. A budget exactly equal to `small_max` (250000) is classified MID_SIZE while a budget equal to `mid_size_max` (2000000) is MID_SIZE — asymmetric `<` vs `<=` at the two boundaries. Confirm intended; the mid-band reason string at line 94 also mislabels the lower bound as `small_max` rather than the actual SMALL→MID cutover.
- **[nit]** `backend/services/pricing/pricingRules.js:222` — `.sort((a, b) => b - a)[0] || null`: if the largest matched amount is `0` it would already be filtered by `n > 0` (line 221), so fine, but `|| null` would also coerce a legitimate falsy first element.
- **[nit]** `backend/services/pricing/pricingRules.js:368` — Fallback hourly quantity `Number(intakeAnswers.estimated_hours) > 0 ? … : 1` trusts a client-supplied `estimated_hours` as the billed quantity with no upper bound; combine with hourly pricing and this is a client-influenced amount (mitigated because the quote is admin-review-flagged on the fallback path, line 373).

### backend/services/pricing/pricingCatalog.js

- No issues found. Catalog is frozen, prices are finite literals, `getServicePrice` returns `null` on unknown category, `catalogIsEthical()` bans contingent/percentage language.

### backend/services/pricing/pricingTypes.js

- **[nit]** `backend/services/pricing/pricingTypes.js:254-258` — `toCents`/`fromCents` correctly use `Math.round`; the rest of the pricing layer (`pricingEngine`, `chargeResolver`, `discountEngine`) does float-dollar math and only converts at the persistence boundary, so these safe helpers are under-used (see pricingEngine finding).

### backend/services/pricing/clientCategoryClassifier.js

- **[nit]** `backend/services/pricing/clientCategoryClassifier.js:46` — `toCatalogCategory` returns `'small'` for any unrecognised input (`CATEGORY_LABEL_MAP[normalized] || 'small'`), silently defaulting an unknown/garbage category to a chargeable tier instead of surfacing it. Callers in `chargeResolver` separately validate via `isCatalogCategory`, but a direct caller could get a silent downgrade.

### backend/services/pricing/quoteBuilder.js

- **[important]** `backend/services/pricing/quoteBuilder.js:257-283` — `editLineItem` builds the column list from caller-supplied `updates` keys (whitelisted to `['service_name','client_category','base_price','quantity','reason']`, good) but `base_price`/`quantity` are written with `values.push(updates[k])` un-coerced — a string `"500"` from the admin form is stored raw, while the recomputed `subtotal` (line 273) uses `Number(...)`. Mixed types in `base_price` vs `subtotal` can desync; coerce on write.
- **[nit]** `backend/services/pricing/quoteBuilder.js:41` — `makeId` uses `Date.now()` + 6 random base36 chars; collision-resistant enough for low volume but not guaranteed unique under burst inserts (no DB unique-constraint retry shown here).
- **[nit]** `backend/services/pricing/quoteBuilder.js:165-166` — `getQuote` orders line items / discounts by `created_at`, but `decodeQuote` (line 305) does not expose `created_at` ordering guarantees to the caller; harmless.

### backend/services/pricing/pricingAccessGate.js

- **[important]** `backend/services/pricing/pricingAccessGate.js:343` — `acceptAgreement` updates with `WHERE profile_id = ? AND user_id IS ?` and binds `userId || null`. SQL `IS` is null-comparison; for a non-null `userId` `user_id IS '123'` is not valid equality semantics in SQLite/PG the way `=` is — this only matches rows where `user_id` is NULL (when `userId` is null) and is unreliable for non-null ids, so a legitimate agreement acceptance can update zero rows. Should be `user_id = ?` (or `user_id IS NOT DISTINCT FROM ?` in PG).
- **[nit]** `backend/services/pricing/pricingAccessGate.js:157` — `agreementAccepted = Boolean(agreement?.accepted) || Number(agreement?.accepted) === 1` is redundant (`Boolean(1)` already true; `Boolean('0')`/`Boolean('1')` both true for string values, so a string `'0'` would read as accepted). If `accepted` can be the string `'0'`, this misreports acceptance.
- **[nit]** `backend/services/pricing/pricingAccessGate.js:38-89` — `ALWAYS_ALLOWED_ROUTES` includes `/Admin` and `/Settings` as prefix-allowed for unpaid users; `isAlwaysAllowedPath` matches `path.startsWith('/Admin/')`, so any `/Admin/*` route bypasses the gate. Correct only if `/Admin` itself enforces admin auth server-side.

### backend/services/pricing/profilePricingInitializer.js

- **[nit]** `backend/services/pricing/profilePricingInitializer.js:253-261` — `rebuildPgFields` re-numbers `$1..$N` via a stateful `i++` inside `.replace(..., () => …)`; correct but fragile, and only exercised when `isPg(db)` (tests use SQLite so this path is largely untested per the code comment).
- **[nit]** `backend/services/pricing/profilePricingInitializer.js:58` — `makeId` same `Date.now()`+random collision caveat as quoteBuilder.
- **[nit]** `backend/services/pricing/profilePricingInitializer.js:116` — `decideInitialAccessStatus` treats `Number(quote?.total||0) <= 0` as a free package → `ACTIVE_PAID` (grants access without payment/agreement). Correct for genuinely $0 quotes, but if a total were ever negative due to over-applied discounts it would also grant free access; the engine clamps total to `>= 0` (pricingEngine:86), so mitigated.

### backend/services/pricing/stripePriceVerifier.js

- **[nit]** `backend/services/pricing/stripePriceVerifier.js:204` — Amount mismatch check `Number(priceData.amount_cents) !== dbAmt` compares integer cents (good), but `dbAmt = Number(r.amount_cents)` is unguarded for `NaN`; a non-numeric `amount_cents` makes `NaN !== NaN` true and reports an `amount_mismatch` with confusing detail rather than a clear data-integrity error.
- **[nit]** `backend/services/pricing/stripePriceVerifier.js:233-241` — `verifyStripePrice` returns `null` when no Stripe client (no key, not mock); `chargeResolver` treats absent verification as "skip Stripe-side check", so a misconfigured prod (missing key, mock off) silently bypasses Stripe unit-amount verification rather than blocking checkout.

### backend/services/pricing/serviceSlugAliases.js

- No issues found. `resolveCanonicalServiceSlug` returns `null` on unknown slugs (explicit failure), map is frozen and exhaustive.

### backend/services/pricing/samPricingAuditor.js

- **[important]** `backend/services/pricing/samPricingAuditor.js:115,127-128` — Quote-math audit sums money in float dollars (`round2(lineItems.reduce((s,li)=>s+Number(li.subtotal||0),0))` and the discount reduce), diverging from the integer-cents convention the gate auditor uses. Can both miss real mismatches and raise false positives from float drift.
- **[important]** `backend/services/pricing/samPricingAuditor.js:149` — Discount-cap check `if (approvedDiscount > cap + 0.01)` uses an arbitrary float epsilon, allowing a discount to exceed the cap by just under a cent unflagged; integer-cent comparison would be exact.
- **[nit]** `backend/services/pricing/samPricingAuditor.js:116,131` — `Number.isFinite(quote.subtotal)`/`quote.total` guards skip the audit entirely for numeric strings from some DB drivers rather than coercing or flagging.
- **[nit]** `backend/services/pricing/samPricingAuditor.js:216-221` — Budget classification boundary (`< small_max` vs `<= mid_size_max`) mirrors the asymmetric boundary in `pricingRules.js`; confirm canonical cutover.

### backend/services/pricing/samPricingGateAuditor.js

- **[important]** `backend/services/pricing/samPricingGateAuditor.js:133` — `n.admin_email.toLowerCase() !== adminNotificationEmail()` compares a non-trimmed stored email against the trimmed `adminNotificationEmail()`, so whitespace in the stored value triggers a false CRITICAL `wrong_admin_notification_target`. Use `isAdminNotificationTarget` on both sides.
- **[nit]** `backend/services/pricing/samPricingGateAuditor.js:146` — Missing-notification check is skipped whenever `profilePricing.created_at` is falsy, so rows without `created_at` evade the `admin_notification_missing` audit.
- **[nit]** `backend/services/pricing/samPricingGateAuditor.js:108` — Cent math is correct but `Number(... || 0)` lacks `Number.isFinite` guards; a non-numeric `total_cents` coerces to `NaN` and yields a confusing mismatch finding.

### backend/services/pricing/samPricingStripeAuditor.js

- **[important]** `backend/services/pricing/samPricingStripeAuditor.js:206` — Re-tag logic keys off categories `'quote_math_drift'`/`'unapproved_discount_in_total'` that `auditQuote` never emits (it emits `subtotal_mismatch`/`total_math_mismatch`/`discount_applied_without_approval`), so genuine quote-math and unapproved-discount violations are never surfaced as CRITICAL in the Stripe report — a silent coverage gap.
- **[important]** `backend/services/pricing/samPricingStripeAuditor.js:231` — Frontend-tamper whitelist uses `('individual','small','mid','large')` but the canonical category is `mid_size` (`CLIENT_CATEGORIES.MID_SIZE='mid_size'`). Every legitimate `mid_size` purchase is flagged CRITICAL `frontend_category_tampered`, while a non-canonical `'mid'` passes — inverted for the mid tier.
- **[nit]** `backend/services/pricing/samPricingStripeAuditor.js:348-354` — Summary `counts` reducer seeds only `{critical,high,medium,info}`; `low`-severity findings (a valid severity) are counted under an unseeded key and disappear from dashboards reading the four known keys.
- **[nit]** `backend/services/pricing/samPricingStripeAuditor.js:107,141` — `resolveAllCatalogCharges`/`verifyStripePriceMapping` awaited without try/catch; a single fetch rejection aborts the whole audit and loses already-computed findings.

### backend/services/pricing/pricingNotificationService.js

- **[important]** `backend/services/pricing/pricingNotificationService.js:143` — `flushQueuedOnLogin` UPDATE is scoped only by `WHERE id = ?`, omitting the `AND admin_email = ?` tenant guard used by `markDelivered`/`dismiss`. Not currently exploitable (preceding SELECT filters by `admin_email`) but diverges from the scoping convention and would update cross-tenant rows if the SELECT changed.
- **[nit]** `backend/services/pricing/pricingNotificationService.js:141-145` — Per-row sequential UPDATEs inside `withProfileScope` are non-atomic; a mid-loop failure leaves some rows delivered and others queued with no rollback. A single set-based UPDATE would be atomic.
- **[nit]** `backend/services/pricing/pricingNotificationService.js:38` — `decodeNotification` swallows `JSON.parse` errors to `null` with no logging; malformed `payload_json` is silently dropped.

---

## profile/

### backend/services/profile/canonicalSignals.js

- **[important]** `backend/services/profile/canonicalSignals.js:163,165,169` — `Number(householdIncome) || null` converts a legitimate `0` to `null` (`0 || null` → `null`); a household income / annual budget / requested amount of exactly `0` is meaningful and gets dropped. Use an explicit `Number.isFinite` check.
- **[nit]** `backend/services/profile/canonicalSignals.js:166` — `householdSize` is passed through un-coerced (no `Number(...)`) unlike the other numeric fields; a JSON string `"3"` survives as a string.
- **[nit]** `backend/services/profile/canonicalSignals.js:130` — `state` truncated via `.slice(0,2)` without validation; `"Kentucky"` becomes `"KE"` (wrong code). Diverges from `profileTaxonomy.normalizeState`'s proper name→code map.

### backend/services/profile/profileTaxonomy.js

- **[important]** `backend/services/profile/profileTaxonomy.js:509-516` — `resolveGeo` county-failure path logs `'ZIP code lookup failed:'` but the failing call is `resolveCountyForZip` (message copy-pasted from the state lookup at line 503), masking the true failing call.
- **[nit]** `backend/services/profile/profileTaxonomy.js:689` — `general_assistance` with zero text tokens still yields ~0.26 confidence with no evidence; evidence-free categories arguably should floor lower.
- **[nit]** `backend/services/profile/profileTaxonomy.js:1041` — Multi-word auto-derived keywords (e.g. "small business") are forced into hard `mustTerms`, which can over-constrain crawler queries.
- **[nit]** `backend/services/profile/profileTaxonomy.js:785` — `signalCoveragePct = canonicalPresent.length > 0 ? Math.max(1, pct) : 0` forces coverage to `1` when sections are present but zero fields mapped, reporting non-zero coverage for an empty extraction.

---

## profileSignals/

### backend/services/profileSignals/index.js

- **[important]** `backend/services/profileSignals/index.js:114` — `deriveIntents` reads `analysis.organization?.type`, but the canonical field is `orgType` (see `canonicalSignals.CanonicalOrganization.orgType`). Unless upstream carries a legacy `type` key, the church/faith-based/nonprofit org-based intent branch never fires — a silent feature gap.
- **[nit]** `backend/services/profileSignals/index.js:522` — Unconditional `log.info(...)` with derived intents on every profile load; noisy on batch crawls, includes derived data — consider debug level.
- **[nit]** `backend/services/profileSignals/index.js:439` — `hasNarrative` only checks `barriers_faced`/`special_circumstances`; a profile with `primary_goal`/`mission` only reports `hasNarrative:false` (debug snapshot only).

---

## profileIntelligence/

### backend/services/profileIntelligence/index.js

- **[important]** `backend/services/profileIntelligence/index.js:35,752-759` — `PRIMARY_TYPE_TO_ENTITY` collapses `student → 'individual'`, so `entityType` is never the string `'student'`; downstream `entityType === 'student'` guards (e.g. needsInference) are effectively no-ops and rely entirely on the separate `isStudent` boolean. Confirm intent.
- **[nit]** `backend/services/profileIntelligence/index.js:807` — `financialFlags: new Set(hardshipFlags)` is a misleading alias — it only ever contains hardship flags; church/nonprofit consumers read `intel.financialFlags` expecting budget signals.
- **[nit]** `backend/services/profileIntelligence/index.js:734` — `state` is upper-cased but not normalized via a name→code map; `"Ohio"` → `"OHIO"` then fails 2-letter `oppState === profileState` comparisons in relevanceScorer/eligibilityFilter, silently breaking geography matching for non-abbreviated states.

### backend/services/profileIntelligence/feedbackLoop.js

- **[important]** `backend/services/profileIntelligence/feedbackLoop.js:235-237` — `feedback_adjustment_delta` is computed as `Math.round(adjusted_score) - scoreResult.total_score`, while `match_explanation` (line 237) recomputes `Math.round(adjusted_score - scoreResult.total_score)`. For fractional scores these two "delta" values can disagree by 1.
- **[nit]** `backend/services/profileIntelligence/feedbackLoop.js:200,209` — `scoreResult.matched_needs.filter(...)` assumes `matched_needs` is always an array; a partial caller object lacking it throws. A `?? []` guard would match the file's otherwise-careful null handling.

### backend/services/profileIntelligence/needsTaxonomy.js

- **[important]** `backend/services/profileIntelligence/needsTaxonomy.js:857` — `resolveNeedFromSynonym` constructs a `new RegExp` per synonym/label on every call with no caching; called per story keyword via `inferFromExplicitKeywords`, this is O(keywords × synonyms) regex compilation — a hot-path cost on large profiles.
- **[nit]** `backend/services/profileIntelligence/needsTaxonomy.js:859` — Tie-break uses `sl.length > bestMatchLength` (strictly greater), so equal-length synonyms from different codes resolve to whichever appears first by object-key order — deterministic but arbitrary/undocumented.

### backend/services/profileIntelligence/needsInference.js

- **[critical]** `backend/services/profileIntelligence/needsInference.js:332` — `inferIndividualHardshipNeeds` checks `(hardshipFlags ?? new Set()).has('food_insecurity')`, but `extractHardshipFlags` (index.js) never adds a `'food_insecurity'` flag (it emits `low_income`, `financial_hardship`, `medical_hardship`, …). The flag-based food branch is dead; food needs fire only via the keyword regex. Producer/consumer name mismatch.
- **[important]** `backend/services/profileIntelligence/needsInference.js:308-309` — Destructures `enrolledPrograms` from `intel`, but `buildProfileIntelligence` never sets it (it lives in profileSignals as `assistancePrograms`); always `undefined` — dead destructure.
- **[nit]** `backend/services/profileIntelligence/needsInference.js:664` — `inferEnergyEfficiency` destructures `entityType` but never uses it (dead destructure).
- **[nit]** `backend/services/profileIntelligence/needsInference.js:433` — `(disabilityFlags ?? new Set())` is dead — the destructure default at line 407 already guarantees a Set.
- **[nit]** `backend/services/profileIntelligence/needsInference.js:448` — Stray leftover edit-marker comment "Remove unused helper function - use inline null checks instead".

### backend/services/profileIntelligence/relevanceScorer.js

- **[critical]** `backend/services/profileIntelligence/relevanceScorer.js:549-571` — `scoreOpportunity` builds `profileData` from `intel` fields that `buildProfileIntelligence` never produces (`intel.isSenior`, `intel.isCaregiver`, `intel.hasDisability`, `intel.medicalConditions`, `intel.emergencyContext`, `intel.businessFlags`, `intel.familyFlags`). All are `undefined`, so the disability/senior/caregiver/medical/business/family rules in `applyRelevanceFilter` are silently disabled for every profile (the intel object exposes `disabilityFlags`, `militaryFlags`, etc., not these names).
- **[important]** `backend/services/profileIntelligence/relevanceScorer.js:142,601` — Need matching uses `fullText.includes(synonym)` with no word boundary, while `eligibilityFilter.extractOppNeedCodes` (line 139) uses `\b`-anchored regex on the same taxonomy. Short synonyms ("van", "PPE", "lift", "shop", "store") substring-match inside unrelated words, inflating `need_fit`/`matched_needs`. The two modules disagree on matching semantics.
- **[important]** `backend/services/profileIntelligence/relevanceScorer.js:589-613` — `needFitScore` recomputes matched-needs inline and then calls `scoreNeedFit` which recomputes the same matching internally; the inline version adds a need on `exampleMatch` alone (line 607) whereas `scoreNeedFit` weights example matches at 0.5 and does not add them, so reported `matched_needs` includes needs that contributed only 0.5 to the score.
- **[important]** `backend/services/profileIntelligence/relevanceScorer.js:228` — `states.map(s => s.toUpperCase())` without String coercion; a non-string element in `states_supported` throws inside the `try` (line 224) and is swallowed to a geography score of `0` — malformed data silently zeroes geography fit.
- **[nit]** `backend/services/profileIntelligence/relevanceScorer.js:220` — `oppState.includes(profileState)` substring-matches a 2-char code; a comma-list opp state can over-match fragments. Prefer exact/token match.

### backend/services/profileIntelligence/eligibilityFilter.js

- **[critical]** `backend/services/profileIntelligence/eligibilityFilter.js:162,170` — `checkGeography` computes `oppState = String(opportunity.state || opportunity.states_supported || '').toUpperCase()` then `.includes(String(profileState))` — when `states_supported` is a JSON-array string like `'["TX","NY"]'`, the substring test runs against raw JSON text and is order-dependent/fragile (a profile state that is a substring of the JSON punctuation can false-pass/fail). The correct array parsing below (line 175) runs only after this.
- **[important]** `backend/services/profileIntelligence/eligibilityFilter.js:336,345,354,363` — Requirement detection runs unanchored regex (e.g. `/veteran only|must be a veteran/`) against untrusted crawled `description` text with no negation handling; a description quoting "this grant is NOT veteran only" still trips `requires_veteran` and hard-rejects an eligible profile.
- **[important]** `backend/services/profileIntelligence/eligibilityFilter.js:392` — `requiresDisaster` regex includes the bare token `/fema/`; any passing mention of FEMA ("unlike FEMA grants…") hard-fails opportunities as `requires_disaster_context`. Over-broad hard blocker.
- **[nit]** `backend/services/profileIntelligence/eligibilityFilter.js:269` — `isLoan` falls back to anchored `/^loan$/i`; descriptive types like `"microloan"`/`"loan guarantee"` slip past the loan hard-filter unless the `is_loan` flag is set.

### backend/services/profileIntelligence/searchPlanGenerator.js

- **[nit]** `backend/services/profileIntelligence/searchPlanGenerator.js:205` — Comment "Skip donor lanes for government entities" is mis-positioned; this line skips the DENOMINATION lane (`!intel.isChurch`), the government skip is line 206.
- **[nit]** `backend/services/profileIntelligence/searchPlanGenerator.js:316` — `truncated = deduped.length - Math.min(deduped.length, maxPlans)` is a redundant computation used only for a debug log; the real slice (line 321) is independent.
- **[nit]** `backend/services/profileIntelligence/searchPlanGenerator.js:182` — `buildExclusions` pushes `'public_facility_only:false'` into the `exclusions` array, but it is semantically an inclusion hint; a consumer treating `exclusions` as filter-out terms would invert the intent.

(No SQL, no LLM-prompt interpolation of profile/document text, and JSON.parse of external input is consistently try/catch-guarded across the profileIntelligence files.)

---

## documentIngestion/

### backend/services/documentIngestion/index.js

- No issues found. Pure re-export barrel.

### backend/services/documentIngestion/detectFileType.js

- **[important]** `backend/services/documentIngestion/detectFileType.js:5-40` — File-type detection trusts the client-supplied `mimeType`/`fileName` extension only; there is no magic-byte/content sniffing, so a renamed/spoofed file (e.g. an executable named `.pdf`, or a PDF claiming `text/plain`) is routed to the wrong parser. There is also no per-file size cap enforced here or in `extractText`/`extractTextWithFallback` (only a post-extraction `clampText` of 250k chars and a PDF page cap) — oversized uploads / zip-bomb-style DOCX (XML expansion) are read fully into a buffer via `fsp.readFile` before any limit applies. Size/type limits must be enforced at the upload/route layer; nothing in this service guards against an oversized or content-spoofed file.
- **[nit]** `backend/services/documentIngestion/detectFileType.js:33` — `safeMime.startsWith('image/')` accepts any image subtype (e.g. `image/tiff`, `image/svg+xml`) but only jpg/jpeg/png are actually OCR-supported downstream; an SVG (XML) routed as an image would be handed to the OCR provider.

### backend/services/documentIngestion/extractText.js

- **[important]** `backend/services/documentIngestion/extractText.js:66` — Copy-paste bug: the PDF branch's read-error warning says `'DOCX file read error: ...'` (should be PDF). Misleads debugging of failed PDF reads.
- **[important]** `backend/services/documentIngestion/extractText.js:49,66` — DOCX and PDF `fsp.readFile(...).catch(...)` handlers push a warning then `throw err`, so a read failure rejects the whole `extractText` call (unhandled at this layer) rather than returning the graceful empty-text result the text/image branches use — inconsistent error handling; callers not wrapping in try/catch get an unhandled rejection.
- **[nit]** `backend/services/documentIngestion/extractText.js:7` — `clampText` truncates to 250k chars with an ellipsis but does not record a "truncated" warning in meta, so downstream consumers cannot tell a document was cut off.

### backend/services/documentIngestion/extractTextWithFallback.js

- **[important]** `backend/services/documentIngestion/extractTextWithFallback.js:99-106` — OCR PDF page cap defaults to 40 (`OCR_PDF_MAX_PAGES`) and DPI 150; both are env-overridable with no hard upper bound, so a hostile env or very large PDF can rasterize an unbounded number of high-DPI pages (CPU/memory/temp-disk exhaustion). The `pdftoppm` exec has a 120s timeout (pdftoppm.js:80) but per-page OCR after rasterization is unbounded in aggregate.
- **[nit]** `backend/services/documentIngestion/extractTextWithFallback.js:139,144` — `ocr_confidence` sentinel of `-1` is set when OCR ran but no finite confidence was returned; `scoreExtraction` later treats `ocr_confidence` via `clamp01` so `-1` clamps to 0 — functional, but a `-1` confidence leaking to other consumers is a magic value.
- **[nit]** `backend/services/documentIngestion/extractTextWithFallback.js:159` — Mojibake in a warning string (`"scanned image with unrecognised content"` preceded by a corrupted dash byte); cosmetic.

### backend/services/documentIngestion/scoreExtraction.js

- **[nit]** `backend/services/documentIngestion/scoreExtraction.js:72` — `score += (clamp01(ocrConf) - 0.75) * 0.4` can push score below earlier method baselines; the final `clamp01` bounds it, but the centering constant `0.75` is a magic number duplicated with the strong-OCR threshold logic (line 57).
- **[nit]** `backend/services/documentIngestion/scoreExtraction.js:6-13` — `isMostlyWhitespace` is duplicated verbatim from `utils.js` rather than imported; divergence risk if one copy changes.

### backend/services/documentIngestion/utils.js

- **[nit]** `backend/services/documentIngestion/utils.js:8-11` — `sha256File` reads the entire file into memory via `fsp.readFile` to hash it; for large uploads a streaming hash would avoid a full-buffer load (ties into the missing size-cap concern).

### backend/services/documentIngestion/heuristics.js

- **[important]** `backend/services/documentIngestion/heuristics.js:102` — Two-digit year handling in `parseDateToISO` hardcodes the `19` century: `if (year.length === 2) year = '19' + year`. A DOB/effective date of `06/19/26` becomes `1926`, not `2026` — systematically wrong for 2000s two-digit years on benefit/insurance documents.
- **[important]** `backend/services/documentIngestion/heuristics.js:140-572` — This module extracts and emits raw PII (Medicaid/Medicare member IDs, recipient numbers, DOB, full name, EIN/UEI/CAGE) from uploaded documents into the profile. Identifiers like `member_id`/`group_id` are highly sensitive; ensure downstream storage/logging redacts them. No leakage bug in this file itself, but it is the PII-extraction surface and the extracted values flow into profile fields and (potentially) LLM prompts — flag for PII-handling review at the consumer.
- **[nit]** `backend/services/documentIngestion/heuristics.js:40` — `extractLabeledValue` builds `new RegExp` from `labelRegex.source` with a permissive `[^\n\r]{2,80}` capture; an attacker-controlled document with a crafted "Mission:" / "Address:" line can inject up to 80 chars of arbitrary text into a profile field that may later be fed to an LLM (prompt-injection vector at the consumer, not here).
- **[nit]** `backend/services/documentIngestion/heuristics.js:357,360` — EIN/UEI fallbacks (`extractFirstMatch(source, /\b([0-9]{2}-[0-9]{7})\b/)`, `/\b([A-Z][A-Z0-9]{11})\b/`) match any 9-digit-dashed or 12-char alnum token even without a label, so an unrelated number on the document can be mis-captured as an EIN/UEI.

### backend/services/documentIngestion/pdf/pdftoppm.js

- **[important]** `backend/services/documentIngestion/pdf/pdftoppm.js:31-47` — `resolveBinary` returns the binary name even when the `-h` probe fails with a non-ENOENT error ("other errors still indicate binary exists"). If `pdftoppm` exists but is broken/misconfigured, the later conversion exec will fail; acceptable, but it can also return a candidate that is not actually runnable. The `pdfPath` is passed to `execFile` (not a shell) so there is no shell-injection, which is correct.
- **[nit]** `backend/services/documentIngestion/pdf/pdftoppm.js:80` — `maxBuffer: 10MB` on the exec captures stdout/stderr; `pdftoppm -png` writes images to disk (prefix), so stdout stays small — fine, but a very chatty stderr could still hit the buffer cap and reject.

### backend/services/documentIngestion/ocr/index.js

- No issues found. Deterministic provider selection with explicit throws on unknown/unimplemented providers.

### backend/services/documentIngestion/ocr/providers/tesseract.js

- **[nit]** `backend/services/documentIngestion/ocr/providers/tesseract.js:53` — `worker.recognize(filePath)` is passed a path with no validation that the file is a supported raster image; a non-image path yields undefined behavior (documented in the comment but not guarded).
- **[nit]** `backend/services/documentIngestion/ocr/providers/tesseract.js:38` — Mojibake in a warning string (corrupted dash before "OCR quality may be degraded"); cosmetic.

### backend/services/documentIngestion/ocr/providers/awsTextract.js

- **[important]** `backend/services/documentIngestion/ocr/providers/awsTextract.js:54-66` — `DetectDocumentTextCommand` is sent with `Document: { Bytes: bytes }` (synchronous, single-page) with no file-size guard; Textract's synchronous API rejects images > 10MB / 5MB depending on type. Combined with the missing upstream size cap, oversized images produce an API error that is caught and returned as an empty-text warning (graceful) but wastes an API call.
- **[nit]** `backend/services/documentIngestion/ocr/providers/awsTextract.js:77` — Average LINE confidence divides by `confs.length` after filtering for finite values; if all lines lack confidence, `confs.length === 0` short-circuits to `null` (no divide-by-zero) — correct, noted as verified.

### backend/services/documentIngestion/documentExtractStore.js

- **[important]** `backend/services/documentIngestion/documentExtractStore.js:240-354` — `tryReuseExtractByHash` copies a previously-extracted `text`/`ocr_text` from ANY `document_extracts` row with a matching `file_hash`, with no tenant/profile scoping (the code comment explicitly notes it "ignores document_id uniqueness"). If two different tenants upload byte-identical files, one tenant's extracted document text (incl. PII member IDs from heuristics) is copied into the other's extract row. Content is identical by hash, but this is a cross-tenant content-reuse path that should be scoped or gated.
- **[nit]** `backend/services/documentIngestion/documentExtractStore.js:29` — Mojibake in the `console.warn` ("â hash-reuse will be unavailable"); cosmetic.
- **[nit]** `backend/services/documentIngestion/documentExtractStore.js:18-20` — `getDocumentExtract` runs `SELECT *` with `LIMIT 1` and no tenant scoping; relies entirely on `document_id` being globally unique. Consistent with the rest of the store but unscoped.

---

## seed/

### backend/services/seed/seedNationalPrograms.js

- **[important]** `backend/services/seed/seedNationalPrograms.js:136` — `inserted: insertedIds.length` reports `0` on every re-seed because `bulkUpsertFundingOpportunities` returns IDs only for newly inserted rows (`opportunityInserter.js:1219`), while upserts/updates return `inserted:false`. The docstring frames re-runs as benign, but a caller logging "0 inserted" as failure will be misled.
- **[important]** `backend/services/seed/seedNationalPrograms.js:119` — Only a null/undefined `db` guard (`if (!db)`); a wrong-typed `db` passes and fails deep inside the bulk transaction, flattened to a string at line 142.
- **[nit]** `backend/services/seed/seedNationalPrograms.js:122,131` — `skipUrlVerification` is computed and passed but the inserter gates URL probing on `opts.skipVerification`/`opts.verifyUrls`/`URL_VERIFICATION_ENABLED` (`opportunityInserter.js:77-81`), never reading `skipUrlVerification` — the flag is dead/ignored.
- **[nit]** `backend/services/seed/seedNationalPrograms.js:96` — `is_national: program.isNational !== false` defaults a missing flag to `true`, silently marking a state-specific program (non-null `state`) as national.
- **[nit]** `backend/services/seed/seedNationalPrograms.js:103` — `eligibility_criteria` and `application_note` both populated from the single `program.applicationNote` field, conflating two distinct concepts.

### backend/services/seed/seedScholarships.js

- **[important]** `backend/services/seed/seedScholarships.js:173` — Same misleading `inserted: 0`-on-re-seed semantics as the national-programs seed.
- **[nit]** `backend/services/seed/seedScholarships.js:155` — Same null-only `db` guard.
- **[nit]** `backend/services/seed/seedScholarships.js:159` — Same dead `skipUrlVerification` flag.
- **[nit]** `backend/services/seed/seedScholarships.js:142-143` — `max_amount` and `priority` are added to the canonical object but the inserter has no such columns (it uses `amount_max`); both are silently dropped on insert.
- **[nit]** `backend/services/seed/seedScholarships.js:107-109` — Eligibility lines interpolate raw `minGPA`/`minACT` into free text without type validation; a non-scalar source value stringifies to `[object Object]`. Not a SQL-injection risk (bound as a parameter downstream).

(Both seed files contain no SQL of their own; all persistence delegates to the parameterized `bulkUpsertFundingOpportunities`. No hardcoded secrets, no tenant-scoping issue — these are global curated catalog rows.)
