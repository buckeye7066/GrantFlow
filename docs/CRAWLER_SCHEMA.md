# Normalized Program Schema (Strict)

This crawler produces **strict, queryable** normalized program records for two separate tracks:

- `nf_programs_a` → **TRACK_A** (client/beneficiary)
- `nf_programs_b` → **TRACK_B** (provider/care org)

Tracks are structurally distinct and **never merged**.

## Required fields (normalized record)

Every normalized record includes:

- `program_id` (deterministic stable hash)
- `program_name`
- `funding_track`: `TRACK_A` or `TRACK_B`
- `jurisdiction`: `federal|state|county|tribal|mco|other`
- `state` (2-letter if applicable)
- `county` (nullable)
- `administering_agency` (nullable)
- `program_type`: `waiver|grant|reimbursement|benefit|subsidy|other`
- `eligible_population` (JSON array of strings)
- `covered_services` (JSON array of strings)
- `income_limits` (nullable JSON)
- `diagnosis_requirements` (nullable JSON)
- `age_requirements` (nullable JSON)
- `provider_requirements` (TRACK_B only; nullable JSON; **must be NULL in TRACK_A**)
- `funding_amounts` (nullable JSON)
- `renewal_cycle` (nullable)
- `application_method` (nullable)
- `application_url` (nullable)
- `source_url` (canonical)
- `source_last_crawled_at`
- `last_verified`
- `confidence_score` (0–1)
- `change_log` (JSON array of version pointers/diffs)
- `raw_source_refs` (JSON array of `{ url, hash }`)

## Versioning + changes

Each normalized record has version snapshots in:

- `nf_program_versions`

Key fields:

- `version_id`
- `crawl_run_id`
- `program_id`
- `funding_track`
- `content_hash` (source content hash)
- `normalized_payload` (JSON snapshot)
- `changed_fields[]`
- `change_type`: `created|updated|unchanged|discontinued|reactivated|error`
- `diff_summary`

The parent record (`nf_programs_a`/`nf_programs_b`) also stores a rolling `change_log[]` referencing version IDs.

## Evidence + runs

Operational tables used for evidence and observability:

- `crawler_sources` (what we crawl)
- `crawl_runs` (run id + counts)
- `crawl_events` (structured event log)
- `parse_failures` (structured failure log)

## Example (TRACK_A)

See the generated artifact:

- `artifacts/crawler/YYYY-MM-DD/sample_output.<crawl_run_id>.json`

This contains:

- `samples.track_a[]` and `samples.track_b[]` with real normalized rows.

