/**
 * Boot-time schema invariants for GrantFlow.
 *
 * GrantFlow accumulated 7+ inline `// ... self-heal:` blocks in
 * backend/server.js, each one a postgres-only DDL fix-up for a previous
 * production incident where a migration didn't apply on a deploy. Every
 * new schema change shipped one more inline block, and server.js drifted
 * to ~3,000 lines.
 *
 * This module collapses every BOOT-TIME schema-shape invariant into one
 * place with a uniform contract:
 *
 *   - Each step is its own exported function with its own try/catch so
 *     a single failure cannot cascade and stop the rest.
 *   - Every step is pure idempotent DDL (CREATE TABLE IF NOT EXISTS,
 *     ALTER TABLE ... IF EXISTS / IF NOT EXISTS, DROP CONSTRAINT IF
 *     EXISTS) and is safe to re-run on a fully-migrated DB.
 *   - Per-dialect logic lives inside each step (postgres vs sqlite),
 *     keeping the call site dialect-agnostic.
 *   - Each step preserves the existing log prefix from the inline
 *     blocks so production log alerts keep matching exactly.
 *
 * IMPORTANT: this module must NOT carry data-repair logic (avatar
 * rehydrate, baseline seeding, lock sweepers, etc.) — those are
 * runtime concerns and live elsewhere. Only DDL invariants here.
 *
 * Mission rule: "Zero results is a failure state, not an acceptable
 * outcome." When any of these tables/columns/CHECK lists drift,
 * crawlers/connectors/Robert/Hamilton can't write, and the user sees
 * empty Discover Grants. Fixing them on every boot is a one-line
 * insurance policy against the operator forgetting MIGRATE_ON_BOOT.
 */

import { ensureAgentSubsystemTables } from '../utils/ensureAgentSubsystemTables.js'

/**
 * Wraps a single invariant step in a try/catch that logs but never
 * throws. Returns true on success, false on caught failure.
 */
async function runStep(name, logPrefix, logger, fn) {
  try {
    await fn()
    return true
  } catch (err) {
    logger?.warn?.(`${logPrefix} ${name} self-heal failed (non-fatal):`, err?.message || err)
    return false
  }
}

/**
 * Mission Control / Agent Control Center subsystem tables.
 * Delegates to the existing per-file applier so its per-file
 * try/catch + _migrations stamping behavior is preserved.
 */
export async function ensureAgentSubsystem(db, { logger = console } = {}) {
  return runStep(
    'agent-subsystem',
    '[agent-subsystem]',
    logger,
    async () => {
      await ensureAgentSubsystemTables(db, { logger })
    },
  )
}

/**
 * funding_opportunities reality-gate columns.
 * Without these, every crawler / connector / Robert write fails with
 * `column "reality_status" ... does not exist` and Discover Grants
 * stays empty.
 */
export async function ensureFundingOpportunityRealityGate(db, { logger = console } = {}) {
  return runStep(
    'funding-schema',
    '[funding-schema]',
    logger,
    async () => {
      const { ensureFundingOpportunitySchema } = await import(
        '../utils/ensureFundingOpportunitySchema.js'
      )
      await ensureFundingOpportunitySchema(db, { logger })
    },
  )
}

/**
 * application_tasks status CHECK constraint resync.
 * The store ran this lazily on first call, but Hamilton's queue stayed
 * empty in prod long enough that the constraint stuck on the pre-087
 * status list and any new state-machine status threw
 * application_tasks_status_check.
 */
export async function ensureApplicationTaskCheck(db, { logger = console } = {}) {
  return runStep(
    'application-tasks',
    '[application-tasks]',
    logger,
    async () => {
      const { ensureApplicationTaskSchema } = await import(
        '../services/hamilton/applicationTaskStore.js'
      )
      await ensureApplicationTaskSchema(db)
    },
  )
}

/**
 * organizations.deleted_at + contact_name + contact_title columns
 * (postgres-only — sqlite handles these via the legacy ALTER loop in
 * server.js).
 *
 * Background: list/delete routes filter on organizations.deleted_at
 * (migration 0047). Yana web-crawler enrichment writes a contact
 * person (migration 094/0090). Background migrate in start.js may
 * still be running when first requests arrive; without these columns
 * /api/organizations 500s.
 */
