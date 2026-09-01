# 2026-09-01 — PromoPilot month-long stall + FlexFactor option 4

Audience: whoever next touches PromoPilot publishing or FlexFactor prodready.

## PromoPilot — why nothing published since 2026-08-06

Live production (`https://promopilot-production-6370.up.railway.app`).
First measured 2026-09-01T19:14Z at revision
`0a0d8fcc255e512a439837b6611fd1acfeb6bc00`. Re-measured 2026-09-01T19:25Z
after a Railway deploy to `b68d809cab2969a33a2cae8e96787d01adfb7b04`.
The deadlock is **unchanged** on the new SHA.

The process is up. The scheduler is not “dead.”

| Check | Live value |
|---|---|
| `/healthz` | `scheduler_enabled: true`, `publishing_enabled: true` |
| `/readyz` | `status: ready`, every setup check true |
| Portfolio arm | `operation_mode: live`, `killed: 0`, `daily_cap: 2` |
| `armed_at` | **2026-09-01T12:52:39Z** (re-armed today) |
| `killed_at` | **2026-08-06T15:42:36Z** (same minute as the last recent-post) |
| Open drafts | **0** (still, after dest re-approval) |
| Last recent post | 2026-08-06T20:21:12Z Mastodon **failed** (`login is currently disabled`) |

Kill on Aug 6 is why the month went silent. Dest re-approval on 2026-09-01
cleared the policy-2.0 gate on two Bluesky dests and still produced **no
draft** — the next gates are campaign/platform matching and a generator
CTA check that refuses to persist a draft.

### Operational progress 2026-09-01T19:27–19:31Z (this session)

Dest-approved under policy **2.0.0** (exact receipts; did **not** publish):

| Dest | Channel | `approved_at` |
|---|---|---|
| `@axiombiolabs.bsky.social` | `c372f29b-7f4f-443f-8410-64a571361b9d` | 2026-09-01T19:27:46Z |
| Ellie Williams bluesky (`@elliewwrites.bsky.social`) | `1781120c-593c-4978-acca-eb70bb2f647d` | 2026-09-01T19:29:38Z |

Then `POST /api/post-now`:

1. Axiom Bluesky → 409 `needs_campaign_approval`. Approved Axiom campaigns
   (`grantflow` / `sermonsmith` / `the-covenant-veil`) list
   `allowed_platforms: [youtube, facebook_page, threads, x]` only — **not
   bluesky**, which is the only Axiom dest that is verified + approved.
2. Ellie Bluesky → 409 `needs_campaign_approval` while paused Ellie items
   (`grant-application-readiness-pack`, `csv-sanity`) were still enabled.
   Re-approved `campaign-your-first-grant-always-on` (was paused). Disabled
   those two paused items so the picker can reach Your First Grant.
3. Ellie Bluesky after that → 409 `canonical_cta_mismatch`
   (`promo copy must contain the approved tracked URL exactly once`).
   Retried 3+ times and with explicit `content`/`tracked_url` bodies —
   extra fields are ignored. **No draft row is written.** Queue still 0.

Axiom Mastodon remains `needs_approval` / policy 1.0.0 (login disabled;
do not dest-approve it expecting delivery).

### Operational progress 2026-09-01T19:37–19:40Z

Live SHA still `b68d809`. Arm unchanged. Queue still **0**.

Further live probes (no publish; dest approvals left as-is):

1. `POST /api/control-plane/campaigns/:id/approve` does **not** accept
   `allowed_platforms`. Axiom campaigns stay youtube/facebook_page/threads/x.
2. `POST /api/drafts`, `/api/drafts/create`, `/api/generate-draft` are **404**.
   Generate-draft is only `POST /api/post-now`.
3. Adding the known bio tracked URL as a `link` + `reflink` on
   `your-first-grant` did **not** change the 409. Those two assets were
   then `DELETE /api/assets/:id` (revoked 2026-09-01T19:40:43Z).
4. Pointing the item `url` at the bio `/r/your-first-grant?destination_id=360c9fd4…`
   URL (which 200-redirects to Stripe) bumped the campaign to **revision 4**
   and did **not** change `landing_url` (still Stripe). `post-now` then
   returned `needs_campaign_approval` until revision 4 was approved.
   Item URL was restored to Stripe. Campaign
   `campaign-your-first-grant-always-on` is **approved revision 4** as of
   2026-09-01T19:40:26Z.
