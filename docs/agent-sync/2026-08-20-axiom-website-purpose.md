# Agent sync — Axiom BioLabs website-purpose matching (2026-08-20)

## Owner directive
GrantFlow must look at the profile's website URL to see what the profile is.
Axiom BioLabs Hamilton queue (~87 "Working on now") was mostly unrelated
institutional NOFOs.

## Verdict on the pasted Hamilton list (~87 titles)
- **Real / on-mission matches: ~3–7** (NIH STTR Parent, SBIR/STTR CRP, Engineering
  Biomedical / EBBS, Catalyze biologics product definition, DoW Peer Reviewed
  Medical therapeutic tracks, DHA extramural medical BAA).
- **Junk / unrelated purpose locks: ~70+** (Title X, CACFP food integrity,
  law-enforcement wellness, Alzheimer's ADPI/respite, outdoor recreation,
  housing/lead-safe, kinship, mine safety, specialty crop / RCPP / FDPIR,
  commercial fishing, coral reef, Great Lakes AIS, HSLDA, information-collection
  notices, Vet-LIRN, falls prevention, mass violence center, etc.).
- **Stretch / not locked but weak: remainder** (generic NSF topic BAAs, K-award
  limited competitions, shared instrumentation S10/S15, BRAIN U24 resources).

## Fix (in flight)
- Module: `backend/config/profileWebsitePurpose.js`
- Derived facts: website purpose topical seeds (not recall-safe)
- Engine choke point: `matchEngine.makeDecision` → `websitePurposeConflict`
- Tests: `backend/tests/profileWebsitePurpose.test.js`
- Branch: `fix/axiom-website-purpose-matching`

## Still needed after merge
- Redeploy so live engine rejects; next crawl / Hamilton stop recheck clears
  stored REJECT tasks for Axiom.
- Optional: boot net purge of match rows with website-purpose REJECT (not
  required for correctness of new decisions).

## Deferred
- Vermilion Church junk pipeline (owner queue after this).
- Hamilton real-portal submit PR #1286 (billing-blocked).