export async function ensureOrganizationsSoftDeleteColumns(db, { logger = console } = {}) {
  if (db?.dialect !== 'postgres') return true
  return runStep(
    'organizations.deleted_at + contact columns',
    '[database]',
    logger,
    async () => {
      await db.exec('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ')
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_organizations_deleted_at ON organizations(deleted_at)',
      )
      await db.exec('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_name TEXT')
      await db.exec('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_title TEXT')
    },
  )
}

/**
 * crawler_jobs.type CHECK constraint must include every type registered
 * in crawlerDispatcher HANDLERS. When a new type is shipped, operators
 * who don't set MIGRATE_ON_BOOT see /api/crawlers/jobs 500 with PG 23514
 * until they run npm run migrate. Mirror migration 0067/0069 inline.
 *
 * Keep this list in sync with backend/services/crawlerJobCreation.js
 * VALID_TYPES.
 */
const CRAWLER_JOB_TYPES = [
  'local',
  'scholarship',
  'curated_benefits',
  'health_resources',
  'comprehensive',
  'national',
  'item_search',
  'item_gift_search',
  'avatar_lookup',
  'document_ingest',
  'pipeline_automation',
  'profile_enrichment',
  'national_zip_scan',
  'portal_check',
  'government_funding',
  'student_grants',
  'student_bridge_funding',
  'ecf_benefits',
  // Alias autoDiscoveryCrawlers enqueues (dispatcher maps ecf_hcbs → ecf_benefits).
  'ecf_hcbs',
  'special_needs',
  'local_funding',
  'item_matching',
  'anya_match_scout',
  // Org/nonprofit private-foundation (Form 990) + opted-in clinical-trials
  // discovery — both relevance-gated in autoDiscoveryCrawlers.
  'foundation_990',
  'clinical_trials',
  // Live profile-driven acquisition (federal APIs + local web) — enqueued by
  // autoDiscoveryCrawlers, runs liveFederalSearch + liveWebSearch and ingests.
  'live_search',
]

export async function ensureCrawlerJobsTypeCheck(db, { logger = console } = {}) {
  if (db?.dialect !== 'postgres') return true
  return runStep(
    'crawler_jobs.type CHECK',
    '[database]',
    logger,
    async () => {
      // Drop any existing CHECK constraint matching `type` (its name varies
      // across historical migrations) so we can re-add the canonical one.
      await db.exec(`
        DO $$
        DECLARE
          constraint_name text;
        BEGIN
          SELECT c.conname
          INTO constraint_name
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = 'crawler_jobs'
            AND c.contype = 'c'
            AND pg_get_constraintdef(c.oid) ILIKE '%CHECK%'
            AND pg_get_constraintdef(c.oid) ILIKE '%type%'
          LIMIT 1;

          IF constraint_name IS NOT NULL THEN
            EXECUTE format('ALTER TABLE crawler_jobs DROP CONSTRAINT IF EXISTS %I', constraint_name);
          END IF;
        END $$;
      `)
      const inList = CRAWLER_JOB_TYPES.map((t) => `'${t}'`).join(',\n          ')
      await db.exec(`
        ALTER TABLE crawler_jobs
          ADD CONSTRAINT crawler_jobs_type_check
          CHECK (type IN (
          ${inList}
          ))
      `)
    },
  )
}

/**
 * anya_match_suggestions table (migration 0068).
 * The Match Scout writes here; the recommend popup + notification bell
 * read from it. Without this table the scout's INSERT fails with
 * PG 42P01 on a fresh deploy where MIGRATE_ON_BOOT=0.
 */