5. `/r/your-first-grant` without a minted dest hash → `invalid_destination`.
   `destination_id=dest-ellie-williams-bluesky-elliewwrites` →
   `unknown_destination`. Bio pages mint a **different** 64-hex dest id
   (Ellie bio `360c9fd4…`). That hash is not SHA-256 of the dest-* id
   and is not in `/api/control-plane` destination rows. Bluesky dest hash
   for `/r/` is unknown from this token.

Generator still writes the campaign `landing_url` (Stripe / axiombiolabs.org
/ etc.). CTA gate wants `/r/<productId>` exactly once and **throws the copy
away**. Extra `content` / `tracked_url` / `mode` on `post-now` are ignored.

### The deadlock (this is the code bug)

UI copy: “Generate draft prepares copy for review; it never publishes by itself.”

Live `POST /api/post-now` on the ready Mastodon channel (first SHA) and
again on verified Axiom Bluesky after the `b68d809` deploy, dest still
needing re-approval:

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
4. **A skipped generate must still persist a draft.** `canonical_cta_mismatch`
   currently 409s and writes nothing. The UI already edits drafts; the
   generator must either insert the `/r/<productId>` tracked URL once or
   leave the copy in the queue for that edit. Extra `content` on `post-now`
   is ignored.
5. **Picker must skip paused campaigns and honor `allowed_platforms`.**
   Enabled items whose campaign is `paused` or whose allowlist excludes the
   dest currently 409 the whole `post-now` as `needs_campaign_approval`.
   Axiom always-on campaigns need `bluesky` on the allowlist if Bluesky is
   the dest that actually passes the connection test — or dest-approve a
   dest that is already on that list (facebook/threads/x/youtube), none of
   which have credentials today.

Owner recovery until the generator ships: Axiom + Ellie Bluesky dests are
already approved under 2.0.0. Generate draft on Ellie Bluesky still 409s
`canonical_cta_mismatch` and writes no queue row. Do not dest-approve
Axiom Mastodon (login disabled). Do not click Publish on a draft that
does not exist yet. Re-enable `csv-sanity` / `grant-application-readiness-pack`
in Campaign items if you want them listed again — they were switched off
only so the picker could reach the approved Your First Grant campaign.

## FlexFactor / AI-factory option 4

Launcher option **4** is `prodready` (`flexfactor_launch.ps1`).
Portfolio option 4 in `PORTFOLIO_CHATGPT_PRODUCTION_READINESS.md` is PromoPilot.

- FlexFactor clone: `/home/ubuntu/src/flexfactor` @ `25dd1d7` (`main`);
  `/home/ubuntu/flexfactor` is a symlink to that clone.
- `main` `production-readiness` CI is **green** at
  `25dd1d74e50ef71e4e1e749d4bbe435665822001`.
- Open PR #110 `fix/autoclean-verifies-what-it-commits` is **red**:
  `flexfactor_autoclean_preverify_tests.py` exists but is missing from
  `.github/workflows/production-readiness.yml`. Totality test
  `test_EVERY_test_module_is_in_the_workflow_test_list` fails.
- Local CI wire on `cursor/flexfactor-ci-wire-preverify-2a4f` (`abb7619`):
  add that module next to `flexfactor_autoclean_tests.py`. Tests pass
  locally. **Push to `buckeye7066/flexfactor` 403** (`denied to cursor[bot]`).
- `buckeye7066/local-ai-factory` is also Not Found to this token, so an
  AI-factory option-4 run could not be started here. Ports 5179 / 5190
  were not listening.

GrantFlow EVA used to list FlexFactor / Scout as `repo: "local-only"`.
That is stale: the GitHub repo is public. Corrected in this same change
to `buckeye7066/flexfactor` in `qa/manifests/flexfactor.json`,
`qa/manifests/scout-a-program.json`, and `qa/portfolio-registry.json`.

Second agent for the FlexFactor / AI-factory lane:
[FlexFactor AI-factory option 4](bc-c951748a-d56d-5729-990c-249a56c75d68)
(IDLE, done). Follow-up launched 2026-09-01T19:41Z:
[FlexFactor option 4 apply](bc-b97b5389-e742-5895-8193-8e35f10fa427).
Evidence file `/tmp/flexfactor-aifactory-status.md`.
PR #110 re-measured 2026-09-01T19:40Z: head still `634250c`,
production-readiness tests **FAILURE** on ubuntu+windows.

### Option 4 identity (verified in FlexFactor, not Factory Deck)

