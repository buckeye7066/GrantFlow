# GrantFlow production audit bridge

A read-only audit of live production that runs in GitHub Actions and publishes a
sanitized artifact. It exists so a reviewer working through the connected GitHub
repository — with no Railway access, no local `.env`, and no database
credentials — can still obtain evidence about production behavior.

Everything here is designed around one assumption: **the artifact is the only
output, and it may be read by someone who cannot verify anything else.** So the
artifact must be both useful and provably free of credential material.

## Running it

Actions → `production-audit` → *Run workflow*.

| Input | Meaning |
| --- | --- |
| `profile_ids` | Comma-separated production profile IDs to audit |
| `portal_hosts` | Comma-separated portal hosts; only used when portal reads are on |
| `run_portal_reads` | Perform READ-ONLY Hamilton portal syncs (default `false`) |
| `include_screenshots` | Capture sanitized screenshots (default `true`) |

Start with `run_portal_reads=false`. Only enable it for portals that already
have a captured Hamilton session — the lane reports `needs_session` honestly
rather than trying to establish one.

## The safety model

The audit is not trusted to behave; it is *prevented* from misbehaving, and each
prevention is proven in the same run.

**Database.** Connects only as `grantflow_auditor` — a scoped, non-superuser,
expiring role with `SELECT` on a fixed table list. The session sets
`default_transaction_read_only`, `statement_timeout = 30s`, and work happens
inside a `BEGIN TRANSACTION READ ONLY`. There is **no connection-string
fallback**: `GRANTFLOW_PROD_AUDIT_DATABASE_URL` is mandatory and a missing value
is a hard failure. (The local kit this evolved from fell back to the Railway CLI
and silently ran as superuser — which made its containment tests meaningless.)

**Proof, not assertion.** The guard step attempts a real `CREATE TEMP TABLE` and
a real `INSERT`, and demands `25006` or `42501`. It then attempts to read every
sensitive table — `users`, `user_credentials`, `user_sessions`,
`password_setup_tokens`, `app_runtime_secrets`, `hamilton_portal_credentials`,
`hamilton_portal_master_vault`, `tailored_applications`, and others — and demands
`42501` for each. Sensitive tables are not merely un-queried; the database is
shown to refuse them.

**Sessions.** Portal session lifecycle is read through
`audit.hamilton_saved_sessions`, a view exposing *whether* state exists and when
it was used. The ciphertext column and both retrieval pointers are withheld at
the database level, and the guard proves the base table is denied.

**Submission authority.** The lanes refuse to run unless the process posture is
provably current and reports that Hamilton's irreversible submit action is
authorized per profile. The audit checks two independent facts:

1. `system_kv.automation_posture` reports
   `submission_authority: "profile_authorization"` and
   `profile_authorization_required: true`; and
2. the posture `boot_id` equals the `bootId` from the live
   `GET /api/health/deployment`.

Without (2), the row could be stale. "Cannot verify" aborts the read-only audit
before the authenticated browser lane opens. The posture contains no profile
consent or secrets.

**Network.** The application lane denies mutation by default at the Playwright
route layer. `GET`/`HEAD`/`OPTIONS` pass; the login/refresh/logout routes are
allowlisted because nothing is visible without a session; everything else that
mutates is aborted and recorded. `POST /api/hamilton/portal-sync/read` is the
single conditional exception, permitted only when the operator explicitly named
both a profile and a host. `/portal-sync/write` and `/portal-sync/sync`
(direction `both`) are **absent from the allowlist entirely** — not conditionally
allowed, unreachable.

No `storageState` is written or exported, no password is logged, and no raw HTML
is captured (hidden inputs carry CSRF tokens).

## Files

| File | Role |
| --- | --- |
| `db-audit.mjs` | Containment guard, auto-submit gate, and 17 database findings |
| `app-audit.mjs` | Authenticated Playwright lane and the mutation policy |
| `policy.test.mjs` | Proves the mutation policy offline, before a browser exists |
| `redact.mjs` | Outbound redaction + fail-closed secret detection, with self-test |
| `validate-artifact.mjs` | Composes the report, then enforces the artifact contract |

## The artifact contract

`grantflow-production-audit` contains exactly:

```
audit-summary.json
database-findings.json
application-findings.json
portal-findings.json
amy-findings.json
report.md
screenshots/*.png
```

Anything else fails the upload. Before publishing, the validator:

1. enforces that file allowlist (an unexpected file is a hard failure);
2. verifies each `.png` really is a PNG by magic bytes — a text file renamed
   `.png` would otherwise skip the content scan;
3. scans every text byte for connection URIs, JWTs, PEM private-key blocks,
   `Authorization`/`Bearer` values, cookie headers, and sensitive keys bound to
   credential-shaped values;
4. fails closed on anything unreadable or missing.

### Why the scan is context-sensitive

An honest audit report contains sentences like *"the password field was not
accessed"*. A validator that failed on the bare word `password` would fail every
truthful report, and the predictable response is to weaken it until it passes —
at which point it protects nothing.

So bare keywords are **not** findings. A keyword is a finding when it appears as
a **key bound to a credential-shaped value** (`"password": "hunter2abc"`).
Structural secrets — connection URIs, JWTs, PEM blocks — need no context and
always fail. Redaction is also **idempotent**: `Authorization: <redacted>` must
not re-trip the detector, or no artifact could ever pass.

Both directions are self-tested:

```bash
node scripts/production-audit/redact.mjs --self-test          # planted fixtures
node scripts/production-audit/validate-artifact.mjs --self-test  # planted artifacts
node scripts/production-audit/policy.test.mjs                 # mutation policy
```

Each asserts the *allow* cases too. A deny-everything control fails closed but
produces an empty audit while looking healthy, so "clean input is accepted" is
tested as hard as "planted secrets are rejected".

## Reading the results

- A finding with **zero rows** means *this query found nothing* — not that the
  condition is absent. Errored findings are listed explicitly; they are not
  silently counted as clean.
- `unscored` (NULL match score) and `below the bar` are **different facts** and
  are reported separately. Conflating them is a documented past defect.
- Amy's synthetic training profiles (`profiles.created_by = 'agent:amy'`) are
  excluded from every count; including them measures her nightly rotation
  instead of production.

## Schema authority

Production `information_schema` / `pg_catalog`, never `backend/db/schema.sql` —
that file is a partial declaration with ~160 migrations layered on top and it
drifts in both directions. Traps already encountered and encoded here:

- `application_missing_info.resolved` and `application_tasks.allow_auto_submit`
  are `BOOLEAN` on production Postgres and `INTEGER` on the SQLite test DB.
  `= 1` raises `42883` on production — the predicate must be `IS TRUE` /
  `IS NOT TRUE`.
- `portal_sync_runs` and `profile_portal_status` use `portal_host`;
  `portal_check_results` uses `portal_name` / `portal_url` and has no
  `portal_host` column at all.
- The match store is a rolling snapshot — a missing row means "not re-found this
  run", never "never matched".

## Known accepted risk

The database connection sets `ssl: { rejectUnauthorized: false }`, matching
`backend/db/index.js`'s own production posture: Railway's managed Postgres public
endpoint serves a self-signed certificate. This is accepted only because the
path is read-only diagnostics on a scoped role. Pinning Railway's CA would be a
strict improvement and is not done here.

## Related

The local, interactive version of this kit lives in `.sol-audit/` (gitignored,
holds credentials, never committed). This package is the CI-safe subset: no
write helpers, no superuser escalation, no repair tooling.