export async function ensureAnyaMatchSuggestions(db, { logger = console } = {}) {
  if (db?.dialect !== 'postgres') return true
  return runStep(
    'anya_match_suggestions',
    '[database]',
    logger,
    async () => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS anya_match_suggestions (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          user_id TEXT,
          opportunity_id TEXT,
          title TEXT NOT NULL,
          funder TEXT,
          match_score REAL NOT NULL,
          match_reasons JSONB,
          need_summary JSONB,
          search_strategy JSONB,
          opportunity_data JSONB,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'accepted', 'dismissed', 'already_in_pipeline', 'expired')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          acted_at TIMESTAMPTZ,
          action_result TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_profile
          ON anya_match_suggestions(profile_id);
        CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_user
          ON anya_match_suggestions(user_id);
        CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_status
          ON anya_match_suggestions(status);
        CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_opportunity
          ON anya_match_suggestions(opportunity_id);
        CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_created
          ON anya_match_suggestions(created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_anya_match_suggestions_active_pair
          ON anya_match_suggestions(profile_id, opportunity_id)
          WHERE status = 'pending';
      `)
    },
  )
}

/**
 * matching_low_coverage_events table (both dialects).
 * Records "<X profile> tried to find <Y need> and got fewer than
 * threshold qualified matches" so we can drive Robert's coverage
 * sweep at Mission Goal #6 ("intelligent crawling").
 */
export async function ensureMatchingLowCoverageEvents(db, { logger = console } = {}) {
  return runStep(
    'matching_low_coverage_events',
    '[database]',
    logger,
    async () => {
      if (db.dialect === 'postgres') {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS matching_low_coverage_events (
            id BIGSERIAL PRIMARY KEY,
            profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
            search_terms TEXT,
            free_text TEXT,
            qualified_count INTEGER NOT NULL DEFAULT 0,
            min_score INTEGER NOT NULL DEFAULT 50,
            intent_label TEXT,
            branded_program TEXT,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_matching_low_coverage_recorded
            ON matching_low_coverage_events(recorded_at DESC);
        `)
      } else {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS matching_low_coverage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id TEXT,
            search_terms TEXT,
            free_text TEXT,
            qualified_count INTEGER NOT NULL DEFAULT 0,
            min_score INTEGER NOT NULL DEFAULT 50,
            intent_label TEXT,
            branded_program TEXT,
            recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_matching_low_coverage_recorded
            ON matching_low_coverage_events(recorded_at DESC);
        `)
      }
    },
  )
}

/**
 * profile_todo_plans table (both dialects). Persists the AI-generated Profile
 * Action Plan checklist AND per-item completion state so it survives reload and
 * "Regenerate" (the plan used to live only in React state and vanished). One row
 * per profile. `plan` + `completions` are stored as TEXT JSON in BOTH dialects
 * (parsed in app code) to avoid JSONB-vs-TEXT read differences across the shim.
 * `completions` maps a stable item key (category::title) -> { done, doc_id, at }.
 * Completion is profile-scoped so Anya/Sam can see what's actually finished.
 */
export async function ensureProfileTodoPlans(db, { logger = console } = {}) {
  return runStep(
    'profile_todo_plans',
    '[database]',
    logger,
    async () => {
      if (db.dialect === 'postgres') {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS profile_todo_plans (
            profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
            plan TEXT,
            completions TEXT NOT NULL DEFAULT '{}',
            applicant_name TEXT,
            generated_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
        `)
      } else {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS profile_todo_plans (
            profile_id TEXT PRIMARY KEY,
            plan TEXT,
            completions TEXT NOT NULL DEFAULT '{}',
            applicant_name TEXT,
            generated_at TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `)
      }
    },
  )
}

/**
 * behavior_events table (both dialects). Stores user SAVE / APPLY /
 * DISMISS / IGNORE interactions as SOFT preference signals (architecture
 * #12) consumed by matchEngine to nudge — never hard-filter — future
 * matching. See backend/services/behaviorLearning.js. Gated at read/write
 * time by BEHAVIOR_LEARNING_ENABLED; the table is always created so the
 * feature can be toggled on without a redeploy.
 */
export async function ensureBehaviorEventsTable(db, { logger = console } = {}) {
  return runStep(
    'behavior_events',
    '[database]',
    logger,
    async () => {
      if (db.dialect === 'postgres') {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS behavior_events (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            action TEXT NOT NULL
              CHECK (action IN ('saved', 'applied', 'dismissed', 'ignored')),
            opportunity_source TEXT,
            opportunity_categories JSONB,
            need_types JSONB,
            is_local BOOLEAN,
            ts TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS idx_behavior_events_profile
            ON behavior_events(profile_id);
          CREATE INDEX IF NOT EXISTS idx_behavior_events_profile_ts
            ON behavior_events(profile_id, ts);
        `)
      } else {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS behavior_events (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            action TEXT NOT NULL
              CHECK (action IN ('saved', 'applied', 'dismissed', 'ignored')),
            opportunity_source TEXT,
            opportunity_categories TEXT,
            need_types TEXT,
            is_local INTEGER,
            ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_behavior_events_profile
            ON behavior_events(profile_id);
          CREATE INDEX IF NOT EXISTS idx_behavior_events_profile_ts
            ON behavior_events(profile_id, ts);
        `)
      }
    },
  )
}

/**
 * funding_opportunities verification + reality columns (postgres
 * mirror of migrations 0061 + 0062). Several writers — including the
 * student bridge funding pipeline — assume these columns exist and
 * crash with PG 42703 when production hasn't run migrations yet.
 */
export async function ensureFundingOpportunityVerificationColumns(db, { logger = console } = {}) {
  if (db?.dialect !== 'postgres') return true
  return runStep(
    'funding_opportunities verification + kind/trust',
    '[database]',
    logger,
    async () => {
      await db.exec(`
        ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS url TEXT;
        ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ;
        ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS verification_method TEXT;
        ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS verified_by TEXT;
        ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS verification_error TEXT;
        ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS link_status_code INTEGER;
        ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS opportunity_kind TEXT;
        ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS source_trust_tier TEXT;
      `)
    },
  )
}

/**
 * Run every boot-time schema invariant in a defined order. Each step
 * has its own per-step try/catch — one failure never blocks the rest.
 *
 * Order matters only loosely: dialect-agnostic + always-on items
 * (agent subsystem, funding reality gate, application_tasks CHECK)
 * run first because downstream agent code paths depend on them; the
 * postgres-specific ALTER COLUMN / CHECK constraint repairs run
 * after.
 *
 * @returns {Promise<{ steps: Array<{ name: string, ok: boolean }>, ran: number, failed: number }>}
 */
/**
 * Performance indexes for the admin/integrity + Hamilton auth-watch read paths.
 *
 * These endpoints (GET /api/admin/profiles/integrity, .../duplicates, and
 * /api/hamilton/automation/auth-watch) were returning 504s because their
 * queries fell back to sequential scans / per-row work at scale. The query
 * shapes themselves were also fixed (correlated subqueries -> grouped JOINs,
 * unbounded profile loads -> capped), but the indexes are the durable half:
 * re-asserted on every boot so a missed migration can never silently reintroduce
 * the slow plan.
 *
 * Postgres-only (sqlite test DBs are tiny and the planner is fine without
 * these). Each CREATE runs in its own try/catch so a table that doesn't exist
 * in a given deployment can't stop the rest.
 */
export async function ensurePerfIndexes(db, { logger = console } = {}) {
  if (db?.dialect !== 'postgres') return true
  return runStep(
    'perf indexes (admin integrity + auth-watch)',
    '[database]',
    logger,
    async () => {
      const indexes = [
        // auth-watch: COUNT unread auth notifications for a user.
        'CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read)',
        // auth-watch + sessionReadiness: tasks waiting on the owner, by profile/status.
        'CREATE INDEX IF NOT EXISTS idx_application_tasks_profile_status ON application_tasks(profile_id, status)',
        'CREATE INDEX IF NOT EXISTS idx_application_tasks_status ON application_tasks(status)',
        // integrity + duplicates: status filter and the orphan/dedup aggregate JOINs.
        'CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status)',
        'CREATE INDEX IF NOT EXISTS idx_profile_sections_profile ON profile_sections(profile_id)',
        'CREATE INDEX IF NOT EXISTS idx_profile_documents_profile ON profile_documents(profile_id)',
        'CREATE INDEX IF NOT EXISTS idx_documents_profile ON documents(profile_id)',
        'CREATE INDEX IF NOT EXISTS idx_grants_profile ON grants(profile_id)',
      ]
      for (const sql of indexes) {
        try {
          await db.exec(sql)
        } catch (err) {
          // Table may not exist in this deployment — log and keep going.
          logger?.warn?.(`[database] perf index skipped (non-fatal): ${err?.message || err}`)
        }
      }
    },
  )
}

/**
 * profiles.last_discovery_at column (both dialects).
 *
 * This is the per-profile "discovery has run" signal. The matching endpoint
 * (GET /api/matching/profile/:id/opportunities) refuses to surface ANY catalog
 * results for a profile whose last_discovery_at IS NULL — so a brand-new
 * profile shows a "run discovery" empty state instead of the global catalog.
 * triggerAutoDiscoveryCrawlers + the realCrawlers POST handlers stamp it.
 *
 * Postgres uses ALTER TABLE ... ADD COLUMN IF NOT EXISTS. SQLite has no
 * IF NOT EXISTS for ADD COLUMN, so we probe PRAGMA table_info first (the
 * base schema.sql already declares the column on fresh DBs; this heals
 * older DBs that predate it).
 */
export async function ensureProfileDiscoveryColumn(db, { logger = console } = {}) {
  return runStep(
    'profiles.last_discovery_at',
    '[database]',
    logger,
    async () => {
      if (db?.dialect === 'postgres') {
        await db.exec('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_discovery_at TIMESTAMPTZ')
        return
      }
      // sqlite: add only if missing.
      let hasColumn = false
      try {
        const cols = await db.prepare('PRAGMA table_info(profiles)').all()
        hasColumn = Array.isArray(cols) && cols.some((c) => c?.name === 'last_discovery_at')
      } catch {
        hasColumn = false
      }
      if (!hasColumn) {
        await db.exec('ALTER TABLE profiles ADD COLUMN last_discovery_at DATETIME')
      }
    },
  )
}

/**
 * profiles.preferred_language — the profile's chosen language (BCP-47-ish
 * short code, e.g. 'ru', 'es'). NULL / 'en' means English-only.
 *
 * Drives the GLOBAL bilingual-documents rule: every packet Hamilton generates
 * is saved in English AND, when this is a non-English language, a translated
 * copy in that language (see hamiltonApplicationPacketGenerator.generateAndSavePacket).
 * Enforced at boot so the packet generator can rely on the column existing
 * regardless of migrate-on-boot timing.
 */
export async function ensureProfilePreferredLanguageColumn(db, { logger = console } = {}) {
  return runStep(
    'profiles.preferred_language',
    '[database]',
    logger,
    async () => {
      if (db?.dialect === 'postgres') {
        await db.exec('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS preferred_language TEXT')
        return
      }
      // sqlite: add only if missing.
      let hasColumn = false
      try {
        const cols = await db.prepare('PRAGMA table_info(profiles)').all()
        hasColumn = Array.isArray(cols) && cols.some((c) => c?.name === 'preferred_language')
      } catch {
        hasColumn = false
      }
      if (!hasColumn) {
        await db.exec('ALTER TABLE profiles ADD COLUMN preferred_language TEXT')
      }
    },
  )
}

/**
 * profiles.deleted_at column (both dialects).
 *
 * Older production databases can predate this column even though fresh schemas
 * include it. Re-assert it on boot so health checks, crawler scoping, and
 * profile filters do not fail when migrations were not applied first.
 */
export async function ensureProfileSoftDeleteColumn(db, { logger = console } = {}) {
  return runStep(
    'profiles.deleted_at',
    '[database]',
    logger,
    async () => {
      if (db?.dialect === 'postgres') {
        await db.exec('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ')
        await db.exec('CREATE INDEX IF NOT EXISTS idx_profiles_deleted_at ON profiles(deleted_at)')
        return
      }

      let hasColumn = false
      try {
        const cols = await db.prepare('PRAGMA table_info(profiles)').all()
        hasColumn = Array.isArray(cols) && cols.some((c) => c?.name === 'deleted_at')
      } catch {
        hasColumn = false
      }
      if (!hasColumn) {
        await db.exec('ALTER TABLE profiles ADD COLUMN deleted_at DATETIME')
      }
    },
  )
}

/**
 * users.last_login_at column (both dialects) — first-login owner notification.
 *
 * Stamped on every successful sign-in at the createSessionAndTokens choke
 * point; the NULL→set transition fires the one-time "new user first login"
 * owner email (services/firstLoginNotifier.js). The backfill runs ONLY when
 * the column is newly added: users that exist at introduction time are marked
 * as already signed in (created_at) so they never read as "new" — but a
 * re-run must NOT re-stamp post-introduction users who genuinely haven't
 * signed in yet. Mirrors migration 0132 (either can run first; both guard on
 * column existence).
 */
export async function ensureUsersLastLoginAtColumn(db, { logger = console } = {}) {
  return runStep(
    'users.last_login_at',
    '[database]',
    logger,
    async () => {
      if (db?.dialect === 'postgres') {
        await db.exec(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'users' AND column_name = 'last_login_at'
            ) THEN
              ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;
              UPDATE users SET last_login_at = created_at;
            END IF;
          END $$;
        `)
        return
      }

      let hasColumn = false
      try {
        const cols = await db.prepare('PRAGMA table_info(users)').all()
        hasColumn = Array.isArray(cols) && cols.some((c) => c?.name === 'last_login_at')
      } catch {
        hasColumn = false
      }
      if (!hasColumn) {
        await db.exec('ALTER TABLE users ADD COLUMN last_login_at DATETIME')
        await db.exec('UPDATE users SET last_login_at = created_at')
      }
    },
  )
}

