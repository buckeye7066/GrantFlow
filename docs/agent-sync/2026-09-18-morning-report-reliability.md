# September 18 morning-report reliability follow-through

Baseline: deployed main c45d63cfcabc4a0801dd2410791431f2f72ee47a. Provider failover work is separate in PR #1760; this change does not edit that work or the locked shared checkout.

## Reproduced and repaired

One successful extraction made a partly failed web crawl report LLM healthy. Amy then inferred provider health from candidate counts, and the rolling health summary let a successful run erase quota failures. Six new assertions reproduced these defects while 48 existing controls passed. Mixed extraction now reports degraded, retains successfully extracted candidates and failure counts, and cannot earn clean cohort/recall credit. Explicit unavailable telemetry cannot be upgraded by candidate counts. Existing precision checks still run during partial outages.

The common email footer and verification template used the marketing URL instead of the application. Fresh browser checks confirmed that app.axiombiolabs.org/login renders the login heading and email field; www.axiombiolabs.org/grantflow is a marketing page and its /login child renders the marketing home page. The shared sign-in resolver now defaults to the application login, repairs the known retired setting, preserves deployment overrides, and keeps HTML escaping. Eight new assertions failed before this repair.

Combined targeted verification: 151 tests passed across 11 suites, including crawl ledgers, Amy cohort gating, retained provider-health history, live-gap attribution, recall scorecards, and owner-email reporting. Full release gates and production readback are separate requirements, not implied by those tests.

Automated review also identified the remaining Sam consumer: the partial-outage verdict still returned a green check. A new DB-backed regression failed before the fix. Sam now emits an actionable degraded-extraction finding while preserving successful candidate counts and retained failure evidence.

## Findings deliberately not declared resolved

- Live result gaps: morning baseline 1738/1850; no history reset or threshold change.
- Amy cohort: morning baseline 0/49 clean of 50 target; healthy exact-revision acceptance remains required.
- Recall: morning baseline 290 extracted to 3 admitted; successful provider fallback is not qualification/admission proof.
- Google-bar: morning baseline 13.6 vs trailing median 25.75; fresh comparable benchmark required.
- Local EVA login: three isolated reruns passed. The overnight intermittent failure was not reproduced; startup timing is a hypothesis, not a verified root cause. No arbitrary wait increase or assertion weakening was applied.
- Federal Register: public API HTTP 200 and eight existing adapter tests passed from Home; no evidence yet that the original production adapter failure is permanently closed.

Production logs at 18:49-18:50 UTC still showed Anthropic credit exhaustion and Groq quota failures on c45d63c. Recent exact-50 acceptance workflow runs were cancelled, not passing receipts. PR #1760 must pass its checks and deployment verification, followed by healthy live discovery and qualified-outcome measurements before closing the four crawler findings.

No real applications or emails were sent by these tests. No real client records, matching thresholds, admission rules, benchmark history, or existing work were modified.