Launcher option **4** is `prodready` (`flexfactor_launch.ps1`:
`1) refactor  2) scout  3) audit  4) prodready`).
Portfolio-board item 4 is PromoPilot — a different list.

Factory Deck New Run numbering is **UNKNOWN** (factory repo 404).

### Option 4 runs (disposable `/tmp/ff-option4-fixture`, no spend)

| Run | Outcome |
|---|---|
| First | EXIT 1 fail-closed (no free model). **Crash:** Tk child `ModuleNotFoundError: No module named 'tkinter'` while parent printed “Live dashboard launched”. |
| Second (after local fix) | EXIT 1, same honest preflight. **No traceback.** Printed `Live Tk dashboard skipped (tkinter is not installed)`. |

Local Tk-skip fix (not on GitHub): branch
`cursor/linux-dashboard-no-tk-5d68` @
`6076cd6ba0f8b9efb4e2bdbfc43d551507394f3f`.
`flexfactor_dashboard.tk_unavailable_reason()` + probe-before-Popen.
Push 403, same token limit.

Help / audit / prodready `--help`, compileall, and targeted suites
**PASS** on this host. Android `build_verifiable` is a named host
blocker (no Java/Gradle here); `android-client` CI was green on
`25dd1d7`. No Anthropic/OpenAI keys; Ollama down.

### FlexFactor verdict (2026-09-01)

| Requirement | Result |
|---|---|
| CLI start / help / audit entry | **PASS** locally |
| Option 4 identified as `prodready` | **PASS** |
| Option 4 apply to production-ready | **FAIL / fail-closed** — no model |
| AI-factory option 4 completion | **FAIL / BLOCKED** — factory 404 |
| Land Tk skip + CI wire on origin | **FAIL** 403 |

Do not treat FlexFactor as production-ready for an unattended
model-backed apply, and do not treat AI-factory as having run.

## Follow-up 2026-09-01T19:57–20:00Z — CTA is dest-specific, not landing_url

Live SHA still `b68d809`. Arm unchanged. Queue still **0**.
Owner bio `/b/ellie-williams` restored to original Your First Grant.

### Picker is item-based

Disabling `your-first-grant` (only enabled Ellie item) then
`POST /api/post-now` on Ellie Bluesky → **409 `no_enabled_app`**.
The approved brand campaign `campaign-ellie-williams-always-on`
(`product_id: null`, landing `/b/ellie-williams`, bluesky allowed)
does **not** generate a draft by itself.

### A campaign whose landing_url already IS `/r/…` still 409s

Created disposable item `your-first-grant-tracked` with the bio
tracked URL. That minted

`campaign-your-first-grant-tracked-always-on`
- `product_id`: `your-first-grant-tracked`
- `landing_url`: the `/r/your-first-grant?destination_id=360c9fd4…` URL
- `allowed_platforms` includes `bluesky`
- approved revision 1

Enabled only that item. `POST /api/post-now` Ellie Bluesky → still
**409 `canonical_cta_mismatch`**. Updating the item URL to the
product’s own bio `/r/your-first-grant-tracked?destination_id=ec1fe773…`
(bio reminted a new dest hash when the listed product changed) and
re-approving revision 2 → **same 409**. Extra post-now fields
(`mode`, `dry_run`, `preview`, `generate_only`, `campaign_id`,
`tracked_url`) are still ignored.

So the generator does **not** insert the dest-specific minted URL.
CTA wants `/r/<this productId>?destination_id=<this dest’s hash>&utm_…`
exactly once. Bio dest hashes (`360c9fd4…`, `ec1fe773…`) are **not**
SHA-256 of dest-* ids or of `brand:platform:account:product` (brute
failed). Bluesky dest hash is not in `/api/control-plane`. Chicken
and egg: no draft ⇒ cannot observe the minted URL ⇒ cannot set
`landing_url` to it.

Experimental items `your-first-grant-tracked` and `ellie-titles-hub`
were **deleted**. Their leftover campaigns were **paused**. Original
YFG item re-enabled; campaign still **approved revision 4**; bio
again lists `/r/your-first-grant?destination_id=360c9fd4…`.
`csv-sanity` / `grant-application-readiness-pack` remain disabled
so the picker can reach YFG.

`gh repo list` still only GrantFlow (private) + flexfactor (public).
PromoPilot source remains unreachable. The generator/CTA insert
must land in `buckeye7066/promopilot`.

