# PLAN v2 — Consented portal-credential storage + autonomous re-sign-in
# (round 2: addresses Sol NO-GO critique in full)

Owner decision (2026-07-20): opt-in UNCHECKED box at side-by-side completion;
unchecked = today's storage behavior verbatim; checked = encrypted credential
with recorded consent. Round-2 resolves Sol's 10 blockers. Two policy rulings
baked in (owner may revise explicitly, never implicitly):

- **StudentAid stays MANUAL-ONLY.** The portal-policy registry deliberately
  sets `automation_allowed:false` / "Hamilton never types an FSA ID" — that is
  a legal/ToS posture, not an oversight. This plan does NOT change it: no
  autonomous password login for studentaid.gov (or any registry manual-only
  host). Keep-alive continues maintaining its captured cookie sessions only.
  Lifting this requires an explicit owner decision recorded in the registry.
- **PR 3.0 ships FIRST (pre-fix, security-critical, benefits every existing
  flow):** the autopilot engine treats password-field disappearance as login
  success and its finally-block captures storage state even when the run ends
  on a 2FA/CAPTCHA gate — an intermediate challenge page can be imported as a
  "valid" session. Fix: session capture/import requires authenticated-
  destination proof AND is prohibited whenever the final engine state is any
  auth blocker. Tests assert importSession/storageState are untouched on
  2FA/CAPTCHA/wall finals.

## Storage model (B2/B3/B4 — no pretending saveCredential already does this)
- New explicit capture path `saveCapturedCredential(db, {...})` in the
  credential service: REQUIRES master-wrap — capture completes the wrap using
  the profile vault's unlocked key (capture UI prompts unlock if locked; no
  silent fallback to server-only AES for user-typed passwords).
- Guarded migration adds `credential_metadata` JSON column; consent recorded
  as {consented_at, capture_id, ui_copy_version, actor_user_id, actor_role} —
  ALL server-stamped; client-supplied consent metadata is rejected.
- `managed_by` allowlist gains first-class `user_capture_optin` (no silent
  normalization to 'user').
- Updating an existing (e.g. auto-provisioned) row via consented capture
  CLEARS pending_registration and stale wrapped-secret fields atomically with
  the new ciphertext — decrypt-order can never prefer a stale secret (B7).
- **autonomous_unlock disclosure (B3):** if the profile lacks autonomous
  unlock, the opt-in UI shows the second consent inline: "let Hamilton use it
  even after restarts (stores an escrow key)" — separate checkbox, separate
  recorded consent; without it, copy says "usable while your vault is
  unlocked" (honest restart semantics).

## Account/session binding (B6)
- Session rows gain `credential_id` (guarded migration). A consented capture
  binds the imported session to the saved credential. The keep-alive re-login
  rung uses ONLY the session's bound credential — never the first-host-match
  lookup. Two-students-one-host is therefore structurally safe.

## Capture completion semantics (B5/B9/B10)
- Precise promise wording: keystrokes already transit the relay (transport);
  the promise is about PERSISTENCE. UI copy updated: "we never STORE your
  password or 2FA codes" for unchecked; docs note the relay explicitly.
  Unchecked behavior identical in persistence terms; the request shape only
  changes when `save_login` is present.
- Ordering: vault write happens BEFORE the live session is consumed; response
  reports {session_saved, credential_saved} independently; a vault failure
  leaves the capture retryable (never consume-then-400). Idempotent retry by
  capture_id.
- AuthZ: consent requires the acting user to be the profile OWNER, or an
  admin with `actor_role:'admin'` server-stamped (visible in the credential's
  consent record); `capture_id` mandatory and must belong to this profile.
  Tests cover the full actor-role matrix (owner / household member / admin /
  outsider).

## Keep-alive re-login rung (advisories 1-5)
- Eligibility: session expired via auth challenge AND session has a bound
  `credential_id` whose consent record exists AND host is NOT registry
  manual-only. Admin/auto-provisioned credentials are NOT eligible for this
  rung (consent provenance must be user_capture_optin).
- Separate budget: `KEEPALIVE_LOGIN_BUDGET` (default 1 login/run) with its own
  timeout, so probes are never starved; fewest-attempts-first ordering.
- Failure quarantine: after 2 failed autonomous logins the credential is
  marked `autonomous_disabled` + one notification (prevents lockouts + spam);
  cleared on the next successful manual capture.
- SSO/IdP origins: per-portal `identity_provider_domains` allowlist in the
  policy registry (e.g. MTSU → its SSO IdP); the engine's live-origin check
  consults it instead of being weakened (advisory 4).
