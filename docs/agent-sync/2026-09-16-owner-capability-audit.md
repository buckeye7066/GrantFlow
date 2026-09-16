# 2026-09-16 — owner capability audit: executable evidence, not labels

## Owner directive

Production readiness is not satisfied by agent names, prompts, generic copy, or
the existence of a route. GrantFlow must prove the complete outcomes:

1. discovery uses the applicable profile facts and enforces real, relatable,
   need-matched, and qualified-for before surfacing direct funding;
2. item funding derives concrete needs from the profile and searches arbitrary
   owner-entered items through the same evidence gate;
3. tiers and add-ons are enforced server-side at canonical capability gates;
4. Anya, Amy, Sam, Yana, John, Robert, and Hamilton perform their stated live
   jobs through production call paths rather than disconnected demo modules;
5. authorized Complete Autonomy can draft from grounded profile/source facts,
   operate supported portals, submit, and retain durable external proof.

## Important repository-reading distinction

`backend/crawler-os/agents/*` is a test-only, self-contained fleet. Those files
explicitly identify themselves as non-live and are not the production agent
implementations. Capability acceptance must follow runtime routes and imports:

- Anya: `backend/services/anyaOrchestrator.js` and `anyaToolRegistry.js`
- Amy: `backend/services/amy/*`
- Sam: `backend/services/sam/*` plus the admin code-audit services
- Yana: `backend/services/yana/*` and `yanaOutreach/*`
- John: `backend/services/john/*`
- Robert: `backend/services/robert/*` plus the canonical matcher
- Hamilton: `backend/services/hamilton/*`

This distinction is not a production-readiness claim. Each live path still
needs an end-to-end receipt proving its outcome.

## First concrete defect closed in this pass

The protected Hamilton preflight summary labeled every returned source as
"ready," even when a source row had `ok:false`. A run with 20 total source rows
and blocked rows could therefore be reported as "20 ready, 6 blockers." The
summary now counts ready and blocked rows separately and emits aggregate blocker
kinds without logging profile facts, portal names, URLs, or blocker details.

This observability correction does not clear a blocker and does not authorize a
submission. It makes the next owner-approved-profile acceptance run actionable: engineering
can fix the actual blocker classes rather than guessing from a misleading total.

## Binding work order

1. Re-run the protected owner-approved-profile preflight and close each reported blocker at
   its canonical choke point; then obtain durable external submission proof.
2. Close the 139-ZIP verified-source deficit or narrow the product promise.
3. Configure the live search provider and owner-ratified parity policy, then
   produce a green exact-50 Amy/crawler/parity receipt.
4. Execute the isolated Stripe lifecycle matrix against a test customer.
5. Run profile-grounded acceptance fixtures for item search, crawler planning,
   all four funding truths, agent tools, tailored outreach, matching, drafting,
   portal formatting, tier/add-on enforcement, and admin-only authority.

No item is complete because documentation says it is. Completion requires a
session-local production receipt or an executable hermetic acceptance test for
the exact boundary being claimed.
