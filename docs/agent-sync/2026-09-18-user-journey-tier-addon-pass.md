# User journey, tier, and add-on verification pass

## Outcome bar

No real funding application was submitted in this pass. The submission checks
used GrantFlow's synthetic Hamilton browser fixtures; they prove the guarded
software path, not an external funder's receipt. No production client record,
payment, provider credit, or portal was changed.

## CHANGED

- The Playwright E2E server now builds the SPA with the same `/grantflow`
  basename used by its browser journeys. Previously sign-in succeeded, but the
  next authenticated route rendered `Page not found` because the built router
  used `/` while the test navigated below `/grantflow`.
- The browser journeys now follow the current product contracts: the
  Organizations heading, type-free Quick Add flow, password-setup onboarding,
  required profile-completion gate, and a named deterministic discovery
  fixture instead of whichever profile happened to sort first.

## VERIFIED

- The focused billing and Hamilton suites passed all 56 assertions. Coverage
  included all seven catalog tiers, seat selection, universal entitlement,
  entitlement authority, and autonomous synthetic submission.
- Nine source-contract checks passed for tier and add-on independence,
  fail-closed payment/status behavior, server-authoritative UI decisions, and
  Hamilton's canonical pipeline-automation mount.
- After the basename correction, the existing login → authenticated routes →
  Anya persistence → logout browser journey passed.

## UNKNOWN / blocked evidence

- A complete browser pass remains unverified. The broad admin journey reached
  discovery but the disposable environment returned zero displayed results
  after three canonical candidates (`SUPPRESSION DETECTED`). This pass did not
  weaken relevance or eligibility policy to manufacture a green result.
- The updated anonymous signup journey passed from the interview through
  password setup, authenticated Dashboard, and the required profile-completion
  dialog after a refresh.
- Obsidian reporting is unavailable in this container: `npm run memory:health`
  reports that the configured Windows AI Bus path does not exist. This checked-
  in brief is the durable fallback; it must be forwarded to the Obsidian AI Bus
  when the bridge or vault is available.
- GitHub CLI authentication is unavailable (`gh api user` requests login), so
  push, PR creation, required-check observation, and guarded merge cannot be
  claimed from this container.

## Environment findings

- The repository requires Node 24. The container default is Node 20, which
  crashes on `undici@8`; verification therefore used `node@24`. The native
  `better-sqlite3` module was rebuilt for Node 24 and Playwright's Chromium plus
  Linux libraries were installed locally. These are environment repairs, not
  repository changes.
