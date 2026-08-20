# Agent sync — Axiom BioLabs website-purpose matching (2026-08-20)

## Owner directive
GrantFlow must look at the profile's website URL to see what the profile is.
Axiom BioLabs Hamilton queue (~87 Working on now) was mostly unrelated
institutional NOFOs.

## Verdict on the pasted Hamilton list (~87 titles)
- **Real / on-mission matches: ~3–7** (NIH STTR Parent, SBIR/STTR CRP, Engineering
  Biomedical / EBBS, Catalyze biologics product definition, DoW Peer Reviewed
  Medical therapeutic tracks, DHA extramural medical BAA).
- **Junk / unrelated purpose locks: majority** (Title X, CACFP, law-enforcement
  wellness, Alzheimer's ADPI, outdoor recreation, housing/lead-safe, kinship,
  specialty crop / RCPP / FDPIR, fishing, coral reef, HSLDA, info-collection
  notices, Vet-LIRN, etc.).

## Fix
- `backend/config/profileWebsitePurpose.js`
- `profileDerivedFacts` website topical seeds (not recall-safe)
- `stageOfLifeConflictForSections` also applies `websitePurposeConflict`
  (matchEngine already calls this choke point)
- Tests: `backend/tests/profileWebsitePurpose.test.js`
- PR: https://github.com/buckeye7066/GrantFlow/pull/1288

## Hamilton Needs your input (Axiom)
Only actionable owner item from the paste: **Set Hamilton’s master passphrase**
(Open Portals). The 87 Working-on-now items are mostly junk matches — not
missing profile fields.
