# 2026-08-21 — PR #1292 Codex review follow-up

## CHANGED

- Website purpose is now fetched through a bounded, cached reader for every
  loaded profile with a public website and persisted in `profile_sections` for
  the synchronous matcher; ordinary hosts no longer depend on the Axiom
  registry.
- Biomedical shared-instrumentation and shared-facility equipment titles are no
  longer treated as proof of an unrelated purpose.
- The stage/purpose boot invariant now replays the combined conflict authority
  across persisted matches and cancels nonterminal Hamilton tasks for conflicts.
- Expired Amy synthetics with a failed teaching handoff receive a 96-hour
  terminal cleanup escape hatch instead of surviving forever.
- First-time agreement acceptance records the authenticated accepter; repeat
  acceptance is rejected so the original identity, timestamp, IP, and user
  agent remain immutable.
- `interpret-intent` uses its own 40-per-10-minute, required-shared cost bucket.
- The website-purpose reader now uses the socket-pinned shared `safeFetch`
  choke point, including DNS/private-address checks and redirect revalidation.
  Linked organization website/mission data is loaded before enrichment.
- Stage/purpose reconciliation includes legacy grant-only Hamilton tasks and
  retains each match when its task lookup or cancellation fails, allowing the
  next boot sweep to retry safely.

## VERIFIED

- Focused Vitest coverage passed locally for website-purpose matching and
  enrichment, persisted match reconciliation, agreement acceptance, Amy
  lifecycle cleanup, and API rate-policy classification.
- Focused ESLint passed for all changed JavaScript files.
- Follow-up Vitest coverage passed for private/loopback website refusal,
  organization-backed websites, immutable repeat agreement acceptance,
  grant-only task cancellation, and failed-reconciliation match retention.

## UNKNOWN

- No live production profile crawl/match/task counts were measured in this
  sandbox. The end-to-end number after deployment remains unknown.
- Remote GitHub Actions status was not used as evidence for this follow-up.
