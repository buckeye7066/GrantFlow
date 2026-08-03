# Session sync — Claude Code, 2026-08-03 (owner-directed broadcast)

Audience: Cursor agent + Codex/ChatGPT ("Sol") + any future Claude session.
The owner asked for this chat to be synced to all assistants. Treat everything
here as established context; do NOT redo or contradict it.

## Owner directives issued this session (binding)

1. **Manual submission handoff**: whenever Hamilton/auto-submit cannot finish a
   submission, the profile owner MUST receive concrete instructions + links to
   finish it manually (real portal link — never invented; the prepared packet;
   named missing items; the honest "Mark submitted records / transmits
   nothing" closing step). Silent parked tasks are the failure mode.
2. **"Won't" → "figure out a way to do it properly"**: the owner rejects
   self-imposed refusal. Where automation stops for a reason a competent human
   would solve (e.g., finding the funder's real application page), the system
   must solve it — within the existing honesty gates (never fabricate, never
   bypass 2FA/CAPTCHA/terms).
3. **The verdict bar**: the owner is close to abandoning GrantFlow. The only
   measure that counts: beating a free Google search END TO END — a real
   source found + applied + submitted + confirmed, with less effort than
   manual. Lead every report with that number, never activity counts. The
   system's own Google-parity read 47.1/100 ▼ on 2026-08-03.

## Prod measurements (read-only, via railway ssh, 2026-08-03)

- Last autopilot-submitted run: **2026-07-04** (a month of zero automated
  submissions). 43 tasks `submitted` ever (most via other paths).
- **74 tasks `waiting_for_review`, 70 of them WITH auto-submit authority.**
- Dominant live stall on authorized tasks: **"No clear application URL or
  submission method"** (resolveUnknownMethod → funder-contact packet).
- The retired `not_generated` gate last fired 2026-07-30 (#1108 really fixed
  it — do NOT re-fix).
- Blockers last 14d: login 39, preflight 22, portal_unreachable 10,
  click_failed 8, captcha 5.

## Shipped this session

- **PR #1127 (MERGED + deployed)**: `/api/grants/<64-hex>` console 404s.
  Cause: Similar-Opportunities/CoverageEvidence links carry CATALOG ids
  (sha256 `deterministicOpportunityId`) into GrantDetail, which fetched the
  pipeline-grants endpoint. GrantDetail now branches on id shape and renders a
  read-only catalog view (add-to-pipeline via gated from-opportunity).
  Also fixed: `GET /api/opportunities/:id` 500'd on EVERY call (two SQL
  placeholders, one bound param) and its UUID-only gate made all
  crawler-minted rows unreachable (now accepts 64-hex).
- **PR #1128 (OPEN, checks running)**: (a) runtime URL rescue in
  `hamiltonHardStopResolver.resolveUnknownMethod` — before degrading, Hamilton
  searches for the funder's real application page (boot-sweep finder:
  search → token plausibility → liveness, PLUS the #1113 tenant-slug funder
  screen and a same-page loop guard); a verified find redirects the run and
  persists on the task. (b) `manualSubmissionGuide.js` — pure, total-over-
  statuses finish-it-yourself step builder, wired into needs_you / Action
  Plan / HamiltonWorkPanel. (c) `ready_to_print_mail|email|fax` re-bucketed
  from "working on" to needs-you (enumerated; `ready_to_start` is the active
  queue and stays out).

## In flight (do not collide)

- **Agent A (main tree)**: Anya daily-report remediation — SermonSmith EVA
  probe port (3001 vs 3101), CRISPR Compass hidden-body journeys, LiveHealth/
  Incognito/Castle Clash journey selectors, GeneMap /Login 401s, Docker
  Desktop at login, GrantFlow amount_adapter for high_school_student +
  Amy synthetic-TTL leak. It has UNCOMMITTED WIP in the MAIN GrantFlow tree
  (awardAmountExtractor, amy files, qa/manifests, eva-edge-runner) — do not
  commit or revert files you did not change.
- **Agent B (isolated worktree, branch `fix/qa-36-profile-junk`)**: the
  owner's 36-profile QA remediation — P0: Federal-Register/regulatory-notice
  junk classifier + fundability gate; country/state jurisdiction fixes
  (Tata-Trusts-TN, LA-Flex-UK); eligibility-first scoring gates (church at
  100% for Feral Swine = a path where gates never ran); applicant-type
  filtering (CDBG/ESG/EDA never "apply now" for individuals). P1: dedup
  (double LIHEAP), HTML-entity hygiene, lead-gen denylist, item-scanner
  profile-reset + input-concat bugs, cold-start baseline, test-profile
  exclusion. Deliverables include a shared
  `is_fundable_opportunity()/passes_eligibility()/is_relevant_geo()` chain
  used by BOTH crawler results and item scanner, plus a per-profile
  junk-diff report and regression tests on the exact bad records.

## Standing traps for all agents (from this session)

- GrantFlow main is branch-protected; ship via PR with the 4 binding checks.
- The match store (`profile_opportunity_matches`) is a ROLLING SNAPSHOT;
  gates must live at choke points (matchEngine.makeDecision, writer gates,
  enforceInvariants boot nets) — per-path fixes are how the owner's junk
  survived a year. Enforce at ONE gate everything passes through.
- Read ~/GrantFlow/CLAUDE.md before touching matching/portal/submission code;
  many gates already exist — find why a surface evades them, don't duplicate.
