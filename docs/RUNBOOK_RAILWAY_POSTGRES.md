## GrantFlow — Railway Postgres Runbook

This runbook covers provisioning, migrating, verifying, and rolling back the GrantFlow database cutover from SQLite to Postgres on Railway.

### Goals

- **Stable production storage** (no ephemeral SQLite surprises)
- **Deterministic schema** via migrations
- **Safe cutover** with a clear rollback path

---

## Environment Variables (Railway)

### Required for Postgres mode

- **`DB_PROVIDER`**: `postgres`
- **`DATABASE_URL`**: Railway Postgres internal URL (works from Railway runtime)
- **`DATABASE_PUBLIC_URL`**: Public URL (useful for running migrations from your laptop/CI)

### SQLite variables (only for rollback / local)

- **`DB_PROVIDER`**: `sqlite`
- **`SQLITE_DB_PATH`**: path to SQLite DB file (example: `backend/data/grantflow.db`)

---

## Phase A — Apply Postgres Schema (Deterministic)

### 1) Run Postgres migrations

Run migrations against the target Postgres:

```bash
DB_PROVIDER=postgres DATABASE_URL="<your postgres url>" npm run migrate
```

Expected: migration runner reports `Dialect: postgres` and completes with `✓ All migrations applied successfully`.

### 2) Sanity check

Call the backend readiness endpoint:

```bash
curl -sS https://<your-railway-backend>/readyz
```

Expected:
- **HTTP 200** (or 503 if DB/schema/secrets/uploads are not ready)
- JSON includes **`status: "ready"`**
- JSON includes **`dialect: "postgres"`**

---

## Phase B — One-time SQLite → Postgres Data Migration (Optional)

If you want to keep existing data from SQLite, use the migration script.

### Preconditions

- Postgres migrations already applied (tables exist).
- Prefer doing this once, from a controlled environment (your machine or CI).
- Use **`DATABASE_PUBLIC_URL`** if running from outside Railway.

### 1) Dry run (recommended)

```bash
npm run migrate:data -- --dry-run --postgres "<DATABASE_PUBLIC_URL>"
```

Expected:
- Script inserts inside a transaction
- Prints verification row counts
- Ends with `Dry run complete (rolled back).`

### 2) Real migration (commit)

```bash
npm run migrate:data -- --postgres "<DATABASE_PUBLIC_URL>"
```

By default the script:
- **asserts Postgres is fresh/empty**
- **verifies per-table row counts match**
- **rolls back and exits non-zero** on mismatch

### Script flags

- **`--assert-fresh false`**: allow migrating into a non-empty Postgres (not recommended)
- **`--verify-counts false`**: skip row-count verification (not recommended)
- **`--batch <n>`**: tune insert batch size (default 300)

---

## Phase C — Cutover

1. Ensure Railway backend service has:
   - `DB_PROVIDER=postgres`
   - `DATABASE_URL=<internal railway postgres url>`
2. Deploy the backend.
3. Verify core flows:
   - Login works
   - Profiles load
   - Opportunities list returns data
   - Crawlers/jobs can start and report status

---

## Rollback (Fast)

If Postgres has an incident and you must restore service quickly:

1. Set Railway variables:
   - `DB_PROVIDER=sqlite`
   - `SQLITE_DB_PATH=<path to sqlite file used by the service>`
2. Redeploy.

Notes:
- If your SQLite DB was on an ephemeral filesystem, rollback may restore the **schema** but not your latest data.
- Prefer Postgres long-term to avoid this class of outage.

---

## Known Risks / Notes

- Postgres migrations are **strict**: any error must be fixed (no “record as applied” behavior).
- OpenAI outages should no longer break the API: AI routes fall back or return 503 with `request_id` for correlation.
