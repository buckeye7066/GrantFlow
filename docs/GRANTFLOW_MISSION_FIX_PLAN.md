# GrantFlow Mission Fix Plan — Canonical Layer Contract & Remediation Sequence

**Branch:** `audit/root-fix-grantflow-mission` · **Date:** 2026-06-09

This plan documents the intended architecture (the contract every layer must
honor), what changed in this pass, and the prioritized sequence for the remaining
confirmed work in `AUDIT_GRANTFLOW_ROOT_CAUSES.md`.

---

## 1. Canonical layers (single sources of truth)

| Concern | Canonical module | Rule |
|--------|------------------|------|
| Reality / trust of an opportunity | `backend/services/opportunityRealityGate.js` (`assessReality`) | Every **user-visible / active** row must pass it before becoming visible. |
| Insert/upsert with gate | `backend/services/opportunityInserter.js` (`upsertFundingOpportunity`, `bulkUpsertFundingOpportunities`) | The only sanctioned writer; runs reality gate + quality gate + URL-fingerprint dedupe. |
| Match decision + reasons | `backend/services/matchEngine.js` (`computeMatchDecision`) | Sole authority for ACCEPT/REVIEW/REJECT, score, and user-facing reasons. `matchDecisionEngine.js` re-exports it; `matchingEngine.js` is a deprecated shim; `crawlers/matchEngine.js` is a candidate prefilter only. |
| Thresholds | `backend/config/matchThresholds.js` | All accept/review/reject + display thresholds. UI must consume these, not hardcode. |
| Profile interpretation | `backend/services/profileNormalizer.js` + `profileSignals/` | Reads full profile (top-level + sections + org). All matchers/crawlers consume this context. |
| Opportunity normalization | `backend/services/opportunityNormalizer.js` | Funding-type, loan, entity/need classification. Unknown → `unknown` (never `grant`). |
| Source definitions | `backend/services/sourceRegistry.js` | Source id/name/type/trust/profile-types/needs. (Operational metadata pending — RC-16.) |
| Zero-result expansion | `backend/services/zeroResultLadder.js` | Staged, labeled fallback — never threshold-to-zero junk. |
| Schema apply (scripts) | `backend/db/ensureSqliteSchema.js` (`applySqliteSchema`) | Reconciles columns on pre-existing SQLite DBs before applying schema. |

---

## 2. Reality gate contract (`assessReality(opp, opts)`)

Returns `{ allowed, kind, trustTier, reasons[], downgrade, usableUrl }`.
Hard-rejects (defaults; overridable via `allow*` opts): no real HTTP(S) URL,
placeholder/lorem/test content, loan-like (`allowLoans`), matching-funds for
direct/benefit (`allowMatchingFunds`), social-only URL for direct
(`allowSocialDirect`), expired direct deadline (`allowExpired`), `link_status='broken'`
direct (`allowBrokenDirect`). Directories/referrals soft-downgrade rather than reject
on non-actionable/broken links.

**Contract:** every insert path and every active-row display path must derive its
visibility from this gate — either by calling it, or by filtering on a persisted
`reality_status` written at insert time (RC-8, pending).

**This pass:** the government-import path (`ingestionService.ingestOpportunities`)
now enforces `assessReality` for active rows (RC-6). Inactive reference rows
(`is_active=0`, e.g. USAspending past awards) are exempt by design.

---

## 3. Matching contract

- `computeMatchDecision(rawProfile, rawOpp, opts)` returns: `decision`, `score`,
  `match_explain.scoreBreakdown` (component scores), `matchedNeeds`,
  `matchedProfileTraits`, `matched_profile_facts`, `ineligibilityReasons`,
  `missingEligibilityFields`, `needAlignment`, `confidence`, `matcherVersion`.
- **This pass:** `missingEligibilityFields` is now populated on the ACCEPT/REVIEW
  path (RC-5), and the **UI no longer fabricates** the decision — it shows the
  backend verdict or `UNRATED` (RC-4).
- Normalization: unknown funding type stays `unknown` (RC-2); loan detection spans
  full text + metadata with a forgiveness exemption (RC-3).
- **Pending:** Anya match scout + `explainMatch` must consume `computeMatchDecision`
  (RC-9, RC-10); UI threshold ladders must consume `matchThresholds`/`matchDisplayThresholds`
  from one source (RC-9 note); source-trust + deadline caveats should be emitted by the
  decision itself.

---

## 4. Anya behavior contract

- **Honesty (already enforced in prompt):** never claim an action without a
  successful tool call; never narrate success on `error`/`confirmation_required`.
- **Grounding:** use canonical profile context, canonical match explanations,
  canonical reality status, canonical application workflow.
- **Pending (RC-11):** the set of tools the prompt presents as directly callable
  must equal the chat whitelist (single source of truth); write tools must be
  confirmation-gated; add zero-result-guidance / deadline / pipeline-summary tools;
  add a test asserting prompt-listed tools ⊆ whitelist and that `explainMatch` agrees
  with `computeMatchDecision`.

---

## 5. UI / workflow contract

- Result cards must show source, trust tier, link status, deadline status,
  direct/referral/directory label, **loan/matching-funds warning**, **expired label**,
  explanation, and actions. (Loan/expired chips pending — RC-15.)
- Zero-result pages must explain searched/expanded/why + profile gaps + a deeper-search
  action. (Wiring pending — RC-12.)
- One canonical pipeline stage enum aligned to:
  `discovered → saved → interested → gathering_documents → drafting → ready_to_submit →
  submitted → follow_up → awarded → declined → archived`. (Unification pending — RC-13.)
- Persistence: saved/favorite/hide/application/deadline survive reload + login,
  scoped by **user AND profile**. (Saved items need `profile_id` — RC-14.)

---

## 6. Architecture: before → after (this pass)

| Area | Before | After |
|------|--------|-------|
| Mission gates on existing DB | crashed on `opportunity_kind` | pass (column reconciler) |
| Funding-type default | unknown → `grant` | unknown → `unknown` |
| Loan detection | title-only | full text + metadata + forgiveness exemption |
| Match decision (UI) | client re-derived from 70/35 ladder | backend verdict or `UNRATED` |
| `missingEligibilityFields` | dropped on ACCEPT/REVIEW | propagated |
| Gov import (grants.gov/USAspending/NIH) | reality gate bypassed | reality gate enforced for active rows |

---

## 7. Recommended remediation sequence (remaining)

1. **RC-8 (structural):** persist `reality_status`/`reality_reasons`/`final_url`/`http_status`;
   make readers filter the stored verdict. Unblocks consistent insert↔display gating.
2. **RC-7:** route `nationalZipCrawler`, Anya autonomous promote, admin create/bulk,
   and seed endpoints through `opportunityInserter` (gate + URL-fingerprint dedupe).
3. **RC-9 / RC-10 / RC-11:** make Anya consume the canonical engine and reconcile
   prompt↔whitelist; add grounding tests.
4. **RC-12:** surface zero-result ladder diagnostics in the UI; remove legacy top-N junk fallback.
5. **RC-13 / RC-14 / RC-15:** unify pipeline stages; profile-scope saved items; render loan/expired chips.
6. **RC-16 / RC-17:** sourceRegistry operational metadata; fold document text into profile signals.

Each step ships with unit + integration tests and is gated by
`npm run check:prepush` and the mission gates before merge.
