/**
 * selfHeal.js — Self-healing and baseline-seeding startup tasks.
 *
 * Handles:
 *   1. Upload-avatar repair (remove DB refs to missing files)
 *   2. Document-status repair (fix invalid status values)
 *   3. Baseline seeding (profiles, designated profiles, org links)
 *   4. Service-catalog seeding
 *   5. Funding-opportunity seeding (when DB is empty)
 *   6. National minimum opportunities enforcement
 *   7. Assistance-directory seeding
 *   8. Faith-based housing seeding
 *
 * In SMOKE_MODE (fast unit/contract test boot) only lightweight fixtures are
 * created; all heavy I/O-bound tasks are skipped.
 *
 * ── On-demand execution (Sam / Anya) ────────────────────────────────────────
 * runSelfHeal is invoked at boot (server.js) AND on demand by Sam's nightly
 * maintenance sweep and Anya's `owner.run_self_heal` tool. Every step is
 * idempotent and safe to re-run live (seeds are gated on count thresholds, the
 * baseline upsert preserves live avatars via COALESCE, enforceInvariants is
 * per-step guarded). The ONE step that is NOT safe to expose on demand is a
 * `force` baseline RE-SEED (BASELINE_SEED_MODE=force re-upserts every profile/
 * grant/document — a boot-only recovery lever). When `onDemand:true` we coerce
 * the seed mode to 'auto' so an on-demand run can never trigger that destructive
 * re-seed; everything else runs identically. The function returns a structured,
 * truthful per-step summary of what actually ran/repaired.
 *
 * @param {{ db, uploadsDir: string, IS_SMOKE_MODE: boolean, baseDir: string, onDemand?: boolean }} args
 * @returns {Promise<object>} structured summary { ran, onDemand, smoke, steps[], failures[], totalRepaired }
 */

import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import ensureDesignatedProfiles from '../utils/ensureDesignatedProfiles.js';
import ensureUserPreferencesTable from '../utils/ensureUserPreferencesTable.js';
import ensurePortalCheckResultsTable from '../utils/ensurePortalCheckResultsTable.js';
import { linkAllProfilesToAdmin } from '../utils/adminProfileLinks.js';
import { ensureProfileOrgLinks } from '../utils/ensureProfileOrgLinks.js';
import { seedBaselineFromRepo } from '../utils/seedBaselineFromRepo.js';
import ensureMinimumNationalOpportunities from '../utils/ensureMinimumNationalOpportunities.js';
import seedAssistanceDirectories from '../utils/seedAssistanceDirectories.js';
import seedFaithBasedHousing from '../utils/seedFaithBasedHousing.js';
import seedHousingFundingOpportunities from '../utils/seedHousingFunding.js';
import { seedServiceCatalogFromExtract } from '../services/serviceCatalogStore.js';
import { repairOrphanedJobProfiles } from '../utils/repairOrphanedJobProfiles.js';
import { reconcileDismissedGrants } from '../services/pipelineDismissals.js';
import { runEnforceInvariants, enforceNoDuplicateGrants } from './enforceInvariants.js';
import { resolveUploadsDir } from '../utils/uploadsDir.js';
import { recordSelfHealRun } from './selfHealStatus.js';

