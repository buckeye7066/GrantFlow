Entity verification sources planned for integration.

**Update (2026-08-14, gf-phase2-batch-02 purpose-alignment pass):** this is no
longer accurate as a future-tense statement — a free, keyless verification
layer is already integrated and live, not merely planned. See
`backend/services/verification/index.js` (coordinator: async ProPublica +
Census enrichment via `enrichOpportunityVerification`/`enrichProfileGeo`, plus
a synchronous, conservative match-score adjustment
`verificationMatchAdjustment` consumed by the matcher), with the org lookup in
`backend/services/verification/nonprofitRegistry.js` (ProPublica Nonprofit
Explorer, `lookupByEin`/`lookupByName`) and geo lookup in
`backend/services/verification/censusGeo.js`. Feature gates:
`isRegistryVerificationEnabled()` / `isCensusGeoEnabled()`
(`backend/services/verification/verificationConfig.js`). Test fixture:
`backend/tests/fixtures/verification/propublicaOrganization.json`. This
one-line note predates that work and was never updated; treat the code above,
not this file, as the source of truth for entity-verification status.
