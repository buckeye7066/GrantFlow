# National Funding & Benefits Crawler (V2) — Architecture

This repository contains a production-oriented crawler pipeline to **discover, normalize, version, and serve** U.S. funding/benefits programs, while enforcing a **strict two-track model**:

- **TRACK_A**: client/beneficiary programs (direct-to-individual benefits/support)
- **TRACK_B**: provider/caregiver/organization programs (reimbursement, workforce, infrastructure, etc.)

Tracks are **never merged**; they can only be cross-linked.

## High-level flow

1. **Source selection (scope control)**
   - The orchestrator selects a subset of sources based on run mode:
     - `SMOKE_MODE`: tiny curated list (offline by default)
     - `STATE_MODE`: federal + one state
     - `NATIONAL_MODE`: full registry (expand incrementally)
   - Implemented in `backend/services/nationalCrawlerV2/run.js` (mode selection + filtering) and `backend/services/nationalCrawlerV2/registry.js` (registry definition).

2. **Polite fetch**
   - Per-host rate limits, retry/backoff, and timeouts.
   - **Robots-aware**: fetcher consults `robots.txt` (simplified allow/disallow evaluation).
   - Implemented via:
     - `backend/services/nationalCrawlerV2/fetchers.js` (http/file/mock fetchers)
     - `backend/services/nationalCrawlerV2/robots.js` (robots cache)
     - `backend/services/nationalPrograms/fetcher.js` (rate-limited HTTP fetcher)

3. **Parse (pluggable)**
   - Content-type driven parsing:
     - HTML → Cheerio text extraction
     - PDF → `pdf-parse`
     - DOCX → Mammoth
     - Mock payloads for controlled tests
   - Implemented in `backend/services/nationalCrawlerV2/parsers.js` (dispatch) and `backend/services/nationalPrograms/parsers/*`.

4. **Normalize into strict schema**
   - Produces strict normalized program records with deterministic IDs.
   - Enforces track invariants:
     - `TRACK_A` must never include `provider_requirements`
   - Implemented in `backend/services/nationalCrawlerV2/normalize.js`.

5. **Upsert + versioning (content-based)**
   - Writes to **separate tables**:
     - `nf_programs_a` (TRACK_A)
     - `nf_programs_b` (TRACK_B)
   - Writes a version snapshot per run in `nf_program_versions`
   - Maintains `change_log[]` pointers on the program row
   - Implemented in `backend/services/nationalCrawlerV2/store.js`.

6. **Evidence + observability**
   - Every run has a `crawl_run_id`, counts, and structured failures:
     - `crawl_runs`, `crawl_events`, `parse_failures`
   - Artifacts are written under `artifacts/crawler/YYYY-MM-DD/`:
     - `crawl.log`, `parse.log`, `normalize.log`, `api-smoke.log`
     - `sample_output.<crawl_run_id>.json`
     - `failures.<crawl_run_id>.json`
   - Implemented primarily in `backend/services/nationalCrawlerV2/run.js` and `scripts/crawler-doctor.mjs`.

## Extensibility model

- Add sources by extending `backend/services/nationalCrawlerV2/registry.js` (or generating `crawler_sources` rows).
- Add new parsing logic **by source family**, not by orchestrator branching:
  - Extend `backend/services/nationalCrawlerV2/parsers.js` and add new parser modules.
- Add state-specific rules by enriching `normalizeProgram()` with:
  - jurisdiction/state-specific post-processing modules
  - confidence scoring refinements
  - cross-linking heuristics between TRACK_A and TRACK_B

## Security / PHI posture

- No user identifiers, profiles, or PHI are stored by this crawler.
- Logs are passed through a scrubbing layer: `backend/utils/piiScrubber.js`.
- Store **hashes + URLs** as raw evidence references (`raw_source_refs[]`), not raw personal data.