export async function runSelfHeal({ db, uploadsDir, IS_SMOKE_MODE, baseDir, onDemand = false }) {
  // Structured, truthful run summary. Each step records what it actually did so
  // Sam's diagnostics + Anya's status reader can see the last run (see
  // recordSelfHealRun at the end). `record` only ever appends — never claims a
  // step ran when it was skipped.
  const startedAt = new Date().toISOString();
  const summary = {
    ran: true,
    onDemand: Boolean(onDemand),
    smoke: Boolean(IS_SMOKE_MODE),
    dialect: db?.dialect ?? 'unknown',
    started_at: startedAt,
    steps: [],
    failures: [],
    totalRepaired: 0,
  };
  const record = (step, data = {}) => {
    summary.steps.push({ step, ...data });
    if (Number.isFinite(data.repaired)) summary.totalRepaired += Number(data.repaired) || 0;
    if (data.ok === false || data.error) {
      summary.failures.push({ step, error: data.error ?? 'unknown' });
    }
  };

  // ── 1. Upload-avatar repair ───────────────────────────────────────────────
  // (called later in the non-smoke path; function defined here so it's co-located)

  // ── 2. Baseline seeding ───────────────────────────────────────────────────
  if (IS_SMOKE_MODE) {
    // Contract/unit tests start the backend in "smoke" mode.
    // Heavy boot tasks must not block PORT binding.
    console.info(
      '[startup] SMOKE_MODE enabled; skipping baseline seed + heavy startup tasks',
    );
    // Still ensure core fixtures exist so auth/access tests have profiles to attach to.
    await ensureDesignatedProfiles(db);
    await linkAllProfilesToAdmin(db);
    await ensureUserPreferencesTable(db);
    await ensurePortalCheckResultsTable(db);
    record('smoke_fixtures', { ok: true });
  } else {
    try {
      let mode =
        String(process.env.BASELINE_SEED_MODE || '').trim().toLowerCase() || 'auto';
      // GATE: a `force` baseline re-seed re-upserts every profile/grant/document
      // and is the one boot-only recovery lever that is NOT safe to expose to an
      // on-demand (Sam/Anya) runtime run. Coerce it to 'auto' on demand so the
      // on-demand path can never trigger a destructive re-seed; boot keeps force.
      if (onDemand && mode === 'force') {
        console.info('[startup] self-heal on-demand: downgrading BASELINE_SEED_MODE=force to auto (boot-only lever)');
        mode = 'auto';
      }
      const result = await seedBaselineFromRepo(db, {
        mode: mode === 'force' ? 'force' : mode === 'off' ? 'off' : 'auto',
      });
      console.info('[startup] baseline seed', {
        ok: result.ok,
        skipped: result.skipped,
        reason: result.reason ?? null,
        seed_path: result.seed_path ?? null,
        exported_at: result.exported_at ?? null,
        before: result.before ?? null,
        after: result.after ?? null,
        decisions: result.decisions ?? null,
      });
      record('baseline_seed', {
        ok: result.ok !== false,
        seed_mode: mode,
        skipped: Boolean(result.skipped),
        reason: result.reason ?? null,
      });
    } catch (error) {
      // Fallback to designated profiles so the server can still boot.
      console.error(
        '[startup] Failed to seed baseline from repo. Falling back to designated profiles.',
        { error: error?.message || String(error) },
      );
      await ensureDesignatedProfiles(db);
      record('baseline_seed', { ok: false, error: error?.message || String(error) });
    }

    // Always ensure designated profiles exist (idempotent).
    await ensureDesignatedProfiles(db);
    await linkAllProfilesToAdmin(db);

    // Prevent "orphaned profiles" by ensuring every active profile has an organization_id.
    try {
      await ensureProfileOrgLinks(db, {
        limit: Number(process.env.STARTUP_PROFILE_ORG_LINK_LIMIT || 5000),
        includeDeleted: false,
        dryRun: false,
      });
    } catch (error) {
      console.warn(
        '[startup] Failed to ensure profile organization links:',
        error?.message || error,
      );
    }

    await ensureUserPreferencesTable(db);
    await ensurePortalCheckResultsTable(db);
    await repairInvalidDocumentStatuses(db);
    await repairMissingUploadAvatars({ db, uploadsDir });

    // Recover crawler_jobs that died with `Profile X not found` because the
    // job's profile_id pointed at a designated slug that has been re-keyed to
    // a live UUID (or vice versa). The resolver heals the id and the row is
    // re-queued so the autonomous run actually finishes. Mission goals:
    // "avoid zero-result experiences" and "missing fields default to neutral,
    // not exclusionary."
    try {
      const repairLimit = Number.parseInt(
        process.env.STARTUP_PROFILE_JOB_REPAIR_LIMIT || '500',
        10,
      );
      const result = await repairOrphanedJobProfiles(db, {
        limit: Number.isFinite(repairLimit) ? repairLimit : 500,
      });
      if (result.repaired > 0 || result.errors > 0) {
        console.info('[startup] repaired orphaned crawler_jobs profile aliases', {
          scanned: result.scanned,
          repaired: result.repaired,
          skipped: result.skipped,
          errors: result.errors,
        });
      }
      record('repair_orphaned_jobs', { ok: true, repaired: Number(result.repaired) || 0 });
    } catch (error) {
      console.warn(
        '[startup] Failed to repair orphaned crawler_jobs profile aliases:',
        error?.message || error,
      );
      record('repair_orphaned_jobs', { ok: false, error: error?.message || String(error) });
    }
  }

  // ── 3. Service-catalog seeding ────────────────────────────────────────────
  try {
    await seedServiceCatalogFromExtract(db);
  } catch (error) {
    console.warn(
      '[startup] Failed to seed service catalog from extract:',
      error?.message || error,
    );
  }

  // ── 4. Funding-opportunity auto-seed (SQLite, non-smoke) ─────────────────
  if (!IS_SMOKE_MODE && db.dialect === 'sqlite') {
    try {
      const oppCount = db
        .prepare('SELECT COUNT(*) as count FROM funding_opportunities')
        .get();
      const activeCount = db
        .prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1')
        .get();
      if (oppCount && Number(oppCount.count) === 0) {
        console.info('[startup] No funding opportunities found, auto-seeding...');
        try {
          const { seedRealOpportunities } = await import(
            '../utils/seedRealOpportunities.js'
          );
          await seedRealOpportunities(db);
          const newCount = db
            .prepare(
              'SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1',
            )
            .get();
          console.info(`[startup] Seeded ${Number(newCount.count)} funding opportunities`);
        } catch (e) {
          console.warn(
            '[startup] Failed to auto-seed funding opportunities:',
            e?.message || e,
          );
        }
      } else {
        console.info(
          `[startup] Found ${oppCount.count} existing funding opportunities`,
        );
      }
    } catch (error) {
      console.warn(
        '[startup] Error checking opportunities count:',
        error.message,
      );
    }
  } else {
    console.info(
      '[startup] Skipping SQLite-only opportunity seeding checks',
      { smoke: IS_SMOKE_MODE, dialect: db.dialect },
    );
  }

  // ── 5. National minimum opportunities (non-smoke, SQLite) ─────────────────
  try {
    if (IS_SMOKE_MODE) {
      console.info(
        '[startup]',
        JSON.stringify({
          event: 'min_national_ensure',
          enabled_by: 'smoke_mode',
          minimum: null,
          skipped: true,
        }),
      );
    } else {
      const minimum = Number.parseInt(
        process.env.MIN_NATIONAL_OPPORTUNITIES || '3',
        10,
      );
      const min = Number.isFinite(minimum) ? minimum : 3;

      const isProd = process.env.NODE_ENV === 'production';
      const flag = _parseBoolEnv(process.env.ENABLE_MIN_NATIONAL_ENSURE);

      // This helper is SQLite-only today (PRAGMA usage + sync calls).
      if (db.dialect !== 'sqlite') {
        console.info(
          '[startup]',
          JSON.stringify({
            event: 'min_national_ensure',
            enabled_by: 'skipped_postgres',
            minimum: min,
            skipped: true,
          }),
        );
      } else {
        const activeTotalRow = db
          .prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = ?')
          .get(1);
        const activeTotal = Number(activeTotalRow?.count ?? 0);

        let shouldEnsure = false;
        let enabledBy = 'disabled';

        if (flag === true) {
          shouldEnsure = true;
          enabledBy = 'flag';
        } else if (flag === false) {
          shouldEnsure = false;
          enabledBy = 'flag_off';
        } else if (!isProd) {
          shouldEnsure = true;
          enabledBy = 'default_nonprod';
        } else if (activeTotal === 0) {
          shouldEnsure = true;
          enabledBy = 'first_boot';
        }

        if (shouldEnsure) {
          const ensured = await ensureMinimumNationalOpportunities(db, min);
          const backfilled = (ensured.events || []).some(
            (e) => e.type === 'backfill' || e.type === 'schema_backfill',
          );

          const evt = {
            event: 'min_national_ensure',
            enabled_by: enabledBy,
            minimum: ensured.minimum,
            ok: ensured.ok,
            total: ensured.total,
            ensured: ensured.ensured,
            backfilled,
            sources: (ensured.events || [])
              .filter((e) => e.type === 'backfill')
              .map((e) => e.source),
          };

          console.info('[startup]', JSON.stringify(evt));

          if (!ensured.ok) {
            console.warn(
              `[startup] National minimum not met: have ${ensured.total}, need ${ensured.minimum}`,
            );
          }
        } else {
          console.info(
            '[startup]',
            JSON.stringify({
              event: 'min_national_ensure',
              enabled_by: enabledBy,
              minimum: min,
              skipped: true,
            }),
          );
        }
      }
    }
  } catch (error) {
    console.warn(
      '[startup] Failed to ensure national minimum opportunities:',
      error?.message || error,
    );
  }

  // ── 6. Assistance-directory seeding (SQLite, non-smoke) ──────────────────
  try {
    if (IS_SMOKE_MODE) {
      console.info('[startup] Skipping assistance directory seeding (SMOKE_MODE)');
    } else if (db.dialect !== 'sqlite') {
      console.info(
        '[startup] Skipping assistance directory seeding (dialect !== sqlite)',
      );
    } else {
      const existing = db
        .prepare(
          "SELECT COUNT(*) as count FROM funding_opportunities WHERE source IN ('state_211','assistance_network')",
        )
        .get()?.count;

      if ((existing ?? 0) < 250) {
        console.info(
          '[startup] Seeding assistance directories (state_211 + assistance_network)...',
        );
        const dataDir = join(baseDir, 'data');
        const hasAssistanceSeedFiles =
          fs.existsSync(join(dataDir, 'state_assistance_programs.json')) ||
          fs.existsSync(join(dataDir, 'local_assistance_networks.json'));

        if (!hasAssistanceSeedFiles) {
          console.info(
            `[startup] Assistance directory seed files missing under ${dataDir}; skipping`,
          );
        } else {
          const result = await seedAssistanceDirectories(db);
          const after = db
            .prepare(
              "SELECT COUNT(*) as count FROM funding_opportunities WHERE source IN ('state_211','assistance_network')",
            )
            .get()?.count;
          console.info('[startup] Seeded assistance directories', {
            ...result,
            after,
          });
        }
      } else {
        console.info('[startup] Assistance directories already seeded', {
          count: existing,
        });
      }
    }
  } catch (error) {
    console.warn(
      '[startup] Failed to seed assistance directories:',
      error?.message || error,
    );
  }

  // ── 7. Faith-based housing seeding ───────────────────────────────────────
  try {
    const faithCount =
      db
        .prepare(
          "SELECT COUNT(*) as count FROM funding_opportunities WHERE source = 'faith_based_assistance' AND is_active = 1",
        )
        .get()?.count ?? 0;

    if (faithCount < 6) {
      console.info(
        '[startup] Seeding faith-based housing assistance (Lorain County OH)...',
      );
      const result = await seedFaithBasedHousing(db);
      const afterCount = db
        .prepare(
          "SELECT COUNT(*) as count FROM funding_opportunities WHERE source = 'faith_based_assistance' AND state = 'OH' AND is_active = 1",
        )
        .get()?.count;
      console.info('[startup] Seeded faith-based housing', {
        ...result,
        after: afterCount,
      });
    } else {
      console.info('[startup] Faith-based housing already seeded', {
        count: faithCount,
      });
    }
  } catch (error) {
    console.warn(
      '[startup] Failed to seed faith-based housing:',
      error?.message || error,
    );
  }

  // ── Housing funding opportunities (TN HOPE, faith-based, talent-based, COA) ──
  try {
    const housingCount = db
      .prepare(
        "SELECT COUNT(*) as count FROM funding_opportunities WHERE funding_category IS NOT NULL AND usable_for_housing = 1 AND is_active = 1",
      )
      .get()?.count ?? 0;

    if (housingCount < 5) {
      console.info('[startup] Seeding housing-eligible funding opportunities...');
      const result = await seedHousingFundingOpportunities(db);
      console.info('[startup] Seeded housing funding', result);
    } else {
      console.info('[startup] Housing funding already seeded', { count: housingCount });
    }
  } catch (error) {
    console.warn('[startup] Failed to seed housing funding:', error?.message || error);
  }

  // ── 8. Enforce sticky deletes (rule-by-construction) ──────────────────────
  // Runs LAST, after every seed/heal step above, in ALL environments (not
  // gated by seeding flags). This re-asserts the invariant "a source a user
  // deleted from a profile pipeline stays gone" by purging any grant that
  // matches a recorded tombstone — no matter which path (seed re-upsert,
  // legacy direct insert, a future code path) put it back. This is the
  // permanent, global backstop for the recurring "deleted grants reappear"
  // problem; the per-insert DISMISSED gates are the first line, this is the net.
  try {
    const removed = await reconcileDismissedGrants(db);
    console.info('[startup] reconcileDismissedGrants', { removed });
    record('reconcile_dismissed_grants', { ok: true, repaired: Number(removed) || 0 });
  } catch (error) {
    console.warn('[startup] Failed to reconcile dismissed grants:', error?.message || error);
    record('reconcile_dismissed_grants', { ok: false, error: error?.message || String(error) });
  }

  // ── 9. Enforce ALL machine-checkable product invariants (rule-by-construction) ──
  // The canonical choke point. Re-asserts every automatable canonical_rules.md
  // invariant against the live DB (sticky deletes, no cross-profile/tenant
  // bleed, relevance floor) — detect + repair/quarantine, regardless of which
  // code path created the violation. Re-running reconcileDismissedGrants inside
  // is idempotent. See backend/startup/enforceInvariants.js for the full list,
  // and the "INVARIANTS" section of docs/canonical_rules.md + CLAUDE.md.
  try {
    const inv = await runEnforceInvariants(db);
    record('enforce_invariants', {
      ok: (inv?.failed ?? 0) === 0,
      repaired: Number(inv?.totalRepaired) || 0,
      steps_ran: Number(inv?.ran) || 0,
      steps_failed: Number(inv?.failed) || 0,
    });
  } catch (error) {
    console.warn('[startup] Failed to enforce product invariants:', error?.message || error);
    record('enforce_invariants', { ok: false, error: error?.message || String(error) });
  }

  // ── 10. Final dedupe backstop (rule-by-construction) ──────────────────────
  // runEnforceInvariants already collapses within-profile duplicate grants, but
  // we re-assert it explicitly here as the last boot action so the pipeline can
  // never end a boot holding duplicates regardless of ordering. Profile-scoped,
  // keep-best, idempotent (a clean DB yields zero removals). Never throws.
  try {
    const dup = await enforceNoDuplicateGrants(db);
    console.info('[startup] enforceNoDuplicateGrants', {
      duplicatesRemoved: dup?.duplicatesRemoved ?? 0,
      profilesAffected: dup?.profilesAffected ?? 0,
    });
    record('dedupe_grants', {
      ok: true,
      repaired: Number(dup?.duplicatesRemoved) || 0,
      profiles_affected: Number(dup?.profilesAffected) || 0,
    });
  } catch (error) {
    console.warn('[startup] Failed to dedupe grants:', error?.message || error);
    record('dedupe_grants', { ok: false, error: error?.message || String(error) });
  }

  summary.finished_at = new Date().toISOString();
  summary.ok = summary.failures.length === 0;
  return summary;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function repairMissingUploadAvatars({ db, uploadsDir }) {
  // If the DB references upload URLs that no longer exist on disk (common after an
  // ephemeral volume reset), browsers will spam 404s.
  try {
    const rows = db
      .prepare(
        `
          SELECT id, avatar_url
          FROM profiles
          WHERE avatar_url IS NOT NULL
            AND TRIM(avatar_url) <> ''
        `,
      )
      .all();

    let repaired = 0;
    for (const row of rows) {
      const raw = String(row.avatar_url || '').trim();
      if (!raw) continue;

      let pathname = raw;
      try {
        if (/^https?:\/\//i.test(raw)) pathname = new URL(raw).pathname;
      } catch {
        // keep raw as-is
      }

      if (!pathname.includes('/uploads/')) continue;
      const fileName = pathname.split('/').pop();
      if (!fileName) continue;

      const fullPath = join(uploadsDir, fileName);
      if (fs.existsSync(fullPath)) continue;

      // Rehydrate the on-disk cache from the durable DB copy when present,
      // instead of discarding the reference (keeps avatars across restarts).
      let durable = null;
      try {
        durable = db.prepare('SELECT avatar_data FROM profiles WHERE id = ?').get(row.id);
      } catch {
        // avatar_data column may not exist yet; treat as no durable copy.
      }
      if (durable?.avatar_data) {
        try {
          const buf = Buffer.isBuffer(durable.avatar_data) ? durable.avatar_data : Buffer.from(durable.avatar_data);
          fs.writeFileSync(fullPath, buf);
          continue;
        } catch {
          // fall through to null the dangling reference
        }
      }

      // No durable copy: remove the reference so the frontend uses its fallback.
      db
        .prepare(
          'UPDATE profiles SET avatar_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        )
        .run(row.id);
      repaired += 1;
    }

    if (repaired > 0) {
      console.warn('[startup] repaired missing upload avatars', { repaired });
    }
  } catch (error) {
    console.warn(
      '[startup] failed to repair missing upload avatars:',
      error?.message || error,
    );
  }
}

async function repairInvalidDocumentStatuses(db) {
  // Postgres uses a CHECK constraint on documents.status; if any legacy rows exist
  // (e.g. "processed"), any UPDATE touching that row will fail.
  try {
    db
      .prepare(
        `
          UPDATE documents
          SET status = 'draft',
              updated_at = CURRENT_TIMESTAMP
          WHERE status IS NOT NULL
            AND status NOT IN ('draft','review','final','submitted')
        `,
      )
      .run();
  } catch (error) {
    // Non-fatal: some deployments may not have the documents table yet.
    console.warn(
      '[startup] Failed to repair invalid document statuses:',
      error?.message || error,
    );
  }
}

function _parseBoolEnv(value) {
  if ((value === null || value === undefined)) return null;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return null;
}

/**
 * On-demand entrypoint for the FULL self-heal — the single function Sam's
 * nightly sweep and Anya's owner.run_self_heal tool both call. It:
 *   - resolves `uploadsDir` / `baseDir` the SAME way server.js does (the
 *     backend dir is this file's parent's parent: backend/startup -> backend),
 *   - runs the full runSelfHeal with onDemand:true (so the destructive `force`
 *     re-seed is downgraded to 'auto'; everything else runs identically),
 *   - persists the structured result to system_kv for observability (Sam
 *     diagnostics + Anya status reader read it back via getLastSelfHealRun).
 *
 * Always resolves; never throws (the heal's per-step guards already absorb
 * failures, and recording is best-effort) so a caller can run it safely inside
 * a maintenance window.
 *
 * @param {object} db
 * @param {{ uploadsDir?: string, baseDir?: string }} [opts]
 * @returns {Promise<object>} the structured self-heal summary
 */
export async function runSelfHealOnDemand(db, opts = {}) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // backend/startup -> backend (matches server.js __dirname used for selfHeal's
  // baseDir = repo's backend/ dir, and resolveUploadsDir({ baseDir }) ).
  const backendDir = opts.baseDir || join(__dirname, '..');
  const uploadsDir = opts.uploadsDir || resolveUploadsDir({ baseDir: backendDir }).uploadsDir;

  let summary;
  try {
    summary = await runSelfHeal({
      db,
      uploadsDir,
      // On-demand is a real runtime run (never smoke); we want the full heal.
      IS_SMOKE_MODE: false,
      baseDir: backendDir,
      onDemand: true,
    });
  } catch (error) {
    // runSelfHeal is per-step guarded, but defend the wrapper too so the caller
    // (a maintenance window) never crashes on an unexpected orchestrator throw.
    console.warn('[startup] self-heal orchestrator threw (non-fatal):', error?.message || error);
    summary = {
      ran: true,
      onDemand: true,
      smoke: false,
      ok: false,
      steps: [],
      failures: [{ step: 'orchestrator', error: error?.message || String(error) }],
      totalRepaired: 0,
      finished_at: new Date().toISOString(),
    };
  }

  // Observability (Agent Observability Rule): record the last run so Sam's
  // diagnostics + Anya's status reader can see it. Best-effort.
  try {
    await recordSelfHealRun(db, summary);
  } catch (error) {
    console.warn('[startup] failed to record self-heal run (non-fatal):', error?.message || error);
  }

  return summary;
}