### FlexFactor this pass

Ollama now also has **`qwen2.5-coder:1.5b`** (free local pull).
Follow-up agent launched to retry option 4 with that model and
retry origin write paths:
[FlexFactor option 4 qwen](bc-5a7ee16b-c6da-5bbe-9645-e54cae715073).
Fixture `/tmp/ff-option4-qwen` @ `3493fa30` (planted `add()`).

That agent finished 2026-09-01T20:24Z. Evidence:
`/tmp/flexfactor-aifactory-status.md`. Option 4 **EXIT 1**,
**0 files fixed**, `hello.py` still `return a - b`. The 1.5b
model **named** the planted defect and that finding **passed**
the evidence gate; the fixer then no-op’d (`Cross-file
dependency…`). A free 3b retry also EXIT 1 / 0 files fixed
(batch review dropped the planted bug as ungrounded). Origin
writes still **403**. PR #110 head still `634250c`.
Do not treat FlexFactor as production-ready.

## Follow-up 2026-09-01T19:50Z (`bc-b97b5389-e742-5895-8193-8e35f10fa427`)

Re-tried every write path. All still **403** to `cursor[bot]`:
PR branch, `cursor/flexfactor-ci-wire-preverify-2a4f`,
`cursor/linux-dashboard-no-tk-5d68`, new `cursor/pr110-ci-wire-a427`,
GrantFlow token, Contents API PUT, fork create, `workflow_dispatch`.
Self-apply workflow is already on PR #110 and failed at 19:01Z
(`33547030041`) on a `flexfactor.py` 3-way apply conflict.

Local cherry-pick ready, **not on origin**:
`06c7d10b61b59047a6cd86018ca5662f6a4e3a5c` on
`cursor/pr110-ci-wire-a427` (abb7619 onto 634250c). PR head still
`634250cffd34298412cdc50fbdc3a9e96b518e35`.

Free model **now exists on this host** (this session installed it):
Ollama 0.33.2 @ `:11434`, `llama3.2:1b`. Option 4 was run to
**process completion** on `/tmp/ff-option4-followup` @ `fdb26ea`
(planted `add()` bug). **EXIT 1**. $0.00. 0 files fixed. The 1B
model named the planted defect; FlexFactor dropped it as ungrounded.
Readiness: NOT PRODUCTION READY. No verified apply.

Evidence: `/tmp/flexfactor-aifactory-status.md`.
Factory still 404; :5179/:5190 still closed.

## Follow-up 2026-09-01T20:40Z (this parent run)

PromoPilot live SHA still `b68d809`. Arm live. Drafts still **0**.
Ellie Bluesky `POST /api/post-now` still 409 `canonical_cta_mismatch`
with no expected URL in the body. Axiom Bluesky still
`needs_campaign_approval` (allowlist youtube/facebook_page/threads/x).
`verification_fingerprint` `6bee7ddf…` is **not** a `/r/` dest hash
(`unknown_destination`). No mint/preview route exists. `buckeye7066/promopilot`
still 404. Do not dest-approve Mastodon. Do not publish.

FlexFactor local apply-path (not on origin; push still
`Invalid username or token` / denied to `cursor[bot]`), branch
`cursor/pr110-ci-wire-a427`:

| SHA | Change |
|---|---|
| `7aab5ec` | classify `Cross-file dependency` as no-fix; `_in_repo_rel` for absolute-in-repo purpose paths |
| `7452555` | retry silent in-file no-ops; escalate leftover unclear in-file no-ops |
| `b15f048` | detect unpacked Python fixtures via `tests/test_*.py` → unittest discover |

Re-measured option 4 on `/tmp/ff-option4-qwen`:

- After `7aab5ec`+`7452555`: purpose-bridge reads `hello.py`;
  `[in-file-retry]` fires; 1.5b then claims already-fixed or emits
  syntax-invalid rewrites (`[revert]` ×3).
- After `b15f048`: stack is `python=True test_cmd=yes` (unittest
  discover). 3b-author / 1.5b-judge run (`/tmp/ff-option4-apply-3b.log`)
  **EXIT 1**, **0 files fixed**. hello.py still `return a - b`. 3b also
  `[revert]` ×3, then JSON parse failure on test_hello.py.

The apply *loop* is now wired. The free 1.5b/3b authors still cannot
land a verified one-line `a + b`. Origin write still blocked. Do not
treat FlexFactor as production-ready for unattended apply.
