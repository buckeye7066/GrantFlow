# Crawler query quality and learning attribution

An isolated live run at main `1f67b79b817b4bb2b3eb3afe143f3dea2fdbd2e5`
exposed four independent problems:

- Amy tags entered interest queries, including `amy crawler training scholarships`
  and `allow sam cleanup scholarships`. The shared thesis now excludes Amy's
  canonical bookkeeping markers, including normalized keyword copies, before
  applying its topic limit. Stored trace tags and cleanup guards are unchanged.
- Search ranking treated a Texas hotel page as strong for an El Paso homeschool
  grant query while demoting a homeschool grant program because it matched only
  the first distinctive word. Single-topic funding evidence now survives;
  generic single-word hits are backfill regardless of word position. Funding
  queries prefer topical funding evidence above generic topical pages. Ranking
  never proves eligibility and never deletes backfill.
- Eight hits from each early query filled 44 page slots after six of 28 planned
  queries. Allocation now reserves shares for later queries and backfills spare
  capacity from earlier results. Query ordering, search-result count, page cap,
  time budget, canonical deduplication and all downstream admission gates remain.
  More planned queries can execute, so search-request volume can increase up to
  the existing plan/time limit. Ledger counts include backfilled pages.
- Amy's archetype learning checked search health without the discovery gate's
  extraction-health verdict. Both gap learning and lesson clearing now use
  `discoveryGateFor`: extraction outages cannot establish recall gaps or prove
  that existing lessons are resolved. Legacy evaluation handling is unchanged.

Each failure was reproduced by a failing regression before repair. Verification:
47 Node profile/query tests; 71 search/provider tests; 51 web-lane tests; and
117 Amy/acceptance tests passed, all exit 0. Crawler syntax checking passed.
Fresh public SearXNG responses reproduced the hotel/grant inversion; comparison
on the same response promoted the homeschool grant source and demoted hotel and
tourism hits. These are source-discovery results, not verified awards.

The live 50-profile run was interrupted after diagnosing unusable extraction
throughput: the first profile took 43 minutes, fetched 46 pages, stored one
candidate, and recorded 40 model timeouts. It is NOT a passing acceptance run.
Its isolated recovery cleanup used the canonical Amy cleaner and deletion proof:
two synthetic profiles deleted, zero survivors, cleanup command exit 0. Diagnostic
receipts are retained in the workspace `.codex-tmp` directory. Reliable extraction,
a fresh completed exact-50 run and durable application of validated learning
remain required before declaring GrantFlow ready.

## Real-page extraction follow-up

The public Elephant Learning homeschool-grant page returned HTTP 200. With an
8192-token local context, the installed 1B model completed its actual structured
extraction in 116 seconds (2193 input tokens, 1112 output tokens). It invented a
2024 deadline and an Annual Report requirement absent from that page. Replaying
the actual response through GrantFlow proved that the deadline was neutralized
but the reporting requirement survived into the candidate/calendar contract.

Lifecycle fields now carry provenance into the shared evidence-span validator:
unsupported expected-decision dates, review durations and reporting requirements
are neutralized alongside other unsupported facts. Supported lifecycle facts
remain available to the candidate mapper. Extractor version `blind-v4` prevents
reuse of old cached facts. The same captured model response now has null deadline
and reporting requirements; replay assertions passed exit 0. All 26 extractor
Node tests and 56 lifecycle/extraction/cache tests passed exit 0. This validates
the observed grounding repair, not the local model's overall accuracy or speed.
