# 2026-09-01 — PromoPilot month-long stall + FlexFactor option 4

Audience: whoever next touches PromoPilot publishing or FlexFactor prodready.

## PromoPilot — why nothing published since 2026-08-06

Live production (`https://promopilot-production-6370.up.railway.app`),
revision `0a0d8fcc255e512a439837b6611fd1acfeb6bc00`, measured 2026-09-01T19:14Z.

The process is up. The scheduler is not “dead.”

| Check | Live value |
|---|---|
| `/healthz` | `scheduler_enabled: true`, `publishing_enabled: true` |
| `/readyz` | `status: ready`, every setup check true |
| Portfolio arm | `operation_mode: live`, `killed: 0`, `daily_cap: 2` |
| `armed_at` | **2026-09-01T12:52:39Z** (re-armed today) |
| `killed_at` | **2026-08-06T15:42:36Z** (same minute as the last recent-post) |
| Open drafts | **0** |
| Last recent post | 2026-08-06T20:21:12Z Mastodon **failed** (`login is currently disabled`) |

Kill on Aug 6 is why the month went silent. Re-arm today did **not** resume
delivery because every publishable channel still has `needs_approval: true`.

Approval reasons (live `/api/overview` channels):

- Axiom dests: `policy_version_changed` — dest was approved under policy
  **1.0.0**, current is **2.0.0**.
- Ellie dests: `unreviewed_legacy_channel`.
- Ellie Bluesky/Mastodon: `verification_state=verified` but `verified_at=null`
  (UI prints that as **12/31/1969**).

Only one channel is `connector_ready`: Axiom Mastodon (verified
2026-08-30T04:42:05Z). It still needs “Approve under new policy.”

Approved campaigns (ready to promote, no dest they can use):

- GrantFlow funding workflow education
- SermonSmith preparation workflow
- The Covenant Veil reader discovery
- Ellie Williams titles and tools

### The deadlock (this is the code bug)

UI copy: “Generate draft prepares copy for review; it never publishes by itself.”

Live `POST /api/post-now` on the ready Mastodon channel, dest still needing
re-approval:

```json
{"status":"skipped","reason":"needs_approval",
 "detail":"approved under policy 1.0.0, current is 2.0.0 — re-approve the channel"}
```

So after a policy bump, **draft generation is refused**, dests need re-approval,
and the queue is empty. Next-steps tell the owner to “generate its first draft”
and that button 409s. Publishing cannot restart until dests are re-approved
under policy 2.0.0, then drafts are generated and approved.

Credentials are not dead. `POST /api/channels/<axiom-bluesky>/verify` on
2026-09-01 returned `ok: true` for `@axiombiolabs.bsky.social`. That only
re-verified identity; it does **not** approve the dest and does **not** post.

### What to change in `buckeye7066/promopilot` (repo not readable from this token)

This workspace token can clone GrantFlow + public FlexFactor only.
`buckeye7066/promopilot` returns GitHub 404/Not Found.

When you have the repo:

1. **Draft generation must survive dest re-approval.** `post-now` (or a
   dedicated generate-draft route) should return `needs_post_approval` and
   write a draft when the dest is verified but `needs_approval` /
   `policy_version_changed`. Keep dest approval as the **publish/schedule**
   gate, matching the UI.
2. Persist `verified_at` on every successful verify. `null` must not render
   as Unix epoch / “stale forever.”
3. After `control-plane/arm`, if approved campaigns exist and dests only fail
   `policy_version_changed`, surface one re-approve action — do not leave
   generate-draft as a dead button.

Owner recovery until that ships: in Channels, **Approve under new policy**
on verified dests (Axiom Mastodon; Axiom Bluesky after the 2026-09-01 test),
then Generate draft, then approve exact copy. Do not expect the scheduler to
invent drafts while dests are unapproved.

## FlexFactor / AI-factory option 4

Launcher option **4** is `prodready` (`flexfactor_launch.ps1`).
Portfolio option 4 in `PORTFOLIO_CHATGPT_PRODUCTION_READINESS.md` is PromoPilot.

- FlexFactor clone: `/home/ubuntu/flexfactor` @ `25dd1d7` (`main`).
- `main` `production-readiness` CI is **green**.
- Open PR #110 `fix/autoclean-verifies-what-it-commits` is **red**:
  `flexfactor_autoclean_preverify_tests.py` exists but is missing from
  `.github/workflows/production-readiness.yml`. Totality test
  `test_EVERY_test_module_is_in_the_workflow_test_list` fails.
- Local fix committed on `cursor/flexfactor-ci-wire-preverify-2a4f`
  (`abb7619`): add that module next to `flexfactor_autoclean_tests.py`.
  Tests pass locally. **Push to `buckeye7066/flexfactor` 403** from this
  GrantFlow integration token (`denied to cursor[bot]`).
- `buckeye7066/local-ai-factory` is also Not Found to this token, so an
  AI-factory option-4 run could not be started here.

Second agent launched for the FlexFactor / AI-factory lane:
`bc-c951748a-d56d-5729-990c-249a56c75d68`.