/**
 * Ingestion provenance & quality layer tables (both dialects).
 *
 *   opportunity_evidence — per-result evidence snippets (title + matched
 *     description / eligibility text + source URL) that justify each stored
 *     opportunity. Written by provenanceAudit.persistEvidence at ingest.
 *   rejection_log — append-only "why excluded" log. Written best-effort by
 *     provenanceAudit.recordRejection whenever a gate drops a row; read by
 *     GET /api/admin/rejections.
 *
 * Without these, the inserter / ingestion service silently no-op their
 * best-effort writes (missing-table tolerated), so the admin rejection feed
 * and per-opportunity evidence stay empty. Re-asserted on every boot so a
 * missed migration can never disable provenance observability.
 */
export async function ensureIngestionProvenanceTables(db, { logger = console } = {}) {
  return runStep(
    'ingestion provenance + quality (evidence + rejection_log)',
    '[funding-schema]',
    logger,
    async () => {
      if (db?.dialect === 'postgres') {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS opportunity_evidence (
            id BIGSERIAL PRIMARY KEY,
            opportunity_id TEXT NOT NULL,
            source_url TEXT,
            snippet TEXT,
            evidence_type TEXT,
            crawl_timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_opportunity_evidence_opportunity_id
            ON opportunity_evidence(opportunity_id);
          CREATE INDEX IF NOT EXISTS idx_opportunity_evidence_crawl_ts
            ON opportunity_evidence(crawl_timestamp);

          CREATE TABLE IF NOT EXISTS rejection_log (
            id BIGSERIAL PRIMARY KEY,
            source TEXT,
            source_url TEXT,
            title TEXT,
            reason TEXT,
            stage TEXT,
            raw_meta JSONB,
            checked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_rejection_log_checked_at
            ON rejection_log(checked_at);
          CREATE INDEX IF NOT EXISTS idx_rejection_log_stage
            ON rejection_log(stage);
          CREATE INDEX IF NOT EXISTS idx_rejection_log_source
            ON rejection_log(source);
        `)
      } else {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS opportunity_evidence (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            opportunity_id TEXT NOT NULL,
            source_url TEXT,
            snippet TEXT,
            evidence_type TEXT,
            crawl_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_opportunity_evidence_opportunity_id
            ON opportunity_evidence(opportunity_id);
          CREATE INDEX IF NOT EXISTS idx_opportunity_evidence_crawl_ts
            ON opportunity_evidence(crawl_timestamp);

          CREATE TABLE IF NOT EXISTS rejection_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT,
            source_url TEXT,
            title TEXT,
            reason TEXT,
            stage TEXT,
            raw_meta TEXT,
            checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_rejection_log_checked_at
            ON rejection_log(checked_at);
          CREATE INDEX IF NOT EXISTS idx_rejection_log_stage
            ON rejection_log(stage);
          CREATE INDEX IF NOT EXISTS idx_rejection_log_source
            ON rejection_log(source);
        `)
      }
    },
  )
}

/**
 * profile_portal_status table (both dialects) — the per-profile portal
 * MERGE/COMPLETION lifecycle (migration 124 / pg 0125). The store self-heals
 * lazily (ensurePortalCompletionSchema), but the Monday-morning reminder sweep +
 * the portals route read it on paths that may run before any write created the
 * table, so we re-assert it on every boot like the other agent stores. Delegates
 * to the store's ensure fn so the DDL lives in exactly one place.
 */
export async function ensurePortalCompletionStatusTable(db, { logger = console } = {}) {
  return runStep(
    'profile_portal_status',
    '[database]',
    logger,
    async () => {
      const { ensurePortalCompletionSchema } = await import(
        '../services/hamilton/portalCompletionStore.js'
      )
      await ensurePortalCompletionSchema(db)
    },
  )
}

/**
 * Portal Autopilot Identity tables (migration 125 / pg 0126):
 *   - hamilton_portal_master_vault — per-profile master passphrase (salt +
 *     verifier, never the passphrase) + autopilot identity email.
 *   - hamilton_portal_credentials.has_master_wrap / wrapped_* — the password-
 *     manager wrap columns on auto-provisioned logins.
 * Both stores self-heal lazily, but the portals dashboard + autopilot runner read
 * them on paths that may run before any write created the table/columns, so we
 * re-assert them on every boot at the single choke point. Delegates to each
 * store's ensure fn so the DDL lives in exactly one place.
 */
export async function ensurePortalAutopilotIdentityTables(db, { logger = console } = {}) {
  return runStep(
    'portal_autopilot_identity (master vault + credential wrap)',
    '[database]',
    logger,
    async () => {
      const { ensureMasterVaultSchema } = await import(
        '../services/hamilton/hamiltonPortalMasterVault.js'
      )
      await ensureMasterVaultSchema(db)
      // Re-assert the wrap columns on the credentials table (ensureSchema there
      // is idempotent and adds has_master_wrap / wrapped_* if missing).
      const { _resetCredentialSchemaCache, listCredentialsForProfile } = await import(
        '../services/hamilton/hamiltonPortalCredentialService.js'
      )
      // Force a fresh ensureSchema pass on the credentials table so older deploys
      // gain the new columns even if a prior call cached the table as ready.
      _resetCredentialSchemaCache()
      await listCredentialsForProfile(db, '__schema_probe__').catch(() => {})
    },
  )
}

/**
 * profile_phones SMS-consent columns (both dialects) — consent_status +
 * consent_requested_at (migration 126 / pg 0127). commsService owns the table
 * DDL; smsConsentService owns the state machine. The consent campaign + the
 * Twilio inbound webhook + the deadline-SMS path all read consent_status on
 * paths that may run before any write created the columns, so we re-assert them
 * on every boot at the single choke point. Delegates to ensureCommsSchema so the
 * DDL lives in exactly one place.
 */
export async function ensureSmsConsentColumns(db, { logger = console } = {}) {
  return runStep(
    'profile_phones SMS consent (consent_status + consent_requested_at)',
    '[database]',
    logger,
    async () => {
      const { ensureCommsSchema } = await import('../services/comms/commsService.js')
      await ensureCommsSchema(db)
    },
  )
}

/**
 * anya_runs live-run columns (progress_json + cancel_requested).
 *
 * Powers the Anya chat "watch her work" step feed and the Stop/Escape control:
 * the orchestrator writes each tool step into progress_json and checks
 * cancel_requested between steps (cooperative cancel — see anyaRuns.js).
 * Additive on both dialects so older databases pick the columns up on boot.
 */
export async function ensureAnyaRunLiveColumns(db, { logger = console } = {}) {
  return runStep(
    'anya_runs live-run columns (progress_json + cancel_requested)',
    '[database]',
    logger,
    async () => {
      if (db?.dialect === 'postgres') {
        await db.exec("ALTER TABLE anya_runs ADD COLUMN IF NOT EXISTS progress_json TEXT DEFAULT '[]'")
        await db.exec('ALTER TABLE anya_runs ADD COLUMN IF NOT EXISTS cancel_requested INTEGER DEFAULT 0')
        return
      }
      // sqlite: add only if missing.
      let cols = []
      try {
        cols = await db.prepare('PRAGMA table_info(anya_runs)').all()
      } catch {
        cols = []
      }
      const names = new Set((cols || []).map((c) => c?.name))
      if (names.size === 0) return // table not created yet — schema.sql owns it
      if (!names.has('progress_json')) {
        await db.exec("ALTER TABLE anya_runs ADD COLUMN progress_json TEXT DEFAULT '[]'")
      }
      if (!names.has('cancel_requested')) {
        await db.exec('ALTER TABLE anya_runs ADD COLUMN cancel_requested INTEGER DEFAULT 0')
      }
    },
  )
}

/**
 * The canonical, ordered registry of schema-invariant steps.
 *
 * SINGLE SOURCE OF TRUTH: this is the only place a step is declared. The boot
 * orchestrator iterates it, and the guard test imports its names via
 * `__testables.SCHEMA_INVARIANT_STEP_NAMES` — so adding a step is a ONE-line
 * change here and can never again drift a hand-copied list in the test.
 * Order matters (dependency-ordered): the sqlite/dialect-agnostic table
 * creations run first because downstream agent code paths depend on them.
 */
const SCHEMA_INVARIANT_STEPS = [
  ['agent_subsystem', ensureAgentSubsystem],
  ['funding_opportunity_reality_gate', ensureFundingOpportunityRealityGate],
  ['application_task_check', ensureApplicationTaskCheck],
  ['organizations_soft_delete', ensureOrganizationsSoftDeleteColumns],
  ['crawler_jobs_type_check', ensureCrawlerJobsTypeCheck],
  ['anya_match_suggestions', ensureAnyaMatchSuggestions],
  ['matching_low_coverage_events', ensureMatchingLowCoverageEvents],
  ['profile_todo_plans', ensureProfileTodoPlans],
  ['behavior_events', ensureBehaviorEventsTable],
  ['profile_discovery_column', ensureProfileDiscoveryColumn],
  ['profile_preferred_language_column', ensureProfilePreferredLanguageColumn],
  ['profile_soft_delete_column', ensureProfileSoftDeleteColumn],
  ['users_last_login_at_column', ensureUsersLastLoginAtColumn],
  ['funding_opportunity_verification_columns', ensureFundingOpportunityVerificationColumns],
  ['ingestion_provenance_tables', ensureIngestionProvenanceTables],
  ['profile_portal_status', ensurePortalCompletionStatusTable],
  ['portal_autopilot_identity', ensurePortalAutopilotIdentityTables],
  ['sms_consent_columns', ensureSmsConsentColumns],
  ['anya_run_live_columns', ensureAnyaRunLiveColumns],
  ['perf_indexes', ensurePerfIndexes],
]

/** Ordered canonical step names, derived from the registry (never hand-typed). */
export const SCHEMA_INVARIANT_STEP_NAMES = SCHEMA_INVARIANT_STEPS.map(([name]) => name)

export async function ensureSchemaInvariants(db, { logger = console } = {}) {
  const steps = SCHEMA_INVARIANT_STEPS

  const results = []
  for (const [name, fn] of steps) {
    const ok = await fn(db, { logger })
    results.push({ name, ok })
  }

  const failed = results.filter((r) => !r.ok).length
  if (failed > 0) {
    logger?.warn?.(
      `[schema-invariants] ${failed} of ${results.length} steps failed (non-fatal); see prior warnings.`,
    )
  } else {
    logger?.info?.(`[schema-invariants] all ${results.length} steps OK`)
  }
  return { steps: results, ran: results.length, failed }
}

export const __testables = { CRAWLER_JOB_TYPES, SCHEMA_INVARIANT_STEP_NAMES }