- Revocation semantics: deleting a credential ALSO revokes sessions bound to
  it (credential_id link makes this enumerable); copy says exactly that.
- Frontend secret handling: password input type, autocomplete off, no session
  replay capture on that route, state cleared on unmount, and a canary-string
  end-to-end test asserting the password never appears in logger/console/
  telemetry spies or persisted rows outside the vault ciphertext (advisory 6,
  and Sol's test-3 critique — spies, not DB scans).

## Tests (rewritten per Sol's vacuousness findings)
1. PR 3.0: engine final=2FA/CAPTCHA/wall → importSession + storageState
   provably untouched (spies); final=authenticated (destination proof) →
   captured. Fails on current engine.
2. Unchecked completion: paired positive/negative through the REAL route —
   without save_login: zero vault calls (spy) AND session import unchanged;
   with save_login+consent: capture → simulate restart (clear runtime key) →
   authorized unlock → decrypt returns the EXACT password (round-trip, not a
   row-existence check).
3. Consented update of a pending/auto-provisioned row: pending_registration
   cleared, old wrapped secret unrecoverable, decrypt returns the new password.
4. Missing `consent:true` INSIDE a present save_login → 400 and capture still
   retryable; absent save_login entirely → success, unchanged (both asserted).
5. Keep-alive rung: real engine gate-detection fixture (not orchestration
   mocks) — bound-credential login with authenticated destination → new
   session row encrypted + bound; unbound session with host-matching vault
   credential → NOT attempted; manual-only host → NOT attempted; quarantine
   after 2 failures.
6. AuthZ matrix: owner ok; admin ok with actor_role='admin' stamped; household
   non-owner and outsider rejected; client-supplied consent metadata ignored/
   rejected.
7. Vault-locked at capture: flow prompts unlock; declining stores NOTHING and
   says so (no silent server-AES fallback).

## Sequencing
PR 3.0 (engine capture honesty) → PR 3.1 (storage model + migrations + capture
API) → PR 3.2 (opt-in UI) → PR 3.3 (keep-alive rung + quarantine + registry
IdP allowlist). Each PR independently safe; 3.3 is flag-gated
(`HAMILTON_AUTONOMOUS_RELOGIN`, default OFF for one canary cycle).

## ROUND-3 AMENDMENTS (resolving Sol's remaining blockers)

**A-B3 (autonomous-unlock consent has a real store).** New server-written-only
table `hamilton_consent_events (id, profile_id, credential_id NULL, kind CHECK
IN ('credential_capture','autonomous_unlock','autonomous_relogin_enable'),
actor_user_id, actor_role, ui_copy_version, capture_id NULL, created_at)` —
one guarded migration, append-only, no client-supplied fields. Enabling
autonomous unlock (escrow) REQUIRES writing an `autonomous_unlock` event in
the same transaction; the keep-alive re-login rung verifies BOTH events
(capture consent for the credential AND autonomous_unlock for the profile)
before any unattended use. `credential_metadata` keeps a denormalized copy for
display; the event table is the audit truth.

**A-PR3.0 (authenticated-destination proof, concrete).** Session capture/
import is permitted ONLY when ALL hold at final state: (1) the final URL's
registrable domain is the portal host or a registry-listed IdP for it, AND the
URL path does not match login/challenge patterns; (2) the classifier read of
the final page yields NONE of login_required/sso_required/two_factor_required/
captcha_required/portal_anti_bot_block; (3) at least one positive
authenticated marker is present (sign-out/log-out affordance, account-identity
element, or a per-portal adapter marker); (4) the engine's final result
carries NO blocker. Password-field disappearance alone proves nothing. Tests:
each condition independently falsified → no capture (spy on storageState +
importSession).

**A-retry-safe capture.** The completion flow persists the consented payload
FIRST: `pending_capture_credentials` row keyed by capture_id — password
encrypted with the runtime secret, TTL 15 min, deleted on success or expiry
(sweeper) — BEFORE the live session is consumed. Completion then runs:
(1) saveCapturedCredential (master-wrap; clears pending_registration,
verification_status/attempts/next_retry_at, and stale wrapped fields in ONE
atomic update); (2) session import bound to credential_id; (3) consume live
session; (4) delete pending row. A failure at any step leaves the pending row
re-completable within TTL (idempotent by capture_id); the response reports
{session_saved, credential_saved, retryable}. The pending row is the ONLY
place plaintext-equivalent material exists outside the vault, it is encrypted
at rest, and its sweeper + TTL are tested.

**A-collection-consent (keep-alive credential selection).** The rung loads
credentials ONLY via new `getCredentialForAutonomousRelogin(db, {sessionId})`:
resolves the session's bound credential_id → verifies managed_by =
'user_capture_optin' → verifies both consent events → verifies not
quarantined/pending. Any missing link = not attempted (recorded reason). The
generic first-host-match `getDecryptedCredential` is never called from the
rung (static tripwire test).

**A-session-binding semantics.** Consented-capture session imports upsert by
(profile_id, portal_host, credential_id) — a second student's capture on the
same host creates a SECOND session row, never overwrites the first. Deleting a
credential revokes its bound sessions (enumerable via credential_id).

## ROUND-4 AMENDMENTS (Sol's two remaining NO-GO items)

**A4-PR3.0 (authenticated-proof source for NON-cloud imports).** The 4-condition
proof (A-PR3.0) is trivially available for the cloud-login flow (the engine
holds the final page). It is NOT available for `POST /sessions/import` from the
laptop connector (`tools/laptop-connector/capture.js`) and the local capture
tool (`tools/hamilton-session-capture/capture.mjs`), which today upload only
`storage_state`. Resolution — the consent gate is orthogonal to the proof:
  - `/sessions/import` KEEPS working exactly as today for the cookies-only
    path (no consent, no credential binding) — unchanged, no proof required,
    because that path never enables autonomous PASSWORD re-login (the risk
    A-PR3.0 guards). It only re-imports a session the human established.
  - The autonomous-relogin rung (PR 3.3) requires a BOUND CREDENTIAL with
    user_capture_optin consent AND both consent events. A connector/local
    import carries neither, so it can NEVER trigger autonomous password login —
    the proof requirement applies only where the engine itself performed the
    login (cloud flow + the keep-alive rung), and BOTH of those have the final
    page in hand. So the capture TOOLS need NO change: they produce cookies-only
    sessions that are autonomous-relogin-ineligible by construction. Add an
    explicit test asserting a connector-imported session (no credential_id) is
    refused by the rung.

**A4-session-binding (reconcile with the existing credential-move path).**
`moveManagedCredential` (service :419) + admin move route (:1526) DO exist and
move a credential's `profile_id`. A move would strand the credential's consent
provenance and any sessions bound to it under the old profile. Resolution:
`moveManagedCredential` is EXTENDED, not removed — on move it (1) revokes every
session bound to that credential_id (same revocation used on delete), and
(2) clears `user_capture_optin` provenance + the consent-event links, demoting
the moved credential to a plain admin-managed credential that is
autonomous-relogin-INELIGIBLE until re-captured with consent under the new
profile. The admin route surfaces this in its response ("moved; re-capture
consent to re-enable autonomous sign-in"). Test: move a consented credential →
bound sessions revoked, provenance demoted, rung refuses it.

## ROUND-5 REVIEW (2026-07-21) — Sol NO-GO(2)

Code verification performed before the review (all round-4 citations are
ACCURATE): `moveManagedCredential` at
`backend/services/hamilton/hamiltonPortalCredentialService.js:419` (moves
`profile_id` at :438-440; refuses non-admin rows at :424 `not_admin_managed`;
merge-on-clash branch at :433-436 raw-DELETEs the source row); admin move
route `POST /admin/credentials/:id/move` at
`backend/routes/hamiltonAutomation.js:1526`; `POST /sessions/import` at
`backend/routes/hamiltonAutomation.js:857`; both capture tools upload only
`storage_state` (`tools/laptop-connector/capture.js:100`,
`tools/hamilton-session-capture/capture.mjs:98,:111`); the PR 3.0 target bug
is real — `hamiltonAutopilotEngine.js:400-401` (`return !stillPassword` =
login success on password-field disappearance), `:652` sets `loggedIn`, and
the `finally` block at `:861-869` captures `context.storageState()` whenever
`loggedIn` is set, regardless of a 2FA/CAPTCHA final.

Sol verdict line (verbatim): `VERDICT: NO-GO(2)`

**ROUND-5 AMENDMENT A5-1 (import honesty for the manual/connector path —
closes Sol finding 1).** Sol: A4-PR3.0's "no proof required" exemption for
`/sessions/import` contradicts the governing rule ("session capture/import
requires authenticated-destination proof") — a human can capture a
2FA/CAPTCHA interstitial and have it imported as a valid session; rung
ineligibility does not make the IMPORT honest. Resolution — the proof source
EXISTS on the client: both capture tools are Playwright-driven and hold the
final page at capture time, so the proof moves to where the page is:
  - `tools/laptop-connector/capture.js` and
    `tools/hamilton-session-capture/capture.mjs` are extended to send
    `final_url` plus a local proof block alongside `storage_state`: the SAME
    condition set as A-PR3.0 evaluated client-side — URL registrable-domain +
    path-not-login/challenge (condition 1) and a positive authenticated
    marker scan (condition 3). Cheap, no new deps (the tools already drive
    the page).
  - `/sessions/import` server-side re-validates what it can without the page:
    condition 1 against the reported `final_url` (registrable domain is the
    portal host or a registry-listed IdP; path does not match
    login/challenge patterns). A missing/failing proof does NOT hard-reject
    (old tool versions keep working) — the session is imported flagged
    `verification: 'unproven'`.
  - An `unproven` session is NOT trusted until the keep-alive PROBE (which
    loads the portal with the session and classifies the page — the server
    holds a real page there) positively classifies it authenticated; the
    probe result upgrades `verification` to `'probe_verified'` or marks the
    session expired. Runs may not consume an `unproven` session before its
    first verifying probe. This gives the manual path the same
    authenticated-destination proof, sourced from the two places a real page
    exists (capture client, server probe), with zero breakage of today's
    tools. Tests: interstitial-shaped final_url → imported-as-unproven +
    not consumable; probe against a 2FA page → expired, never upgraded;
    old-tool payload (no proof block) → unproven path, still importable.

**ROUND-5 AMENDMENT A5-2 (append-only provenance revocation — closes Sol
finding 2).** Sol: A4's "clears ... the consent-event links" contradicts
A-B3's append-only `hamilton_consent_events`, and demoting `managed_by`
alone leaves the old capture event visible to later consent checks; no
revocation/move kind exists in the CHECK. Resolution — never UPDATE/DELETE an
audit event; revoke by APPENDING:
  - The `kind` CHECK gains `'consent_revoked'` (reason field carries
    `credential_moved` | `credential_deleted` | `owner_request`). A move
    appends one `consent_revoked` event per affected consent, carrying the
    credential_id and the OLD profile_id, in the SAME transaction as
    (1) the `profile_id` update, (2) bound-session revocation, and
    (3) `managed_by` demotion — one transaction covering all four, per Sol.
  - Consent verification (`getCredentialForAutonomousRelogin` and the escrow
    check) becomes LATEST-STATE: a `credential_capture` event authorizes only
    if (a) no later `consent_revoked` event exists for that credential_id,
    AND (b) the event's profile_id equals the credential's CURRENT
    profile_id (so even a missed revocation event cannot let a moved
    credential ride its old profile's consent). (b) is the structural
    backstop; (a) is the audit trail.
  - The merge-on-clash branch of `moveManagedCredential` (service :433-436,
    which raw-DELETEs the source row) gets the SAME treatment as delete:
    revoke the source credential's bound sessions + append `consent_revoked`
    before the DELETE. Note: today's guard at :424 refuses non-admin rows;
    the extension must decide `user_capture_optin` movability explicitly —
    plan rules it MOVABLE by admins, with demotion (above) as the price.
  - Tests: move → old capture event still present (append-only asserted),
    new `consent_revoked` present, rung refuses via BOTH (a) and (b)
    independently (each falsified separately); merge-branch move revokes
    sessions; transaction rollback leaves no partial state.

STATUS: round-6 confirm needed.

## ROUND-6 CONFIRMATION (2026-07-21) — Sol NO-GO(1)

Citation-consistency re-check (spot-verified, no drift): `moveManagedCredential`
at `hamiltonPortalCredentialService.js:419`, `not_admin_managed` guard at :424,
merge-on-clash raw-DELETE at :433-436, `profile_id` UPDATE at :438-440;
`/sessions/import` router.post at `hamiltonAutomation.js:857` (already attaches a
consent record — compatible with A5-1's added `verification` flag); admin move
route `/admin/credentials/:id/move` at :1526; autopilot finally-block captures
`storageState` when `loggedIn` at `hamiltonAutopilotEngine.js:861-869`;
`hamiltonSessionKeepAlive.js` exists. A5-1/A5-2 cite nothing that contradicts
real code.

**Sol result:** A5-2 CLOSES finding 2 (append-only preserved — "never
UPDATE/DELETE"; `consent_revoked` appended; current-`profile_id` structural
backstop; move+revoke+demote+session-revocation transactional; merge-on-clash
covered). A5-1 does NOT fully close finding 1.

Sol verdict line (verbatim): `VERDICT: NO-GO(1)`

Sol finding 1 (verbatim): "A5-1 does not fully close finding 1. A-PR3.0 permits
import only when 'ALL' four conditions hold, including final-page classification
and 'NO blocker.' A5-1's client proof implements only conditions 1 and 3, while
the server re-validates only condition 1. Therefore, a 2FA/CAPTCHA page at an
allowed, non-challenge-looking URL — especially one retaining an account marker
— can pass as proven and become consumable without the verifying probe. The
client-supplied marker assertion is also not independently verifiable by the
server. All connector imports must remain `unproven` until a server probe
verifies conditions 1-4, or the plan must add a trustworthy mechanism covering
conditions 2 and 4."

**ROUND-6 AMENDMENT A6-1 (the server probe is the SOLE trust authority for the
manual/connector import path — closes Sol finding 1).** Sol is right: A5-1 left
an implicit "passing client proof → consumable" path, and the client can only
attest conditions 1+3 while the server re-validates only condition 1 — none of
conditions 2 (final-page classifier shows no login/sso/2FA/captcha/anti-bot) or
4 (engine result carries no blocker) are checked for the manual path, and a
client-supplied marker is not server-verifiable. A 2FA interstitial served at a
clean, non-challenge URL that still renders an account chrome element would sail
through. Resolution — make the sound mechanism the plan already has (the server
probe, which loads the portal with the session and classifies a REAL page,
covering conditions 2 and 4) the ONLY thing that can grant trust:
  - EVERY session from `/sessions/import` (connector, local tool, old or new)
    is stored `verification: 'unproven'` and is NON-CONSUMABLE until its first
    server probe verifies conditions 1-4 (registrable-domain + non-challenge
    path + classifier-clean + positive authenticated marker read server-side
    off the real page) and upgrades it to `'probe_verified'`; a probe that sees
    any challenge/blocker marks it expired and NEVER upgrades. The client proof
    block is ADVISORY-ONLY: it may only DOWNGRADE (e.g. a client-reported
    challenge URL is stored expired without wasting a probe) — it can never by
    itself make a session consumable. This deletes the "missing/failing proof →
    unproven; passing proof → trusted" asymmetry that carried the hole.
  - The cloud-login flow is unaffected: there the ENGINE holds the final page,
    so all four A-PR3.0 conditions are evaluated at capture against a real page
    (not a client attestation), and that path may mint a proven session
    directly as before.
  - Tests: a passing client proof block does NOT make a session consumable
    before its first server probe; a 2FA page at a clean URL with a lingering
    account marker → probe classifies challenge → expired, never `probe_verified`;
    old-tool payload (no proof block) → unproven, still importable, consumable
    only after a verifying probe.

**Recurrence note (honest):** this is the SAME CLASS as round-5 finding 1
(trusting an import proof that cannot distinguish a 2FA interstitial from an
authenticated destination). It is a PLAN GAP, not a design impossibility — and
it is CONVERGING: round 5 exempted the path entirely; A5-1 narrowed the gap to
"client attests 1+3, server checks 1"; A6-1 removes the last unsound trust
grant by making the server probe (which genuinely observes conditions 2+4 on a
real page) the sole authority. The sound mechanism already exists in the plan;
A5-1 merely wired it as one of two trust sources instead of the only one. No
owner adjudication required — the fix is mechanical.

STATUS: round-7 confirm needed — one residual finding (A6-1) on the manual-import
trust boundary; A5-2 (append-only revocation) CONFIRMED closed by Sol.

## ROUND-7 CONFIRMATION (2026-07-21) — Sol CONFIRMED GO

Sol verdict line (verbatim): `VERDICT: CONFIRMED GO`

Sol's key statements (verbatim): "A6-1 closes the Round-6 finding:
- Every `/sessions/import` session is unproven and non-consumable regardless
  of client proof.
- Only a server-observed page satisfying all four conditions can upgrade it.
- Client assertions are downgrade-only and cannot grant trust.
- Cloud-login's existing server-side engine proof remains unchanged.

No new trust-boundary gap is introduced."

All findings across rounds 5-6 are now closed: A5-2 (append-only
`consent_revoked` revocation, transactional move+revoke+demote, latest-state
consent checks with profile_id structural backstop, merge-on-clash covered)
was confirmed in round 6; A6-1 (server probe as sole trust authority for the
manual/connector import path) is confirmed here.

STATUS: BUILD-READY — build order: PR 3.0 (2FA-capture-honesty pre-fix incl.
A6-1 probe-sole-authority import verification) first, then the opt-in capture
+ keep-alive re-sign-in rung with A5-2 transactional move/revoke/demote.
