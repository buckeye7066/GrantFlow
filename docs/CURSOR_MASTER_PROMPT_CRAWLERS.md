# GrantFlow Crawler Rules For Cursor

Use this as the crawler rule sheet for GrantFlow. The live crawler architecture is Crawler OS. Do not rebuild or revive the retired crawlerManager/strategy stack.

Unified implementation reference: [docs/CRAWLERS.md](CRAWLERS.md)

## Canon

- GrantFlow must find real funding sources that match the active profile.
- The crawler must use the full profile: top-level fields, sections, linked organizations, location, documents, school data, known preferences, saved/hidden feedback, and extracted signals where available.
- Empty profile fields are neutral. They may produce missing-field guidance, but they must not become hidden penalties.
- Every user-visible opportunity must have a real sponsor/source, a real HTTP(S) URL when it is an actionable opportunity, and a persisted reality verdict.
- Loans, microloans, financing, and cost-share/matching-fund opportunities must not be treated as grants unless the profile explicitly allows them.
- Direct opportunities, directories, referrals, benefits, scholarships, institutional aid, and past-award intelligence must be clearly distinguished.
- Zero results are diagnostic states. Explain what was searched, what was skipped, which profile fields would help, and what deeper search should run next.

## Active Architecture

Crawler OS is the active discovery spine:

1. `backend/crawler-os/profileIntelligence.js` builds a thesis from the active profile.
2. `backend/crawler-os/planner.js` chooses sources from the registry.
3. `backend/crawler-os/adapters/*` build real source requests and map source rows.
4. `backend/crawler-os/realityGate.js` blocks fake, placeholder, loan, bad-URL, expired, and unsupported rows before catalog insertion.
5. `backend/crawler-os/normalizer.js` converts accepted candidates into the shared opportunity shape.
6. `backend/crawler-os/storage.js` writes global opportunities and profile-scoped matches.
7. `backend/crawler-os/matchEngine.js` is only a facade. It must delegate scoring and ACCEPT/REVIEW/REJECT decisions to `backend/services/matchEngine.js`.
8. `backend/services/crawlerOsService.js` is the live app boundary for routes, schedulers, and agents.

The old discovery crawler stack is retired from runtime. Do not import legacy crawler modules into active runtime code.

## Matching Authority

- `backend/services/matchEngine.js` and `computeMatchDecision(rawProfile, rawOpportunity, opts?)` are the sole decision authority.
- No crawler, route, UI component, helper, or agent may invent its own ACCEPT/REVIEW/REJECT logic.
- Crawler OS may adapt field shapes, but it must not keep separate scoring weights or a separate `decide()` function.
- The Crawler OS stored decision tokens are lower-case for its storage contract; that is only a mapping of the canonical decision.
- Match explanations must come from canonical matcher output, including matched profile facts, missing fields, score breakdown, and eligibility reasons.

## Reality Rules

- Store only real, source-backed opportunities.
- Reject placeholders, lorem/test/sample rows, bad URLs, fake sponsors, search URLs masquerading as applications, and generic informational pages presented as funding.
- Directories can be stored only when labeled as directories and never as apply-now grants.
- Past awards can be stored only as intelligence, not as current opportunities.
- Expired opportunities must be clearly marked expired/inactive.
- Do not seed user-visible rows with fake/private profile data.

## Profile Rules

- Discovery must be profile-driven. Do not serve generic fallback matches to make an empty page look full.
- Use profile location, applicant type, needs, sections, documents, school information, and organization context.
- Missing demographics or optional fields are neutral; explicit mismatches can reject or downgrade.
- Student/school workflows should respect committed-school context and portal data where implemented.
- Health/disability studies may appear only when the profile opts in and the study is relevant to the profile.

## Persistence Rules

- Funding opportunities are global catalog rows.
- Match scores and decisions are profile-scoped rows.
- Saved, hidden, pipeline, application, deadline, document, portal, and agent state must be scoped by user and active profile where appropriate.
- Pipeline stages must use the shared canonical 11-stage enum.
- Agent jobs, hard stops, and automation actions must be auditable and resumable.

## Agent Boundaries

- Robert discovers, verifies, ingests, matches, and recommends real funding.
- Hamilton completes selected applications as far as legally, safely, and technically possible.
- Anya guides users and explains profile gaps, matches, workflows, and next steps.
- Yana finds qualified potential clients.
- John drafts emails only; do not auto-send.
- Sam monitors agents, failures, stuck jobs, hard stops, and safe code repair flows.
- The single admin/operator is `buckeye7066@gmail.com`.

## Required Checks After Crawler Changes

Run the smallest targeted tests first, then the broad guards:

```bash
node --test backend/crawler-os/tests/matchEngine.test.mjs backend/crawler-os/tests/pipeline.test.mjs backend/crawler-os/tests/legacy-crawler-ban.test.mjs
node --test tests/unit/canonical-authority-sweep.test.mjs tests/mission/mission-match-parity.test.mjs
npm run crawler:doctor
npm run opps:check-national-minimum
npm run runtime-imports:check
npm run check:prepush
```

When live credentials are available, also run the live mission smoke checks before claiming production readiness.
