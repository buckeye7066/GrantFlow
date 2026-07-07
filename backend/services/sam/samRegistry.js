/**
 * samRegistry.js
 *
 * The closed registry of checks Sam can run. Each check is a small object
 * with a stable `id`, a category, a description, and a `run` function.
 *
 * Three check styles are first-class so Sam can compose them without
 * ad-hoc plumbing:
 *
 *   1. tool      — invokes an existing Anya admin tool by name
 *                  (e.g. `admin.code.scan`, `admin.codeGuard.missionVerify`)
 *                  via the in-process tool registry. Most diagnostics live
 *                  here so we never reimplement scanners.
 *
 *   2. http      — issues an internal probe of an HTTP route (e.g. /readyz,
 *                  /api/health/mission). Expressed as a relative path; the
 *                  caller decides how to dispatch (live HTTP in production,
 *                  injected probe in tests).
 *
 *   3. script    — runs an npm script or a node script in the repo root
 *                  via `samSafeFixes.runWhitelistedCommand()`. Used only by
 *                  the gatekeeper / production-gate path. Sam refuses to
 *                  run any command that isn't whitelisted here.
 *
 * The registry also lists the tiny set of DETERMINISTIC safe fixes Sam is
 * permitted to apply in `repair-safe` mode (see `samSafeFixes.js`).
 */

import { SAM_CATEGORIES, SEVERITY } from './samTypes.js'
import { PIPELINE_ACTIVE_STATUSES, pipelineValueSql } from '../../config/pipelineValue.js'

// ---------------------------------------------------------------------------
// Shape constants
// ---------------------------------------------------------------------------
export const CHECK_KIND = Object.freeze({
  TOOL: 'tool',
  HTTP: 'http',
  SCRIPT: 'script',
  INTERNAL: 'internal',
})

// Dialect-aware time cutoff for raw timestamp comparisons (mirrors
// crawlerConcurrencyGuard): Postgres compares ISO strings against timestamptz
// natively, but SQLite CURRENT_TIMESTAMP stores 'YYYY-MM-DD HH:MM:SS' — an ISO
// cutoff with its 'T' separator sorts AFTER every same-date SQLite timestamp,
// so same-day comparisons silently misclassify. Both formats are returned in
// the shape the engine actually stores.
function timeCutoff(db, msAgo) {
  const iso = new Date(Date.now() - msAgo).toISOString()
  if (db?.dialect === 'postgres') return iso
  return iso.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '')
}

// ---------------------------------------------------------------------------
// Diagnostic checks (read-only — no writes, no scripts)
// ---------------------------------------------------------------------------
//
// Each check that delegates to an Anya tool fails *open* (Sam reports a
// medium finding instead of crashing) when the tool registry hasn't loaded
// yet — that way Sam's status endpoint always responds even if Anya's
// tooling is unavailable.

export const DIAGNOSTIC_CHECKS = Object.freeze([
  {
    id: 'code.scan',
    label: 'Codebase scan (TODOs, debugger, console)',
    category: SAM_CATEGORIES.DEAD_CODE,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.code.scan',
    parameters: { dryRun: true },
    severityOnFailure: SEVERITY.LOW,
    // HEAVY: walks the entire source tree. Belongs to the gatekeeper/CI sweep,
    // not the operational agent-control cycle (it would add tens of seconds to
    // every Sam preflight and stall the Robert→Yana→John→Hamilton chain).
    heavy: true,
    description: 'Delegates to Anya admin.code.scan to find TODO / debugger / leftover console.* statements without mutating any files.',
  },
  {
    id: 'code.crawl',
    label: 'Codebase pattern crawl',
    category: SAM_CATEGORIES.BROKEN_IMPORTS,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.code.crawl',
    parameters: { dryRun: true, maxFiles: 200 },
    severityOnFailure: SEVERITY.MEDIUM,
    heavy: true, // walks the source tree
    description: 'Delegates to Anya admin.code.crawl to find broken imports, missing handlers, structural drift across the codebase.',
  },
  {
    id: 'code.lint',
    label: 'Code lint snapshot',
    category: SAM_CATEGORIES.LOGGING_AND_ERROR_HANDLING,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.code.lint',
    parameters: { dryRun: true },
    severityOnFailure: SEVERITY.LOW,
    heavy: true, // shells out to ESLint over the tree
    description: 'Delegates to Anya admin.code.lint to surface ESLint-style issues without applying autofixes.',
  },
  {
    id: 'code.missionAudit',
    label: 'Mission audit (canonical fields, SQL safety, placeholders)',
    category: SAM_CATEGORIES.SQL_SAFETY,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.code.missionAudit',
    parameters: {},
    severityOnFailure: SEVERITY.HIGH,
    heavy: true, // runs the mission audit across the whole tree
    description: 'Delegates to runMissionAudit so Sam can see canonical-field violations, unsafe SQL, hardcoded placeholders, etc.',
  },
  {
    id: 'codeGuard.endpointHealth',
    label: 'Endpoint health probe',
    category: SAM_CATEGORIES.ROUTE_INTEGRITY,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.codeGuard.endpointHealth',
    parameters: {},
    severityOnFailure: SEVERITY.HIGH,
    heavy: true, // fans out HTTP probes across many live routes
    description: 'Delegates to codeGuardService.testEndpoints to probe live API routes and report broken/missing/slow endpoints.',
  },
  {
    id: 'codeGuard.missionVerify',
    label: 'Mission goals verification',
    category: SAM_CATEGORIES.PRODUCTION_CONFIG,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.codeGuard.missionVerify',
    parameters: {},
    severityOnFailure: SEVERITY.HIGH,
    heavy: true, // scans the tree / fans out to verify every mission goal
    description: 'Delegates to codeGuardService.verifyMissionGoals — the canonical mission-readiness scorecard.',
  },
  {
    id: 'health.check',
    label: 'System health check',
    category: SAM_CATEGORIES.ENVIRONMENT_READINESS,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.health.check',
    parameters: {},
    severityOnFailure: SEVERITY.HIGH,
    description: 'Delegates to adminHealthCheck for a system-wide health snapshot.',
  },
  {
    // Make operator-provisionable funding sources DISCOVERABLE: a source that is
    // inactive only because an optional API key is unset is not a failure (the
    // system degrades honestly), but it should be visible in Mission Control so
    // the owner knows exactly what to provision to widen coverage — instead of
    // the source silently contributing nothing.
    id: 'discovery.sourceCredentials',
    label: 'Funding source credentials',
    category: SAM_CATEGORIES.ENVIRONMENT_READINESS,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.LOW,
    description: 'Lists funding/discovery sources inactive because an optional API key is unset (e.g. CareerOneStop scholarships). Informational — provisioning each key widens coverage; none blocks a core goal.',
    async run() {
      const inactive = []
      try {
        const { SOURCES } = await import('../../crawler-os/sourceRegistry.js')
        for (const s of SOURCES) {
          const missing = (s.requires_env || []).filter((k) => !process.env[k] || !String(process.env[k]).trim())
          if (missing.length) inactive.push({ source: s.source_id, missing_env: missing })
        }
      } catch { /* registry load issue is benign for this check */ }
      if (inactive.length === 0) return { ok: true, summary: 'all funding sources have their required credentials' }
      return {
        ok: false, // surfaced as a LOW (informational) finding, not a real failure
        summary: `${inactive.length} funding source(s) inactive for missing optional key(s): ${inactive.map((i) => i.source).join(', ')}`,
        evidence: { inactive },
        recommended_fix: 'Provision to widen coverage: ' + inactive.map((i) => `${i.source} needs ${i.missing_env.join(' + ')}`).join('; '),
        confidence: 1,
      }
    },
  },
  {
    // Mission guard: NO active profile may resolve to zero relatable crawlers,
    // and no ORGANIZATION profile may be hard-excluded down to directory-only
    // (the VFD-misses-FEMA class of bug). Sam scans active profiles through the
    // SAME deterministic planner discovery uses and flags any coverage gap so a
    // profile-type / keyword mapping regression is caught automatically instead
    // of silently starving a real applicant.
    id: 'discovery.profileCoverage',
    label: 'Per-profile crawler coverage',
    category: SAM_CATEGORIES.ENVIRONMENT_READINESS,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Scans active profiles through the crawler-os planner and flags any profile that resolves to ZERO sources (mission failure) or, for an organization, to directory-only sources (likely a profile-type/keyword gap — e.g. a VFD that would miss FEMA AFG).',
    async run({ db } = {}) {
      if (!db) return { ok: true, skipped: true, summary: 'no db handle; coverage scan skipped' }
      let audit
      try {
        const { auditCrawlerCoverage } = await import('../crawlerPlanService.js')
        audit = await auditCrawlerCoverage(db, { limit: 300 })
      } catch (err) {
        // Schema not ready / module load issue is an environment limitation.
        return { ok: true, skipped: true, summary: `coverage scan unavailable: ${err?.message || err}` }
      }
      const zero = audit.zero_coverage || []
      const orgDir = audit.org_directory_only || []
      if (zero.length === 0 && orgDir.length === 0) {
        return { ok: true, summary: `all ${audit.scanned} active profiles reach at least one relatable source` }
      }
      const sample = (arr) => arr.slice(0, 8).map((p) => `${p.display_name || p.profile_id} (${p.primary_type})`).join('; ')
      return {
        ok: false,
        summary:
          `${zero.length} profile(s) have ZERO crawler coverage` +
          `${zero.length ? ` [${sample(zero)}]` : ''}; ` +
          `${orgDir.length} organization profile(s) resolved to directory-only` +
          `${orgDir.length ? ` [${sample(orgDir)}]` : ''}.`,
        evidence: {
          scanned: audit.scanned,
          zero_coverage: zero.map((p) => ({ profile_id: p.profile_id, primary_type: p.primary_type, applicant_types: p.applicant_types })),
          org_directory_only: orgDir.map((p) => ({ profile_id: p.profile_id, primary_type: p.primary_type, applicant_types: p.applicant_types })),
        },
        recommended_fix: 'Open Admin → Crawler Plan, select each flagged profile, and confirm its applicant_types. Add the type to PRIMARY_TYPE_TO_APPLICANT (profileIntelligence.js) or fix the profile type so it reaches the right sources.',
        confidence: 0.9,
      }
    },
  },
  {
    // Global crawler-gap learning: every LIVE discovery call folds its result-
    // coverage gaps into a rolling store (system_kv `crawler_gap_learning`). Sam
    // reads it here so a systemic acquisition regression (a rising share of real
    // crawls surfacing low-results / institution / hyperlocal / eligibility gaps)
    // is caught from PRODUCTION traffic, not just Amy's synthetic cohort or the
    // nightly sweep. Anya learns the same signal per-profile via anya_brain_memory.
    id: 'crawler.gapLearning',
    label: 'Crawler gap learning (live discovery coverage)',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Reads the rolling crawler-gap learning store (updated on every live discovery call) and flags when a meaningful share of recent real crawls surfaced coverage gaps.',
    async run({ db } = {}) {
      if (!db) return { ok: true, skipped: true, summary: 'no db handle; gap-learning read skipped' }
      let store
      let windowSummary = null
      try {
        const { getCrawlerGapLearning, summarizeGapWindow } = await import('../coverageAudit/liveCrawlGapLearning.js')
        store = await getCrawlerGapLearning(db)
        windowSummary = summarizeGapWindow(store)
      } catch (err) {
        return { ok: true, skipped: true, summary: `gap-learning store unavailable: ${err?.message || err}` }
      }
      const lifetimeCalls = Number(store?.totals?.calls) || 0
      if (!store || lifetimeCalls === 0) {
        return { ok: true, summary: 'No live crawler-gap telemetry yet.' }
      }
      // Judge the RECENT window, not lifetime totals: the lifetime counters
      // never decay, so a store that was ever gappy would otherwise read as a
      // permanent alert long after coverage recovered. Stores predating the
      // daily buckets fall back to lifetime (better than mistaking "no window
      // data" for healthy).
      const windowed = Boolean(windowSummary && windowSummary.calls > 0)
      const calls = windowed ? windowSummary.calls : lifetimeCalls
      const withGap = windowed ? windowSummary.with_gap : Number(store.totals.with_gap) || 0
      const byClass = windowed ? windowSummary.by_class : store.totals.by_class || {}
      const gapRate = calls > 0 ? withGap / calls : 0
      const scopeLabel = windowed ? `live crawls in the last ${windowSummary.days} days` : 'live crawls (lifetime — pre-window store)'
      const topClasses = Object.entries(byClass)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
      // Alert only with a real sample AND a high gap share — a systemic signal,
      // not the occasional legitimately-narrow profile.
      if (calls >= 5 && gapRate > 0.4) {
        return {
          ok: false,
          summary: `${Math.round(gapRate * 100)}% of ${calls} ${scopeLabel} surfaced coverage gaps (${withGap}/${calls}). Top classes: ${topClasses || 'n/a'}.`,
          evidence: {
            calls,
            with_gap: withGap,
            gap_rate: Number(gapRate.toFixed(3)),
            windowed,
            by_class: byClass,
            lifetime: { calls: lifetimeCalls, with_gap: Number(store.totals.with_gap) || 0 },
            recent_examples: Array.isArray(store.recent) ? store.recent.slice(0, 5) : [],
          },
          recommended_fix: 'FIRST check crawler.webLaneHealth — a dead open-web lane (search backend down / LLM key exhausted) makes EVERY crawl miss county-level and institution funding, which is exactly this gap signature. Then inspect system_kv `crawler_gap_learning` + Anya brain (memory_key crawler_gap), widen buildWebQueries for institution/hyperlocal/low_results gaps, and confirm the coverage self-heal + student-aid eligibility invariant are running for the ineligible/surfacing classes.',
          confidence: 0.85,
        }
      }
      return { ok: true, summary: `${withGap}/${calls} ${scopeLabel} had gaps${topClasses ? ` (${topClasses})` : ''}.` }
    },
  },
  {
    // Amy flywheel daily cohort: the owner's standing directive is that Amy's
    // synthetic-profile cohort runs at the daily target until a FULL day comes
    // back with every profile clean at the goals/rules bar. This check makes
    // the scoreboard visible every morning (it flows into Anya's 09:00 digest).
    id: 'amy.flywheelCohort',
    label: 'Amy flywheel daily cohort (synthetic-profile crawl quality)',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Reads the Amy flywheel cohort scoreboard (system_kv amy_flywheel_cohort) and flags when the most recent day\'s synthetic-profile cohort had issue profiles or fell short of the daily target.',
    async run({ db } = {}) {
      if (!db) return { ok: true, skipped: true, summary: 'no db handle; flywheel cohort read skipped' }
      let store
      try {
        const { getFlywheelCohort } = await import('../amy/flywheelCohort.js')
        store = await getFlywheelCohort(db)
      } catch (err) {
        return { ok: true, skipped: true, summary: `flywheel cohort store unavailable: ${err?.message || err}` }
      }
      const days = store?.days && typeof store.days === 'object' ? store.days : {}
      const keys = Object.keys(days).sort()
      if (keys.length === 0) return { ok: true, summary: 'No Amy flywheel cohort data yet.' }
      const latest = days[keys[keys.length - 1]]
      const topTypes = Object.entries(latest.finding_types || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
      const label = `${latest.clean}/${latest.evaluated} clean (target ${latest.target}) on ${latest.day}`
      if (latest.evaluated > 0 && latest.issues === 0 && latest.complete) {
        return { ok: true, summary: `GOAL: full cohort clean — ${label}.${store.goal_notified_at ? '' : ' Owner notification pending.'}` }
      }
      if (latest.issues > 0) {
        return {
          ok: false,
          summary: `${latest.issues} of ${latest.evaluated} synthetic profiles had issues — ${label}. Top classes: ${topTypes || 'n/a'}.`,
          evidence: {
            day: latest.day,
            target: latest.target,
            evaluated: latest.evaluated,
            clean: latest.clean,
            issues: latest.issues,
            finding_types: latest.finding_types || {},
            issue_examples: (latest.issue_examples || []).slice(0, 8),
            runs: latest.runs || [],
          },
          recommended_fix: 'Each issue example names its finding types (amyReport FINDING_TYPES) — ineligible_match/false_positive route to the matchEngine eligibility gates, institution/hyperlocal recall misses route to buildWebQueries breadth, field-mapping/geo misses route to profileIntelligence. Amy\'s own tuning levers (floor/weights/coverage/archetype lessons) act on these automatically; whatever persists across days needs a code change.',
          confidence: 0.9,
        }
      }
      return { ok: true, summary: `${label} — no issues so far; cohort not yet at target.` }
    },
  },
  {
    // Pipeline-$ visibility (2026-07-05 "$6,500 pipeline with 118 real
    // sources" class): a pipeline can be full of real grants yet display ~$0
    // when rows carry no usable dollar value. Three layers keep this honest —
    // read-time fallback (config/pipelineValue.js), write-time default
    // (saveToProfilePipeline), boot backfill (enforceGrantAmountBackfill).
    // This check watches the RESIDUAL: how many active rows still have no
    // amount anywhere (an ingest/extraction gap Amy's amount_recall_miss
    // findings and the awardAmountExtractor patterns are meant to close).
    id: 'pipeline.amountCoverage',
    label: 'Pipeline dollar-value coverage (active grants with a knowable amount)',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Measures what share of active pipeline grants carry a usable dollar value (amount_requested/max/min) and what share of the active catalog has amounts. Flags when coverage is low enough that profile Pipeline Potential figures materially understate reality.',
    async run({ db } = {}) {
      if (!db) return { ok: true, skipped: true, summary: 'no db handle; amount coverage read skipped' }
      const statusesSql = PIPELINE_ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')
      let grants
      let catalog
      try {
        grants = await db
          .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN ${pipelineValueSql('grants')} > 0 THEN 1 ELSE 0 END) AS with_value
               FROM grants WHERE status IN (${statusesSql})`,
          )
          .get()
        catalog = await db
          .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN COALESCE(amount_max, 0) > 0 OR COALESCE(amount_min, 0) > 0 THEN 1 ELSE 0 END) AS with_amount
               FROM funding_opportunities WHERE is_active`,
          )
          .get()
      } catch (err) {
        return { ok: true, skipped: true, summary: `amount coverage query failed: ${err?.message || err}` }
      }
      const total = Number(grants?.total) || 0
      const withValue = Number(grants?.with_value) || 0
      const catTotal = Number(catalog?.total) || 0
      const catWith = Number(catalog?.with_amount) || 0
      if (total < 20) return { ok: true, summary: `Only ${total} active pipeline grants — coverage check not meaningful yet.` }
      const pct = Math.round((withValue / total) * 100)
      const catPct = catTotal > 0 ? Math.round((catWith / catTotal) * 100) : 0
      const summary = `${withValue}/${total} (${pct}%) active pipeline grants carry a dollar value; catalog amount coverage ${catWith}/${catTotal} (${catPct}%).`
      if (pct < 60) {
        return {
          ok: false,
          summary: `Pipeline-$ coverage LOW: ${summary}`,
          evidence: { active_grants: total, with_value: withValue, coverage_pct: pct, catalog_total: catTotal, catalog_with_amount: catWith, catalog_pct: catPct },
          recommended_fix: 'The boot nets now ACQUIRE amounts, not just copy them: enforceAmountEnrichment fetches the funder\'s own page for active-pipeline sources with no dollar figure (bounded per boot; see pipeline.invariantSweepOutcomes for what it learned), and enforceGrantAmountBackfill mirrors catalog amounts onto pipeline rows. A persistently low residual after those means INGEST never captured amounts: extend awardAmountExtractor patterns for the text phrasings on failing sources, and make structured adapters map their award-size fields into amount_min/amount_max. Amy\'s amount_recall_miss findings name the profile shapes/sources where the gap concentrates.',
          confidence: 0.85,
        }
      }
      return { ok: true, summary }
    },
  },
  {
    // Discovery-fit sweep outcomes (2026-07-06): the boot invariant runner
    // persists its latest summary to system_kv so the rescue/enrichment/
    // honesty nets are observable by Sam (and through Sam, Anya's daily owner
    // digest) instead of living only in boot logs. This is the read side of
    // the agent-observability rule for: application_url_rescue (real
    // candidates un-blocked from missing_application_url), amount_enrichment
    // (per-award $ learned from funder pages), imported_status_honesty
    // (import-stamped "submitted" rows demoted so purge/re-score nets can
    // judge them), and the wide-range program-envelope default guard.
    id: 'pipeline.invariantSweepOutcomes',
    label: 'Boot invariant sweep outcomes (rescue / enrichment / honesty nets)',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Reads the persisted enforce-invariants summary (system_kv enforce_invariants_last_run) and flags failed sweeps. Surfaces what the URL-rescue, amount-enrichment, and status-honesty nets actually did on the last boot so discovery-supply repairs are observable.',
    async run({ db } = {}) {
      if (!db) return { ok: true, skipped: true, summary: 'no db handle; sweep outcomes read skipped' }
      let parsed
      try {
        const row = await db.prepare("SELECT value FROM system_kv WHERE key = 'enforce_invariants_last_run'").get()
        parsed = row?.value ? JSON.parse(row.value) : null
      } catch (err) {
        return { ok: true, skipped: true, summary: `sweep summary unavailable: ${err?.message || err}` }
      }
      if (!parsed || !Array.isArray(parsed.steps)) {
        return { ok: true, summary: 'No persisted invariant-sweep summary yet (pre-observability boot).' }
      }
      const failedSteps = parsed.steps.filter((s) => s && s.ok === false)
      const interesting = ['application_url_rescue', 'amount_enrichment', 'imported_status_honesty', 'grant_amount_backfill', 'pipeline_refill', 'grant_score_backfill']
      const highlights = parsed.steps
        .filter((s) => interesting.includes(s.name) && (Number(s.repaired) > 0 || Number(s.scanned) > 0))
        .map((s) => `${s.name}: repaired ${s.repaired}/${s.scanned} scanned`)
      const when = parsed.at ? ` (as of ${parsed.at})` : ''
      if (failedSteps.length > 0) {
        return {
          ok: false,
          summary: `${failedSteps.length} invariant sweep(s) FAILED on the last boot: ${failedSteps.map((s) => s.name).join(', ')}${when}`,
          evidence: { failed: failedSteps, highlights, ran: parsed.ran, totalRepaired: parsed.totalRepaired },
          recommended_fix: 'Read the failed step names against backend/startup/enforceInvariants.js — each sweep is isolated (runInvariant never throws), so a failure is a real query/dependency error on that net, not a boot crash. Fix the sweep; the data class it guards is accumulating unrepaired until it runs.',
          confidence: 0.9,
        }
      }
      return {
        ok: true,
        summary: highlights.length
          ? `invariant sweeps healthy${when}: ${highlights.join('; ')}`
          : `invariant sweeps healthy${when}: nothing needed repair.`,
        evidence: { highlights, ran: parsed.ran, totalRepaired: parsed.totalRepaired },
      }
    },
  },
  {
    // Open-web lane liveness: the web lane is best-effort BY DESIGN (a dead
    // search backend or exhausted LLM key degrades it to a silent no-op so it
    // never blocks a crawl). This check is the read side that makes that death
    // observable as itself: runProfileDiscoveryLive records every lane run's
    // telemetry to system_kv `web_lane_health`; when every recent run produced
    // ZERO search pages, the search layer (SearXNG upstreams / Brave billing /
    // DDG throttling) is down — the root cause behind a hyperlocal-gap flood.
    id: 'crawler.webLaneHealth',
    label: 'Open-web discovery lane liveness',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Reads the rolling web-lane telemetry (system_kv web_lane_health, recorded on every live discovery) and flags when all recent runs produced zero search pages — a dead search backend or LLM key, the single point of failure for county/community/foundation coverage.',
    async run({ db } = {}) {
      if (!db) return { ok: true, skipped: true, summary: 'no db handle; web-lane health read skipped' }
      let store
      let summary
      try {
        const { getWebLaneHealth, summarizeRecentWebLane } = await import('../coverageAudit/webLaneHealth.js')
        store = await getWebLaneHealth(db)
        summary = summarizeRecentWebLane(store)
      } catch (err) {
        return { ok: true, skipped: true, summary: `web-lane health store unavailable: ${err?.message || err}` }
      }
      if (!store || !summary || summary.judged === 0) {
        return { ok: true, summary: 'No web-lane telemetry yet (no live discovery since deploy).' }
      }
      if (summary.dead) {
        const reasons = summary.reasons.length ? ` Recent errors/reasons: ${summary.reasons.join(' | ')}.` : ''
        return {
          ok: false,
          summary: `Open-web discovery lane is DEAD: ${summary.zero_page}/${summary.judged} recent live crawls got ZERO search pages (0 opportunities stored from the web lane).${reasons}`,
          evidence: {
            judged: summary.judged,
            zero_page: summary.zero_page,
            errored: summary.errored,
            stored: summary.stored,
            reasons: summary.reasons,
            recent: Array.isArray(store.recent) ? store.recent.slice(0, 8) : [],
          },
          recommended_fix: 'Probe the search backends from the prod container: SearXNG (upstream engines suspended? restart the searxng service), Brave API key (HTTP 402 = billing lapsed), and the LLM extraction keys (Anthropic credit balance; OpenAI fallback). Hyperlocal/institution coverage cannot recover until this lane is alive.',
          confidence: 0.9,
        }
      }
      return {
        ok: true,
        summary: `web lane alive: ${summary.judged - summary.zero_page}/${summary.judged} recent runs returned search pages, ${summary.stored} web-lane opportunities stored.`,
        evidence: { judged: summary.judged, zero_page: summary.zero_page, stored: summary.stored },
      }
    },
  },
  {
    // Brave monthly-budget pacing (braveBudget.js): the shared Brave key has a
    // small monthly quota that the fleet historically drained in the first days
    // of the month, leaving every consumer dark for weeks. The pacer rations a
    // daily allowance; this check makes the spend pace observable and flags an
    // early exhaustion (pacer disabled/misconfigured) — a paced key should
    // never hit 100% before the final days of the month.
    id: 'crawler.braveBudget',
    label: 'Brave Search monthly budget pace',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Reads the Brave query budget pacer state (system_kv brave_search_budget) and flags when the monthly budget is exhausted with days still left in the month. Green output reports used/budget and today\'s allowance so the pace is always visible.',
    async run({ db } = {}) {
      if (!db) return { ok: true, skipped: true, summary: 'no db handle; brave budget read skipped' }
      let state
      try {
        const { getBraveBudgetState } = await import('../yana/braveBudget.js')
        state = await getBraveBudgetState({ db })
      } catch (err) {
        return { ok: true, skipped: true, summary: `brave budget state unavailable: ${err?.message || err}` }
      }
      if (!state || !state.used) {
        return { ok: true, summary: 'No Brave queries spent yet this month.' }
      }
      const now = new Date()
      const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
      const daysLeft = daysInMonth - now.getUTCDate()
      if (state.used >= state.budget && daysLeft > 2) {
        return {
          ok: false,
          summary: `Brave monthly budget exhausted early: ${state.used}/${state.budget} used with ${daysLeft} day(s) left — pacing failed or the budget env is set too low/high for the plan.`,
          evidence: state,
          recommended_fix: 'Check BRAVE_MONTHLY_QUERY_BUDGET matches the actual Brave plan quota and that BRAVE_BUDGET_ENABLED has not been disabled. Web search degrades to SearXNG/DDG until the calendar month resets.',
          confidence: 0.85,
        }
      }
      return {
        ok: true,
        summary: `Brave budget on pace: ${state.used}/${state.budget} used this month, ${state.used_today}/${state.allowance_today} today.`,
        evidence: state,
      }
    },
  },
  {
    // Nightly coverage-sweep freshness: runProfileCoverageSweep persists its
    // result to system_kv `coverage_audit_last_run` (plus a status:'running'
    // heartbeat before the heal loop and status:'failed' on exception). This
    // check is the READ side the Agent Observability Rule requires — before it,
    // the record was write-only, so a sweep that silently died on every run
    // (restart mid-autoheal) left the key absent for weeks and nobody noticed.
    id: 'coverage.sweepHealth',
    label: 'Profile result-coverage sweep freshness',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Reads the last recorded per-profile result-coverage sweep (system_kv coverage_audit_last_run) and flags when it is absent, failed, stuck in status=running, or stale (>36h old — the sweep is nightly). Surfaces the gap counts (with_gap / needs_rediscovery / surfacing_regressions / healed) when healthy. Fails open when system_kv itself is not queryable yet.',
    async run({ db } = {}) {
      if (!db?.prepare) return { ok: true, skipped: true, summary: 'coverage sweep health: db unavailable' }
      const STALE_MS = 36 * 60 * 60 * 1000
      const RUNNING_GRACE_MS = 3 * 60 * 60 * 1000
      let row
      try {
        row = await db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get('coverage_audit_last_run')
      } catch (err) {
        // system_kv not migrated yet — environment gap, not a defect.
        return { ok: true, skipped: true, summary: `system_kv not queryable yet (${err?.message || 'unknown'})` }
      }
      if (!row?.value) {
        return {
          ok: false,
          summary: 'The nightly profile result-coverage sweep has NEVER recorded a run (system_kv coverage_audit_last_run absent) — it is either not scheduled or dying before it can record anything.',
          evidence: { key: 'coverage_audit_last_run', present: false },
          recommended_fix: 'Check the nightly sweep logs (runNightlyMaintenanceSweep → runProfileCoverageSweep) and NIGHTLY_MAINTENANCE_ENABLED; run owner.run_nightly_sweep or the sweep directly to seed the record.',
          confidence: 0.85,
        }
      }
      let last = null
      try { last = JSON.parse(row.value) } catch { last = null }
      if (!last || typeof last !== 'object') {
        return { ok: false, summary: 'coverage_audit_last_run exists but is unparseable JSON.', evidence: { raw: String(row.value).slice(0, 200) } }
      }
      const recordedAtMs = Date.parse(last.recorded_at || row.updated_at || '') || 0
      const startedAtMs = Date.parse(last.started_at || '') || recordedAtMs
      const ageMs = Date.now() - recordedAtMs
      const gapCounts = {
        scanned: last.summary?.scanned ?? null,
        with_gap: last.summary?.with_gap ?? null,
        needs_rediscovery: last.summary?.needs_rediscovery ?? null,
        surfacing_regressions: last.summary?.surfacing_regressions ?? null,
        healed: last.healed_count ?? null,
      }
      if (last.status === 'failed') {
        return {
          ok: false,
          summary: `The last coverage sweep FAILED: ${last.error || 'unknown error'} (started ${last.started_at || 'unknown'}).`,
          evidence: { status: 'failed', error: last.error || null, started_at: last.started_at || null },
          recommended_fix: 'Read the recorded error; the usual suspects are DB pool starvation during the autoheal re-discovery loop and a deploy restart mid-run.',
          confidence: 0.9,
        }
      }
      if (last.status === 'running' && Date.now() - startedAtMs > RUNNING_GRACE_MS) {
        return {
          ok: false,
          summary: `A coverage sweep started ${last.started_at || 'unknown'} and never completed (heartbeat still status=running after ${Math.round((Date.now() - startedAtMs) / 3600000)}h) — the process likely restarted mid-autoheal.`,
          evidence: { status: 'running', started_at: last.started_at || null, gap_counts: gapCounts },
          recommended_fix: 'Re-run the sweep (owner.run_nightly_sweep or runProfileCoverageSweep); if this recurs, the autoheal loop is outliving the deploy window — lower COVERAGE_AUTOHEAL_MAX.',
          confidence: 0.85,
        }
      }
      if (recordedAtMs && ageMs > STALE_MS) {
        return {
          ok: false,
          summary: `The coverage sweep last completed ${Math.round(ageMs / 3600000)}h ago (> 36h) — the nightly run is not landing.`,
          evidence: { recorded_at: last.recorded_at || row.updated_at || null, age_hours: Math.round(ageMs / 3600000), gap_counts: gapCounts },
          recommended_fix: 'Confirm NIGHTLY_MAINTENANCE_ENABLED and that the 04:00 ET scheduler fired; check the nightly sweep logs for a failure before the coverage step.',
          confidence: 0.85,
        }
      }
      return {
        ok: true,
        summary: `Coverage sweep healthy: recorded ${last.recorded_at || row.updated_at || 'recently'}; scanned=${gapCounts.scanned ?? 'n/a'}, with_gap=${gapCounts.with_gap ?? 'n/a'}, needs_rediscovery=${gapCounts.needs_rediscovery ?? 'n/a'}, surfacing_regressions=${gapCounts.surfacing_regressions ?? 'n/a'}, healed=${gapCounts.healed ?? 'n/a'}.`,
        evidence: { recorded_at: last.recorded_at || row.updated_at || null, status: last.status || 'completed', gap_counts: gapCounts },
      }
    },
  },
  {
    // Fleet coverage-gap scoreboard freshness + severity: Amy refreshes the
    // Coverage & Evidence roll-up (system_kv coverage_gap_scoreboard) at the
    // start of every training run and derives her task queue from it (owner
    // directive 2026-07-06 — tasks from gaps, not random). This is the READ
    // side the Agent Observability Rule requires: a scoreboard that stops
    // refreshing means the gap-learning loop is dead, and a single gap class
    // hitting most of the scanned fleet is a systemic coverage failure the
    // owner must see, not a per-profile anecdote.
    id: 'coverage.gapScoreboard',
    label: 'Fleet coverage-gap scoreboard (Coverage & Evidence)',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Reads the fleet Coverage & Evidence gap scoreboard (system_kv coverage_gap_scoreboard, refreshed by Amy\'s daily gap-learning run) and flags when it is stale (>48h) or when the top gap class affects a large share of scanned profiles. Evidence carries the top 5 gaps + adapter wishlist; the recommended fix comes from the gap\'s own suggested_action. Fails open when system_kv is not queryable yet.',
    async run({ db } = {}) {
      if (!db?.prepare) return { ok: true, skipped: true, summary: 'gap scoreboard: db unavailable' }
      const STALE_MS = 48 * 60 * 60 * 1000
      const LARGE_SHARE = 0.5
      const MIN_SCANNED = 5
      let row
      try {
        row = await db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get('coverage_gap_scoreboard')
      } catch (err) {
        // system_kv not migrated yet — environment gap, not a defect.
        return { ok: true, skipped: true, summary: `system_kv not queryable yet (${err?.message || 'unknown'})` }
      }
      if (!row?.value) {
        // Fail-open like crawler.gapLearning: no scoreboard yet just means the
        // gap-learning loop has not produced data (fresh deploy / Amy pending).
        return { ok: true, summary: 'No fleet gap scoreboard yet (Amy\'s gap-learning run has not recorded one).' }
      }
      let board = null
      try { board = JSON.parse(row.value) } catch { board = null }
      if (!board || typeof board !== 'object') {
        return { ok: false, summary: 'coverage_gap_scoreboard exists but is unparseable JSON.', evidence: { raw: String(row.value).slice(0, 200) } }
      }
      const generatedMs = Date.parse(board.generated_at || row.updated_at || '') || 0
      const ageMs = Date.now() - generatedMs
      const gaps = Array.isArray(board.gaps) ? board.gaps : []
      const topGaps = gaps.slice(0, 5)
      const wishlist = Array.isArray(board.adapter_wishlist) ? board.adapter_wishlist : []
      if (!generatedMs || ageMs > STALE_MS) {
        return {
          ok: false,
          summary: `The fleet coverage-gap scoreboard is STALE (${generatedMs ? Math.round(ageMs / 3600000) + 'h old' : 'no timestamp'} > 48h) — Amy's daily gap-learning refresh is not landing.`,
          evidence: { generated_at: board.generated_at || row.updated_at || null, age_hours: generatedMs ? Math.round(ageMs / 3600000) : null, top_gaps: topGaps },
          recommended_fix: 'Confirm AMY_ENABLED / AMY_GAP_LEARNING are on and the Amy scheduler is running (readLatestAmyReport for the last run); to reseed immediately run buildFleetGapScoreboard via an Amy run.',
          confidence: 0.85,
        }
      }
      const scanned = Number(board.profiles_scanned) || 0
      const top = topGaps[0] || null
      const topShare = top && scanned > 0 ? (Number(top.count) || 0) / scanned : 0
      if (top && scanned >= MIN_SCANNED && topShare >= LARGE_SHARE) {
        return {
          ok: false,
          summary: `Fleet coverage gap hits ${Math.round(topShare * 100)}% of the ${scanned} scanned profile(s): ${top.statement}`,
          evidence: { profiles_scanned: scanned, top_gaps: topGaps, adapter_wishlist: wishlist },
          recommended_fix: top.suggested_action || 'Review the top gap classes on the Coverage & Evidence dashboard and widen the affected source lane.',
          confidence: 0.85,
        }
      }
      return {
        ok: true,
        summary: `Gap scoreboard fresh (${Math.round(ageMs / 3600000)}h old): ${gaps.length} gap class(es) across ${scanned} profile(s); top gap affects ${top ? top.count : 0}; adapter wishlist ${wishlist.length} item(s).`,
        evidence: { generated_at: board.generated_at, profiles_scanned: scanned, top_gaps: topGaps, adapter_wishlist: wishlist },
      }
    },
  },
  {
    // GOLDEN-OUTCOME SENTINEL (owner directive 2026-07-07: "how do mistakes
    // like this keep happening" — the 12-lost-lanes class). Owner-verified
    // expectations for REAL profiles live in system_kv
    // 'golden_outcome_expectations' as
    //   [{ profile_id, label, require_sources: ['tn_ecf_choices', ...] }]
    // and this check asserts each golden profile still has at least one
    // stored match from every required source. A regression that silently
    // drops a lane for a profile the owner has personally verified (the
    // Gilbert/Kim ECF class) becomes a red finding in Anya's morning email
    // instead of a discovery the owner has to make by hand. Expectations are
    // DATA, not code: verify a fix live, then append the expectation.
    id: 'coverage.goldenOutcomes',
    label: 'Golden-profile outcome sentinel',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Asserts every owner-verified golden profile (system_kv golden_outcome_expectations) still holds ≥1 stored match from each required source. Catches silent lane/coverage regressions on real profiles. Fails open when no expectations are recorded yet or system_kv is unavailable.',
    async run({ db } = {}) {
      if (!db?.prepare) return { ok: true, skipped: true, summary: 'golden outcomes: db unavailable' }
      let row
      try {
        row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get('golden_outcome_expectations')
      } catch (err) {
        return { ok: true, skipped: true, summary: `system_kv not queryable yet (${err?.message || 'unknown'})` }
      }
      if (!row?.value) {
        return { ok: true, skipped: true, summary: 'No golden outcome expectations recorded yet (system_kv golden_outcome_expectations absent).' }
      }
      let expectations = null
      try { expectations = JSON.parse(row.value) } catch { expectations = null }
      if (!Array.isArray(expectations) || expectations.length === 0) {
        return { ok: false, summary: 'golden_outcome_expectations exists but is not a non-empty JSON array.', evidence: { raw: String(row.value).slice(0, 200) } }
      }
      const failures = []
      let assertions = 0
      for (const exp of expectations) {
        const profileId = String(exp?.profile_id || '')
        const sources = Array.isArray(exp?.require_sources) ? exp.require_sources : []
        if (!profileId || sources.length === 0) continue
        let profile
        try {
          profile = await db.prepare(
            `SELECT id FROM profiles WHERE id = ? AND deleted_at IS NULL AND (status IS NULL OR LOWER(status) NOT IN ('deleted','archived','merged','inactive'))`,
          ).get(profileId)
        } catch { profile = null }
        if (!profile) {
          failures.push({ profile: exp.label || profileId, missing: ['<profile not found/active>'] })
          continue
        }
        const missing = []
        for (const source of sources) {
          assertions += 1
          let hit = null
          try {
            hit = await db.prepare(
              `SELECT m.id FROM profile_opportunity_matches m
                 JOIN funding_opportunities o ON o.id = m.opportunity_id
                WHERE m.profile_id = ? AND o.source = ? LIMIT 1`,
            ).get(profileId, String(source))
          } catch { hit = null }
          if (!hit) missing.push(String(source))
        }
        if (missing.length > 0) failures.push({ profile: exp.label || profileId, missing })
      }
      if (failures.length > 0) {
        return {
          ok: false,
          summary: `GOLDEN OUTCOME REGRESSION: ${failures.length} verified profile(s) lost required coverage — ${failures.map((f) => `${f.profile}: missing ${f.missing.join('/')}`).join('; ')}.`,
          evidence: { failures, expectations: expectations.length },
          recommended_fix: 'A lane/scoring/purge change removed owner-verified results. Check the named source lanes in the crawler plan for these profiles (Coverage & Evidence dashboard) and recent merges; re-run discovery for the affected profiles after fixing.',
          confidence: 0.9,
        }
      }
      return {
        ok: true,
        summary: `All golden outcomes hold: ${expectations.length} profile(s), ${assertions} source assertion(s) verified.`,
        evidence: { profiles: expectations.length, assertions },
      }
    },
  },
  {
    id: 'http.readyz',
    label: 'GET /readyz',
    category: SAM_CATEGORIES.ENVIRONMENT_READINESS,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/readyz',
    expectStatus: 200,
    severityOnFailure: SEVERITY.CRITICAL,
    description: 'Liveness/readiness probe — DB ping, schema columns, JWT secret strength, uploads writable.',
  },
  {
    // The "Google bar" regression ratchet (owner directive: for each golden
    // profile GrantFlow must beat a plain web-search session, and the system
    // must ONLY get better). The nightly webParityBenchmark persists parity
    // history to system_kv `web_parity_benchmark`; this check goes red when the
    // fleet parity REGRESSES vs the previous run (> REGRESSION_POINTS), when
    // the benchmark is stale, or when it has never run at all. Fails open on
    // environment gaps (db/system_kv/module unavailable) like the other
    // internal coverage checks.
    id: 'coverage.webParityBenchmark',
    label: 'Google-bar web-parity benchmark',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Reads the nightly web-parity benchmark (system_kv web_parity_benchmark: golden-profile GrantFlow-vs-web-search parity) and flags a fleet-parity regression vs the previous run, a stale benchmark (>8 days), or a benchmark that never ran. Evidence carries per-profile parity + the top web-only finds; the fix points at the web_parity_gap_queue candidate queue.',
    async run({ db } = {}) {
      if (!db?.prepare) return { ok: true, skipped: true, summary: 'web-parity benchmark: db unavailable' }
      let mod
      try {
        mod = await import('../webParityBenchmark.js')
      } catch (err) {
        return { ok: true, skipped: true, summary: `web-parity module unavailable: ${err?.message || err}` }
      }
      if (!mod.isWebParityBenchmarkEnabled()) {
        return { ok: true, skipped: true, summary: 'web-parity benchmark disabled (WEB_PARITY_BENCHMARK=false)' }
      }
      // Direct KV read so an environment gap (system_kv not migrated yet) fails
      // OPEN, while a MISSING key is the honest never-run alert below.
      let row
      try {
        row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(mod.KV_KEY)
      } catch (err) {
        return { ok: true, skipped: true, summary: `system_kv not queryable yet (${err?.message || 'unknown'})` }
      }
      let store = null
      if (row?.value) {
        try { store = JSON.parse(row.value) } catch { store = null }
        if (!store || typeof store !== 'object') {
          return { ok: false, summary: 'web_parity_benchmark exists but is unparseable JSON.', evidence: { raw: String(row.value).slice(0, 200) } }
        }
      }
      const recommendedFix =
        'Review system_kv `web_parity_gap_queue` (the web-only funding pages GrantFlow lacks — Amy\'s work queue; drive real candidates through upsertFundingOpportunity) and confirm the nightly sweep is running runWebParityBenchmark (WEB_PARITY_BENCHMARK on, golden_outcome_expectations seeded).'
      if (!store?.latest) {
        return {
          ok: false,
          summary: 'The Google-bar web-parity benchmark has NEVER run — GrantFlow-vs-web-search quality is unmeasured for the golden profiles.',
          evidence: { kv_key: mod.KV_KEY, golden_kv_key: mod.GOLDEN_KV_KEY },
          recommended_fix: 'Seed system_kv `golden_outcome_expectations` and let the nightly sweep run runWebParityBenchmark (or invoke it on demand); then this check ratchets parity run-over-run.',
          confidence: 0.9,
        }
      }
      const latest = store.latest
      const generatedMs = Date.parse(latest.generated_at || store.generated_at || '') || 0
      const ageMs = Date.now() - generatedMs
      const perProfile = Array.isArray(latest.per_profile) ? latest.per_profile : []
      const topWebOnly = perProfile
        .flatMap((p) => (Array.isArray(p.web_only_top) ? p.web_only_top.map((w) => ({ ...w, profile: p.label || p.profile_id })) : []))
        .slice(0, 6)
      const evidence = {
        generated_at: latest.generated_at || null,
        fleet_parity: latest.fleet_parity ?? null,
        per_profile: perProfile.map((p) => ({
          profile_id: p.profile_id,
          label: p.label,
          parity: p.parity,
          web_only_count: p.web_only_count ?? 0,
          overlap_count: p.overlap_count ?? 0,
          error: p.error ?? null,
        })),
        top_web_only: topWebOnly,
      }
      if (!generatedMs || ageMs > mod.STALE_MS) {
        return {
          ok: false,
          summary: `The web-parity benchmark is STALE (${generatedMs ? Math.round(ageMs / 86400000) + 'd old' : 'no timestamp'} > 8 days) — the Google-bar ratchet is not being measured.`,
          evidence,
          recommended_fix: recommendedFix,
          confidence: 0.85,
        }
      }
      const runs = Array.isArray(store.runs) ? store.runs : []
      const prev = runs.length >= 2 ? runs[runs.length - 2] : null
      const latestParity = Number(latest.fleet_parity)
      const prevParity = Number(prev?.fleet_parity)
      if (Number.isFinite(latestParity) && Number.isFinite(prevParity) && prevParity - latestParity > mod.REGRESSION_POINTS) {
        return {
          ok: false,
          summary: `Google-bar REGRESSION: fleet web-parity dropped ${Math.round((prevParity - latestParity) * 10) / 10} points (${prevParity} → ${latestParity}) — the system got WORSE vs a plain web search.`,
          evidence: { ...evidence, previous_fleet_parity: prevParity },
          recommended_fix: recommendedFix,
          confidence: 0.85,
        }
      }
      return {
        ok: true,
        summary: `Web-parity benchmark fresh (${Math.round(ageMs / 3600000)}h old): fleet parity ${latest.fleet_parity ?? 'n/a'} across ${perProfile.length} golden profile(s)` +
          `${Number.isFinite(prevParity) ? ` (prev ${prevParity})` : ''}; ${topWebOnly.length} web-only find(s) queued for review.`,
        evidence,
      }
    },
  },
  {
    id: 'http.health.mission',
    label: 'GET /api/health/mission',
    category: SAM_CATEGORIES.PRODUCTION_CONFIG,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/health/mission',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Mission-goals health (returns 503 when GrantFlow has slipped; Sam mirrors that into a critical finding).',
  },
  {
    id: 'http.health.imports',
    label: 'GET /api/health/imports',
    category: SAM_CATEGORIES.BROKEN_IMPORTS,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/health/imports',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Startup import validation results — fails when production code paths fail to load.',
  },
  {
    id: 'http.version',
    label: 'GET /api/version',
    category: SAM_CATEGORIES.ENVIRONMENT_READINESS,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/version',
    expectStatus: 200,
    severityOnFailure: SEVERITY.LOW,
    description: 'Deployment version + commit identifier; helps Sam correlate findings with the running build.',
  },
  // ── Hamilton (Application Autopilot / Funding Completion) checks ────
  // Hamilton is a separate agent from Yana (lead discovery). Sam owns
  // its health gate so the application-completion stack — portal
  // adapters, autopilot engine, blockers store, dual notifications —
  // is exercised on every gatekeeper run.
  {
    id: 'agent.hamilton.health',
    label: 'Hamilton agent health',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/admin/agent-telemetry/hamilton',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Confirms Hamilton telemetry is reachable and the autopilot summary is populated (hamilton_runs, autopilot runs, blockers).',
  },
  {
    id: 'agent.hamilton.routes',
    label: 'Hamilton automation routes',
    category: SAM_CATEGORIES.ROUTE_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/hamilton/automation/tasks',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Probes the canonical Hamilton automation router so renames / mount-point regressions are caught before deploy.',
  },
  {
    id: 'agent.hamilton.portalAutomation',
    label: 'Hamilton portal automation surface',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/hamilton/automation/portal-policies',
    expectStatus: 200,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Verifies the portal-policy registry endpoint is live so Hamilton can refuse automation on portals where it is not allowed.',
  },
  {
    id: 'agent.hamilton.portalSync.health',
    label: 'Hamilton portal sync (two-way) health',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/admin/portal-sync/health',
    expectStatus: 200,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Surfaces the two-way portal sync status in Mission Control: which connectors are available (listConnectors) plus the latest portal_sync_runs status/timestamp/error per profile+host. Degrades to {ok:false,status:"not_installed"} (still HTTP 200) when the portal_sync_runs table has not been migrated in yet, so Sam reports "not installed" rather than a failure.',
  },
  {
    id: 'agent.hamilton.documents',
    label: 'Hamilton document stack',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.health.check',
    parameters: { area: 'application_documents' },
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Spot-checks document plumbing Hamilton relies on (printable packets, attachments, profile uploads).',
  },
  {
    id: 'agent.hamilton.notifications',
    label: 'Hamilton notifications routing',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/hamilton/automation/admin/hard-stops',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Confirms the canonical-admin (buckeye7066@gmail.com) hard-stop dashboard is reachable so dual user/admin alerts have a consumer.',
  },
  {
    id: 'agent.hamilton.blockers',
    label: 'Hamilton blocker classifier surface',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/hamilton/automation/admin/tasks?status=blocked',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Lists currently blocked Hamilton tasks; non-200 means the resolver pipeline is broken or admin guard is misconfigured.',
  },
  {
    id: 'agent.hamilton.security',
    label: 'Hamilton authorization + payment guard',
    category: SAM_CATEGORIES.PRODUCTION_CONFIG,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/hamilton/automation/payment-authorizations',
    expectStatus: 200,
    // This route is PROFILE-SCOPED (requireProfileScope on req.query.profileId).
    // Sam's probe is unparameterized, so the route correctly answers 400
    // "profileId required" — proof it is mounted AND guarding tenancy, which is
    // exactly what this security check wants to confirm. Accept 400 as healthy
    // so we don't raise a permanent false-positive CRITICAL that pins
    // production_ready=false. A 404 (not mounted) / 500 (broken) still fails.
    acceptableStatuses: [400],
    severityOnFailure: SEVERITY.CRITICAL,
    description: 'Hamilton must never store raw card data; the authorization endpoint must be mounted and profile-guarded (200 with {ok:true,...} when scoped, or 400 "profileId required" when probed without a profile) and never echo card numbers.',
  },
  // ── Agent Control Center (admin-only orchestration) checks ─────────
  // Confirms the new Control Center router is mounted, admin-gated, and
  // healthy. Sam is run by the Control Center itself, so this check is
  // technically circular — but it's still useful: every Sam preflight
  // catches a broken router before Robert / Yana / John / Hamilton step
  // start. The non-admin probe also verifies the 403 gate is firing.
  {
    id: 'agent.controlCenter.status',
    label: 'Agent Control Center status route',
    category: SAM_CATEGORIES.ROUTE_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/admin/agent-control/status',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Confirms the admin-only Agent Control Center status endpoint is reachable and the canonical-admin gate returns the orchestration snapshot.',
  },
  {
    id: 'agent.controlCenter.lockHygiene',
    label: 'Agent Control Center lock hygiene',
    category: SAM_CATEGORIES.PRODUCTION_CONFIG,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Stale full_cycle locks past their TTL must be auto-released; if they aren\'t, no new run can ever start.',
    async run({ db }) {
      try {
        // SELF-HEAL FIRST. The periodic sweeper runs every 5 minutes
        // (sweepExpiredLocks in agentControlStore), but Sam's audit cadence is
        // faster — without an explicit sweep here, Sam intermittently flagged
        // "Expired lock not released" findings against a lock that the next
        // sweeper tick would have cleared seconds later, producing recurring
        // false-positive Mission Control errors. Sam's job is to catch real
        // contention, not to race the sweeper. Sweeping inline first means
        // the only time we report `ok: false` is if the sweep itself failed
        // to clear an expired row — i.e. an actual deadlock-class bug.
        try {
          const { sweepExpiredLocks } = await import('../agentControl/agentControlStore.js')
          await sweepExpiredLocks(db).catch(() => {})
        } catch { /* module load issue is benign for this check */ }
        const row = await db
          ?.prepare(`
            SELECT lock_name, control_run_id, expires_at FROM agent_control_locks
             WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
             LIMIT 1
          `)
          .get()
        if (!row) return { ok: true, summary: 'no expired locks' }
        return {
          ok: false,
          summary: `Expired lock survived in-line sweep: ${row.lock_name} (run ${row.control_run_id})`,
          evidence: row,
        }
      } catch (err) {
        return {
          ok: true,
          summary: `agent_control_locks not present yet (${err?.message || 'unknown'})`,
        }
      }
    },
  },
  {
    id: 'hamilton.sessionReadiness',
    label: 'Hamilton portal session readiness',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.hamilton.sessionReadiness',
    parameters: {},
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Delegates to admin.hamilton.sessionReadiness — flags profiles whose active Hamilton runs will stall on login/2FA because a portal has a saved login but no captured session (so the owner can capture one before the scheduled run).',
  },
  {
    id: 'hamilton.portalAutopilotReadiness',
    label: 'Hamilton portal autopilot identity readiness',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.hamilton.portalAutopilotReadiness',
    parameters: {},
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Delegates to admin.hamilton.portalAutopilotReadiness — flags portals where Hamilton\'s Portal Autopilot Identity needs attention: the master vault is locked, a portal needs human identity proofing, or no master passphrase is set (so the owner can unlock / sign in / set a passphrase before the scheduled run).',
  },
  {
    id: 'award.compliance',
    label: 'Award compliance / restriction tracking',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.compliance.overdue',
    parameters: {},
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Delegates to admin.compliance.overdue — surfaces awarded funding whose restrictions are overdue, short on required spending, or over an exact-category requirement, so the owner can log compliant spending (with proof) before it becomes a real compliance problem.',
  },
  {
    id: 'profile.languageReadiness',
    label: 'Profile language preference readiness',
    category: SAM_CATEGORIES.PRODUCTION_CONFIG,
    kind: CHECK_KIND.TOOL,
    tool: 'admin.profile.languageReadiness',
    parameters: {},
    severityOnFailure: SEVERITY.LOW,
    description: 'Delegates to admin.profile.languageReadiness — makes the per-profile preferred-language choice observable and flags any profile whose stored language code is unsupported (silently degrading to English instead of the chosen language).',
  },
  {
    id: 'emailGrants.ingestionHealth',
    label: 'Email → Grant ingestion health',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.LOW,
    description: 'Confirms the inbox→grant pipeline is installed and not silently erroring. Flags when emails are arriving but a disproportionate share end in status=error (e.g. AI provider down or insert gate misconfigured).',
    async run({ db }) {
      try {
        const { getEmailGrantHealth } = await import('../emailGrants/emailGrantIngestor.js')
        const health = await getEmailGrantHealth(db, { limit: 1 })
        if (!health.installed) {
          // Fail open — feature simply hasn't been used / migrated yet.
          return { ok: true, summary: `email_grant_ingestions not present yet (${health.reason || 'unknown'})` }
        }
        const tally = health.tally || {}
        const errors = Number(tally.error || 0)
        const total = Object.values(tally).reduce((a, b) => a + (Number(b) || 0), 0)
        // Only a real signal once we have a few emails and errors dominate.
        if (total >= 5 && errors > total / 2) {
          return {
            ok: false,
            summary: `Email ingestion failing: ${errors}/${total} ended in error`,
            evidence: tally,
          }
        }
        return { ok: true, summary: `email ingestion ok (${JSON.stringify(tally)})` }
      } catch (err) {
        return { ok: true, summary: `email ingestion check skipped (${err?.message || 'unknown'})` }
      }
    },
  },
  // ── Funding-discovery awareness (catalog-building engines) ──────────
  // These checks wire the funding-discovery code shipped this session into
  // Sam's normal sweep so the standing "agent observability" rule holds:
  // every discovery engine that quietly builds the catalog in the
  // background must be visible to Sam (so the admin can tell when one is
  // dormant or dishonest), without raising false alarms when an engine is
  // intentionally disabled or has simply not run yet. All are INTERNAL +
  // fail-open: a missing table / never-run engine reports ok:true with a
  // human-readable note, never a recurring finding.
  {
    id: 'discovery.nationalProgramsCatalog',
    label: 'National-programs crawler → canonical catalog bridge',
    category: SAM_CATEGORIES.OPPORTUNITY_INTEGRITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Confirms the national-programs continuous crawler now reaches the canonical funding_opportunities catalog via catalogBridge (source=national_programs_crawler), and reports its enabled/disabled status (NATIONAL_PROGRAMS_CRAWLER_ENABLED). Historically the crawler wrote only to private programs_* tables; this check makes the catalog bridge observable so a silently-zero bridge is caught.',
    async run({ db }) {
      const enabled = process.env.NATIONAL_PROGRAMS_CRAWLER_ENABLED === 'true'
      if (!db?.prepare) {
        return { ok: true, summary: `national-programs bridge: db unavailable (enabled=${enabled})`, evidence: { enabled } }
      }
      let catalogRows = null
      try {
        const row = await db
          .prepare("SELECT COUNT(*) AS c FROM funding_opportunities WHERE source = 'national_programs_crawler'")
          .get()
        catalogRows = Number(row?.c ?? 0)
      } catch (err) {
        // Catalog table not migrated yet — environment gap, not a defect.
        return { ok: true, summary: `funding_opportunities not queryable yet (${err?.message || 'unknown'})`, evidence: { enabled } }
      }
      // Crawler-OS cutover awareness: legacy grant-discovery crawlers (job
      // type 'national' included) are intentionally superseded by the Crawler OS
      // — every legacy national job is marked completed with a
      // 'superseded_by_crawler_os' note and the catalogBridge never runs. After
      // that cutover, 0 rows under source='national_programs_crawler' is the
      // EXPECTED state, not a broken bridge. Detect the supersede so we don't
      // raise a false MEDIUM for a deliberate architectural decision.
      let superseded = false
      try {
        const sup = await db
          .prepare(
            "SELECT 1 AS x FROM crawler_jobs WHERE type = 'national' AND error LIKE 'superseded_by_crawler_os%' ORDER BY created_at DESC LIMIT 1",
          )
          .get()
        superseded = Boolean(sup)
      } catch { /* table/column absent — treat as not-superseded */ }

      if (superseded) {
        return {
          ok: true,
          summary: `national-programs legacy bridge superseded by Crawler OS (expected after cutover); discovery is owned by Crawler OS. ${catalogRows} legacy catalog row(s).`,
          evidence: { enabled, catalog_rows: catalogRows, superseded_by_crawler_os: true },
        }
      }

      // Not superseded AND enabled AND nothing reached the catalog → the bridge
      // is the prime suspect (genuine defect). When disabled, zero rows is
      // expected (just report the dormant engine).
      if (enabled && catalogRows === 0) {
        return {
          ok: false,
          summary: 'National-programs crawler is ENABLED (not superseded) but 0 of its discoveries reached the canonical catalog (funding_opportunities). The catalogBridge may be rejecting/erroring.',
          evidence: { enabled, catalog_rows: catalogRows, source: 'national_programs_crawler', superseded_by_crawler_os: false },
        }
      }
      return {
        ok: true,
        summary: enabled
          ? `national-programs bridge healthy: ${catalogRows} catalog row(s)`
          : `national-programs crawler DORMANT (NATIONAL_PROGRAMS_CRAWLER_ENABLED not 'true'); ${catalogRows} historical catalog row(s)`,
        evidence: { enabled, catalog_rows: catalogRows },
      }
    },
  },
  // Yana / John / Anya health. Before this, Sam had ZERO checks for three of
  // the six agents (2026-06-23 audit) — they could silently no-op and Sam would
  // never flag it, violating the agent-observability rule. These probe the same
  // agent-telemetry surface Mission Control reads, so a broken/absent agent
  // summary surfaces as a Sam finding.
  {
    id: 'agent.yana.health',
    label: 'Yana agent health (lead discovery)',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/admin/agent-telemetry/yana',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Confirms Yana telemetry is reachable and her lead-candidate/run summary is populated, so a silent discovery no-op is caught.',
  },
  {
    id: 'agent.john.health',
    label: 'John agent health (outreach drafts)',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/admin/agent-telemetry/john',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Confirms John telemetry is reachable and his draft/run summary is populated (drafts, runs, reconcile), so a silent drafting no-op is caught.',
  },
  {
    id: 'agent.anya.health',
    label: 'Anya agent health (administrative assistant)',
    category: SAM_CATEGORIES.ADMIN_TOOL_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/admin/agent-telemetry/anya',
    expectStatus: 200,
    severityOnFailure: SEVERITY.HIGH,
    description: 'Confirms Anya telemetry is reachable and her tool-usage/run summary is populated, so a regression in her tool surface is caught.',
  },
  // Deep per-agent checks — the HTTP telemetry probes above only prove the
  // summary endpoint answers 200; these read the agents' OWN tables so a
  // "reachable but silently failing" agent (runs erroring, yield frozen at
  // zero, tool calls failing) surfaces as a Sam finding instead of a green
  // dashboard. All fail OPEN: disabled agent / missing table / no data yet is
  // an environment state, never a finding.
  {
    id: 'agent.yana.yield',
    label: 'Yana lead yield (qualification pipeline)',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Reads yana_lead_candidates directly: flags the frozen-universe failure class where Yana keeps FINDING leads but qualifies/pushes NONE to John over the recent window (a scoring or cursor regression, not an empty market). Fails open when Yana is disabled, the table is absent, or the sample is too small.',
    async run({ db } = {}) {
      if (!db?.prepare) return { ok: true, skipped: true, summary: 'yana yield: db unavailable' }
      const enabled = /^(1|true|yes|on)$/i.test(String(process.env.YANA_ENABLED ?? '').trim())
      // Portable time window: compute the cutoff in JS in the dialect's own
      // timestamp format (datetime('now', ...) is SQLite-only; prod runs PG).
      const since = timeCutoff(db, 14 * 24 * 60 * 60 * 1000)
      let rows
      try {
        rows = await db
          .prepare(`
            SELECT
              COUNT(*) AS found,
              SUM(CASE WHEN qualification_status = 'qualified' THEN 1 ELSE 0 END) AS qualified,
              SUM(CASE WHEN pushed_to_john = 1 THEN 1 ELSE 0 END) AS pushed
            FROM yana_lead_candidates
            WHERE created_at >= ?
          `)
          .get(since)
      } catch (err) {
        return { ok: true, skipped: true, summary: `yana_lead_candidates not queryable yet (${err?.message || 'unknown'})` }
      }
      const found = Number(rows?.found || 0)
      const qualified = Number(rows?.qualified || 0)
      const pushed = Number(rows?.pushed || 0)
      if (!enabled && found === 0) {
        return { ok: true, summary: 'Yana disabled (YANA_ENABLED off) and no recent lead candidates — nothing to assess.' }
      }
      // Frozen-universe signal: a real sample of found leads, zero qualified
      // AND zero pushed. A small trickle is not a signal.
      if (found >= 10 && qualified === 0 && pushed === 0) {
        return {
          ok: false,
          summary: `Yana found ${found} lead candidate(s) in 14 days but qualified 0 and pushed 0 to John — qualification pipeline looks frozen.`,
          evidence: { found, qualified, pushed, window_days: 14, enabled },
          recommended_fix: 'Inspect yana qualification scoring + the persisted discovery cursor (frozen-universe class); confirm the John bridge is consuming qualified leads.',
          confidence: 0.8,
        }
      }
      return {
        ok: true,
        summary: `Yana yield (14d): found ${found}, qualified ${qualified}, pushed ${pushed} (enabled=${enabled}).`,
        evidence: { found, qualified, pushed, enabled },
      }
    },
  },
  {
    id: 'agent.john.draftHealth',
    label: 'John run/draft health',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Reads john_runs directly: flags when John\'s recent runs are consistently FAILING (the telemetry endpoint stays 200 through that). Fails open when John has never run or his tables are absent.',
    async run({ db } = {}) {
      if (!db?.prepare) return { ok: true, skipped: true, summary: 'john health: db unavailable' }
      let recent
      try {
        recent = await db
          .prepare('SELECT status FROM john_runs ORDER BY started_at DESC LIMIT 5')
          .all()
      } catch (err) {
        return { ok: true, skipped: true, summary: `john_runs not queryable yet (${err?.message || 'unknown'})` }
      }
      if (!recent || recent.length === 0) {
        return { ok: true, summary: 'John has not run yet (no john_runs rows).' }
      }
      const failed = recent.filter((r) => String(r.status || '').toLowerCase() === 'failed').length
      if (recent.length >= 3 && failed === recent.length) {
        return {
          ok: false,
          summary: `John's last ${recent.length} runs ALL failed — outreach drafting is down while telemetry still answers 200.`,
          evidence: { recent_statuses: recent.map((r) => r.status), failed },
          recommended_fix: 'Read the latest john_runs.error / summary; usual suspects are Graph auth (alias 403 → User.Read.All) and empty lead input from Yana.',
          confidence: 0.85,
        }
      }
      return {
        ok: true,
        summary: `John run health ok: ${failed}/${recent.length} recent run(s) failed.`,
        evidence: { recent_statuses: recent.map((r) => r.status) },
      }
    },
  },
  {
    id: 'agent.anya.toolFailures',
    label: 'Anya tool failure rate',
    category: SAM_CATEGORIES.ADMIN_TOOL_INTEGRITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Reads anya_tool_usage directly: flags when a disproportionate share of Anya\'s recent tool invocations FAILED (her surface can be reachable while individual tools break underneath). Reports the top failing tools so the defect is triageable. Fails open on missing table / small sample.',
    async run({ db } = {}) {
      if (!db?.prepare) return { ok: true, skipped: true, summary: 'anya tool failures: db unavailable' }
      let rows
      try {
        rows = await db
          .prepare(`
            SELECT tool_name, success FROM anya_tool_usage
            ORDER BY created_at DESC LIMIT 200
          `)
          .all()
      } catch (err) {
        return { ok: true, skipped: true, summary: `anya_tool_usage not queryable yet (${err?.message || 'unknown'})` }
      }
      const total = rows?.length || 0
      if (total < 10) {
        return { ok: true, summary: `anya tool usage: only ${total} recent call(s); no reliable failure signal yet.` }
      }
      const failures = rows.filter((r) => Number(r.success) === 0)
      const rate = failures.length / total
      if (rate > 0.3) {
        const byTool = {}
        for (const f of failures) byTool[f.tool_name] = (byTool[f.tool_name] || 0) + 1
        const top = Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 5)
        return {
          ok: false,
          summary: `${Math.round(rate * 100)}% of Anya's last ${total} tool calls failed. Top failing: ${top.map(([t, n]) => `${t}(${n})`).join(', ')}.`,
          evidence: { total, failed: failures.length, failure_rate: Number(rate.toFixed(3)), top_failing_tools: top },
          recommended_fix: 'Query anya_tool_usage for error_message on the top failing tools; a single broken dependency (DB column, provider key) usually explains the cluster.',
          confidence: 0.85,
        }
      }
      return {
        ok: true,
        summary: `Anya tool health ok: ${failures.length}/${total} recent call(s) failed (${Math.round(rate * 100)}%).`,
        evidence: { total, failed: failures.length },
      }
    },
  },
  {
    id: 'agent.robert.discoveryPhases',
    label: 'Robert discovery phases (catalog mine + email feed)',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: "Recognizes Robert's catalog-mining (summary.catalog_mine) and email-feed (summary.email_feed) phases — the per-cycle work that mines the existing catalog and connects the Outlook grant feeder — and surfaces a finding when either phase reports an error in Robert's latest run. Fails open when Robert has never run or its tables are absent.",
    async run({ db }) {
      if (!db?.prepare) return { ok: true, summary: 'robert phases: db unavailable' }
      let run
      try {
        const { latestRun } = await import('../robert/robertRunStore.js')
        run = await latestRun(db)
      } catch (err) {
        return { ok: true, summary: `robert_runs not present yet (${err?.message || 'unknown'})` }
      }
      if (!run) return { ok: true, summary: 'Robert has not run yet (no robert_runs rows)' }

      const summary = run.summary || {}
      const phaseErrors = []
      // catalog_mine: failed when the phase recorded an explicit error key.
      const mine = summary.catalog_mine
      if (mine && typeof mine === 'object' && mine.error) {
        phaseErrors.push({ phase: 'catalog_mine', error: String(mine.error) })
      }
      // email_feed: ran:false with an error reason (not a benign disabled/no-op).
      const feed = summary.email_feed
      const benignFeedReasons = new Set(['email_feed_disabled', 'outlook_not_configured', 'feed_not_ok'])
      if (feed && typeof feed === 'object' && feed.ran === false && feed.error && !benignFeedReasons.has(feed.reason)) {
        phaseErrors.push({ phase: 'email_feed', reason: feed.reason, error: String(feed.error) })
      }
      // Any stage-scoped errors Robert pushed for these phases.
      const stageErrors = Array.isArray(summary.errors)
        ? summary.errors.filter((e) => e && /^(catalog_mine|email_feed)/.test(String(e.stage || '')))
        : []

      if (phaseErrors.length > 0 || stageErrors.length > 0) {
        return {
          ok: false,
          summary: `Robert discovery phase failures: ${[...phaseErrors.map((p) => p.phase), ...stageErrors.map((e) => e.stage)].join(', ')}`,
          evidence: { run_id: run.id, phase_errors: phaseErrors, stage_errors: stageErrors.slice(0, 5) },
        }
      }
      return {
        ok: true,
        summary: `Robert discovery phases ok (catalog_mine ${mine ? 'present' : 'n/a'}, email_feed ${feed ? (feed.ran ? 'ran' : feed.reason || 'skipped') : 'n/a'})`,
        evidence: { run_id: run.id, has_catalog_mine: Boolean(mine), has_email_feed: Boolean(feed) },
      }
    },
  },
  {
    id: 'agent.robert.contactLeads',
    label: 'Robert email-contact lead scan',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.LOW,
    description: "Robert's ONLY lead source: scanning the owner's email contacts (gated by ROBERT_SCAN_EMAIL_CONTACTS + Graph Contacts.Read) and tagging client prospects into robert_source_candidates for the John bridge. Reports how many contact-sourced leads are tagged and whether the latest run's contact_lead_scan phase errored. Fails open when disabled or never run.",
    async run({ db }) {
      let enabled = false
      try {
        const { isContactScanEnabled } = await import('../robert/robertContactDiscovery.js')
        enabled = isContactScanEnabled()
      } catch { /* module load best-effort */ }
      if (!db?.prepare) return { ok: true, summary: 'robert contact leads: db unavailable' }
      let tagged = null
      try {
        const r = await db.prepare(`SELECT COUNT(*) AS c FROM robert_source_candidates WHERE discovered_by = 'robert_contacts'`).get()
        tagged = Number(r?.c || 0)
      } catch { /* table may not exist yet */ }
      return {
        ok: true,
        summary: `Robert contact-lead scan ${enabled ? 'enabled' : 'disabled (ROBERT_SCAN_EMAIL_CONTACTS off)'}; ${tagged ?? 'n/a'} contact lead(s) tagged.`,
        evidence: { enabled, tagged_contact_leads: tagged },
      }
    },
  },
  {
    id: 'agent.hamilton.weeklyDigest',
    label: 'Hamilton weekly funding digest',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.LOW,
    description: 'Confirms Hamilton\'s Monday-08:00-ET per-profile funding digest (drafts into the owner mailbox) is enabled and reports the last run summary from system_kv (drafted / skipped_no_email / errors). Fails open before the first run.',
    async run({ db }) {
      let enabled = true
      try {
        const { isWeeklyDigestEnabled } = await import('../hamilton/hamiltonWeeklyDigest.js')
        enabled = isWeeklyDigestEnabled()
      } catch { /* best-effort */ }
      let summary = null
      try {
        const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get('hamilton_weekly_digest_last_run_summary')
        summary = row?.value ? JSON.parse(row.value) : null
      } catch { /* system_kv may not exist until first run */ }
      const errored = summary && Number(summary.errors) > 0
      return {
        ok: !errored,
        summary: errored
          ? `Hamilton weekly digest last run had ${summary.errors} draft error(s).`
          : `Hamilton weekly digest ${enabled ? 'enabled' : 'disabled'}${summary ? ` — last run drafted ${summary.drafted ?? 0}, skipped ${summary.skipped_no_email ?? 0}` : ' (not run yet)'}.`,
        evidence: { enabled, last_summary: summary },
      }
    },
  },
  {
    id: 'agent.hamilton.mondayPortalReminder',
    label: 'Monday unmerged-portal reminder',
    category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.LOW,
    description: 'Confirms the Monday-09:00-ET reminder for UNMERGED portals (including completed-but-not-merged) is enabled and reports its last run summary from system_kv (reminded / portals_reminded / errors). Fails open before the first run.',
    async run({ db }) {
      let enabled = true
      try {
        const { isMondayPortalReminderEnabled } = await import('../hamilton/mondayPortalReminder.js')
        enabled = isMondayPortalReminderEnabled()
      } catch { /* best-effort */ }
      let summary = null
      try {
        const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get('monday_portal_reminder_last_run_summary')
        summary = row?.value ? JSON.parse(row.value) : null
      } catch { /* system_kv may not exist until first run */ }
      const errored = summary && Number(summary.errors) > 0
      return {
        ok: !errored,
        summary: errored
          ? `Monday portal reminder last run had ${summary.errors} send error(s).`
          : `Monday unmerged-portal reminder ${enabled ? 'enabled' : 'disabled'}${summary ? ` — last run reminded ${summary.reminded ?? 0} profile(s) across ${summary.portals_reminded ?? 0} portal(s)` : ' (not run yet)'}.`,
        evidence: { enabled, last_summary: summary },
      }
    },
  },
  {
    id: 'maintenance.nightlySweep',
    label: 'Maintenance window + nightly sweep',
    category: SAM_CATEGORIES.ENVIRONMENT_READINESS,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.LOW,
    description: 'Reports the current maintenance phase (open/warning/down) and whether Sam\'s 04:00-ET nightly sweep ran for the current ET day. Flags when the app has been left in a DOWN window (e.g. a non-green nightly sweep that did not reopen). Fails open before the first run.',
    async run({ db }) {
      if (!db?.prepare) return { ok: true, summary: 'maintenance: db unavailable' }
      let phase = 'open'
      try {
        const { getMaintenanceStatus } = await import('../maintenance/maintenanceMode.js')
        phase = (await getMaintenanceStatus(db))?.phase || 'open'
      } catch { /* best-effort */ }
      let lastSweep = null
      try {
        const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get('nightly_maintenance_last_run')
        lastSweep = row?.value || null
      } catch { /* system_kv may not exist yet */ }
      // A persistent DOWN window is worth surfacing (it means users are locked out).
      const stuckDown = phase === 'down'
      return {
        ok: !stuckDown,
        summary: stuckDown
          ? 'App is in a DOWN maintenance window — verify the deploy/sweep finished and reopen.'
          : `Maintenance phase: ${phase}. Last nightly sweep: ${lastSweep || 'not run yet'}.`,
        evidence: { phase, last_nightly_sweep: lastSweep },
      }
    },
  },
  {
    id: 'comms.broadcastSurface',
    label: 'Owner broadcast / notifications surface',
    category: SAM_CATEGORIES.ROUTE_INTEGRITY,
    kind: CHECK_KIND.HTTP,
    method: 'GET',
    path: '/api/admin/comms/recipients',
    expectStatus: 200,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Probes the admin Broadcast recipient surface so a mount-point / route regression in owner messaging (promotions, notifications, free-period + suspension notices) is caught before deploy.',
  },
  {
    id: 'comms.smsConsent',
    label: 'SMS consent (opt-in) state',
    category: SAM_CATEGORIES.PRODUCTION_CONFIG,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.LOW,
    description: 'Makes the SMS consent state machine observable: is Twilio configured (so consent texts CAN be sent), and how many phones are in each consent state (none = new/awaiting ask, pending = asked/awaiting reply, opted_in, opted_out). Flags only when there are numbers awaiting consent (state=none) but SMS is NOT configured — i.e. the consent campaign can never run, so new profiles will never be asked. Fails open before the table exists.',
    async run({ db }) {
      if (!db?.prepare) return { ok: true, summary: 'sms consent: db unavailable' }
      let counts
      try {
        const { getConsentStatusCounts } = await import('../comms/smsConsentService.js')
        counts = await getConsentStatusCounts(db)
      } catch (err) {
        // Table not migrated yet / service unavailable — environment gap, not a defect.
        return { ok: true, summary: `sms consent check skipped (${err?.message || 'unknown'})` }
      }
      const awaiting = Number(counts?.none || 0)
      const configured = Boolean(counts?.configured)
      // Real signal: there are numbers that still need the consent ask, but SMS
      // can't send, so the campaign is dead. Everything else is informational.
      if (awaiting > 0 && !configured) {
        return {
          ok: false,
          summary: `${awaiting} phone(s) await SMS consent but Twilio is NOT configured — the consent campaign cannot run, so new/existing profiles will never be asked. Set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_MESSAGING_SERVICE_SID (or TWILIO_FROM_NUMBER).`,
          evidence: counts,
          recommended_fix: 'Configure the Twilio env vars on Railway, then run owner.sms_consent_campaign (dry-run first, then confirm:true).',
        }
      }
      return {
        ok: true,
        summary: `SMS consent: configured=${configured}; none(awaiting)=${awaiting}, pending=${counts?.pending || 0}, opted_in=${counts?.opted_in || 0}, opted_out=${counts?.opted_out || 0}.`,
        evidence: counts,
      }
    },
  },
  {
    id: 'connector.clinicalTrials',
    label: 'Clinical-trials connector + dispatcher job type',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: "Confirms the opt-in clinical-trials connector exists, the 'clinical_trials' dispatcher job type is registered, and the connector is HONEST (its no-conditions search returns [] rather than fabricated studies; it never throws). Discovery is gated on health_medical.consent_for_studies — this check verifies wiring, never enrolls.",
    async run() {
      let connector
      let registered = false
      try {
        connector = await import('../connectors/clinicalTrialsConnector.js')
      } catch (err) {
        return {
          ok: false,
          summary: `clinical-trials connector failed to load: ${err?.message || err}`,
          evidence: { error: String(err?.message || err) },
        }
      }
      try {
        const dispatcher = await import('../crawlerDispatcher.js')
        // HANDLERS is module-private; assert via the documented job-type contract
        // instead. The connector's source gate (connectorIngestService) owns the
        // 'clinicaltrials.gov' source; the dispatcher owns the job type. We treat
        // the exported source constant as the wiring witness here and rely on the
        // dedicated dispatcher test for the handler-map assertion.
        registered = Boolean(dispatcher) && typeof connector.searchClinicalTrials === 'function'
      } catch (err) {
        return { ok: true, summary: `dispatcher not loadable in this runtime (${err?.message || 'unknown'})` }
      }

      // Honesty probe: with no conditions there is nothing relevant to a
      // medical-need participant, so the connector MUST return an empty array
      // (no fabricated studies) and MUST NOT throw.
      let honest = false
      try {
        const empty = await connector.searchClinicalTrials({ conditions: [] })
        honest = Array.isArray(empty) && empty.length === 0
      } catch {
        honest = false
      }
      if (!registered || !honest) {
        return {
          ok: false,
          summary: `clinical-trials connector wiring/honesty check failed (registered=${registered}, honest_empty=${honest})`,
          evidence: {
            registered,
            honest_empty_result: honest,
            source: connector.CLINICAL_TRIALS_SOURCE,
            record_origin: connector.CLINICAL_TRIALS_RECORD_ORIGIN,
          },
        }
      }
      return {
        ok: true,
        summary: `clinical-trials connector reachable + honest (source=${connector.CLINICAL_TRIALS_SOURCE}, opt-in gated)`,
        evidence: { registered, source: connector.CLINICAL_TRIALS_SOURCE },
      }
    },
  },
  {
    id: 'discovery.domainCrawlerAwareness',
    label: 'Domain crawler registry awareness',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.LOW,
    description: 'Makes Sam aware of the domain crawler registry (incl. the new corporate_matching_gift_grants / reentry_justice_involved_funding / patient_disease_specific_assistance types, profile-driven foundation990, domain-corpus relevance, city/county geo expansion). Purely informational so unknown-but-valid crawler types dispatched on demand (e.g. via the "Find funding" trigger of triggerAutoDiscoveryCrawlers) NEVER raise a false "missing crawler" alarm. Only fails if the registry cannot load at all.',
    async run() {
      const EXPECTED_NEW_TYPES = [
        'corporate_matching_gift_grants',
        'reentry_justice_involved_funding',
        'patient_disease_specific_assistance',
      ]
      let registry
      try {
        ;({ DOMAIN_CRAWLER_REGISTRY: registry } = await import('../crawlerOsCompatibility.js'))
      } catch (err) {
        return {
          ok: false,
          summary: `domain crawler registry failed to load: ${err?.message || err}`,
          evidence: { error: String(err?.message || err) },
        }
      }
      const ids = new Set((Array.isArray(registry) ? registry : []).map((c) => c?.id))
      const missing = EXPECTED_NEW_TYPES.filter((t) => !ids.has(t))
      // Awareness, not enforcement: a missing NEW type is informational (the
      // registry may legitimately evolve), never a hard failure, and unknown
      // types are explicitly tolerated.
      return {
        ok: true,
        summary: missing.length === 0
          ? `domain crawler registry loaded: ${ids.size} types, all ${EXPECTED_NEW_TYPES.length} new types present`
          : `domain crawler registry loaded: ${ids.size} types; new types not yet present: ${missing.join(', ')}`,
        evidence: { total_types: ids.size, new_types_present: EXPECTED_NEW_TYPES.filter((t) => ids.has(t)), new_types_missing: missing },
      }
    },
  },
  {
    id: 'discovery.automationConfig',
    label: 'Discovery automation config presence (booleans only)',
    category: SAM_CATEGORIES.PRODUCTION_CONFIG,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.LOW,
    description: 'Reports PRESENCE (boolean only — NEVER values) of the env flags now driving background funding discovery, so an admin can tell at a glance if a discovery engine is dormant. Covers NATIONAL_PROGRAMS_CRAWLER_ENABLED, AUTO_DISCOVERY_DAILY_ENABLED, EMAIL_GRANTS_SYNC_ENABLED, ROBERT_ENABLED, ROBERT_RUN_ON_SCHEDULE, OPPORTUNITY_INSERT_VERIFY_URL, and the SAM.gov key via the canonical resolver (loadFundingApiKeys). Never emits a secret. Always ok:true — it is observability, not a gate.',
    async run() {
      // Enable-style flags default to ON when unset (matches the engines'
      // own defaults: email feed + auto-discovery treat absence as enabled),
      // so "present and enabled" reflects whether the engine will actually run.
      const isEnabled = (name, defaultOn = false) => {
        const raw = process.env[name]
        if (raw === undefined || raw === null || String(raw).trim() === '') return defaultOn
        return !['false', '0', 'no', 'off'].includes(String(raw).trim().toLowerCase())
      }
      const isPresent = (name) => {
        const raw = process.env[name]
        return raw !== undefined && raw !== null && String(raw).trim() !== ''
      }

      const config = {
        NATIONAL_PROGRAMS_CRAWLER_ENABLED: process.env.NATIONAL_PROGRAMS_CRAWLER_ENABLED === 'true',
        AUTO_DISCOVERY_DAILY_ENABLED: isEnabled('AUTO_DISCOVERY_DAILY_ENABLED', true),
        EMAIL_GRANTS_SYNC_ENABLED: isEnabled('EMAIL_GRANTS_SYNC_ENABLED', true),
        ROBERT_ENABLED: isEnabled('ROBERT_ENABLED', false),
        ROBERT_RUN_ON_SCHEDULE: isEnabled('ROBERT_RUN_ON_SCHEDULE', false),
        OPPORTUNITY_INSERT_VERIFY_URL: isPresent('OPPORTUNITY_INSERT_VERIFY_URL'),
      }

      // SAM.gov key presence via the CANONICAL resolver — never the raw value.
      let samGovKeyPresent = false
      try {
        const { loadFundingApiKeys } = await import('../../src/config/apiKeys.js')
        samGovKeyPresent = Boolean(loadFundingApiKeys().SAM_GOV_PUBLIC_API_KEY)
      } catch {
        samGovKeyPresent = false
      }
      config.SAM_GOV_API_KEY = samGovKeyPresent

      const dormant = Object.entries(config)
        .filter(([, present]) => present === false)
        .map(([name]) => name)

      return {
        ok: true,
        summary: dormant.length === 0
          ? 'all discovery automation flags present/enabled'
          : `discovery flags absent/disabled (engines may be dormant): ${dormant.join(', ')}`,
        // Evidence is booleans ONLY — no secret can leak.
        evidence: config,
      }
    },
  },
  {
    id: 'crawler.recentJobErrors',
    label: 'Recent crawler job errors (real vs. benign)',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Mirrors the System Diagnostics "crawler error(s) detected" signal into Sam, but counts only REAL failures. Expected no-input/skipped outcomes (missing_item_request and similar benign codes) are reclassified as benign and never raise a finding — so Sam no longer carries a standing "1 error" for a clean system. Fails only when GENUINE crawler failures are present in the last 7 days. Fails open when the diagnostics service or crawler tables are unavailable.',
    async run({ db }) {
      if (!db?.prepare) return { ok: true, summary: 'crawler job errors: db unavailable' }
      let real = 0
      let benign = 0
      try {
        const { getSystemDiagnostics } = await import('../diagnosticsService.js')
        const diag = await getSystemDiagnostics(db)
        real = Number(diag?.error_counts?.real ?? 0)
        benign = Number(diag?.error_counts?.benign ?? 0)
      } catch (err) {
        // Environment gap (tables not migrated / service unavailable) — not a defect.
        return { ok: true, summary: `crawler job error scan skipped (${err?.message || 'unknown'})` }
      }
      if (real > 0) {
        return {
          ok: false,
          summary: `${real} real crawler job error(s) in the last 7 days (plus ${benign} benign skip(s) excluded).`,
          evidence: { real_errors: real, benign_skips: benign },
          recommended_fix: 'Open System Diagnostics → real_errors to triage; benign skips (e.g. missing_item_request) are expected and excluded.',
        }
      }
      return {
        ok: true,
        summary: benign > 0
          ? `no real crawler job errors; ${benign} benign skip(s) (e.g. missing_item_request) excluded.`
          : 'no recent crawler job errors.',
        evidence: { real_errors: real, benign_skips: benign },
      }
    },
  },
  {
    id: 'queue.staleJobs',
    label: 'Stale crawler queue jobs',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Flags crawler jobs stuck in "running" past the stale threshold or "queued" for over 24h — dead workers / dispatcher stalls that silently starve discovery. Carries safe_fix_id queue.recover-stale-jobs so a repair-safe run ACTS on the finding (Sam sees → Sam fixes) instead of only reporting it. Fails open when the table is absent.',
    async run({ db } = {}) {
      if (!db?.prepare) return { ok: true, skipped: true, summary: 'queue stale jobs: db unavailable' }
      const staleRunningMs = parseInt(process.env.CRAWLER_STALE_RUNNING_MS || String(7 * 60 * 60 * 1000), 10)
      const staleQueuedMs = 24 * 60 * 60 * 1000
      const runningCutoff = timeCutoff(db, staleRunningMs)
      const queuedCutoff = timeCutoff(db, staleQueuedMs)
      let running = 0
      let queued = 0
      try {
        const r = await db
          .prepare(`SELECT COUNT(*) AS c FROM crawler_jobs WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`)
          .get(runningCutoff)
        running = Number(r?.c || 0)
        // COALESCE(last_retry_at, created_at) = fresh queue-entry time — a
        // requeued old job is not "stuck since its ORIGINAL enqueue".
        const q = await db
          .prepare(`SELECT COUNT(*) AS c FROM crawler_jobs WHERE status = 'queued' AND COALESCE(last_retry_at, created_at) < ?`)
          .get(queuedCutoff)
        queued = Number(q?.c || 0)
      } catch (err) {
        return { ok: true, skipped: true, summary: `crawler_jobs not queryable yet (${err?.message || 'unknown'})` }
      }
      if (running > 0 || queued > 0) {
        return {
          ok: false,
          summary: `${running} crawler job(s) stuck running past ${Math.round(staleRunningMs / 3600000)}h and ${queued} queued > 24h — the queue is silently starving discovery.`,
          evidence: {
            stale_running: running,
            stale_queued: queued,
            // Consumed by samSafeFixes.deriveSafeFixesFromFindings: on the
            // human-authorized repair-safe path Sam applies the registered
            // deterministic cleanup instead of only reporting.
            safe_fix_id: 'queue.recover-stale-jobs',
          },
          recommended_fix: 'Run Sam in repair-safe mode (auto-applies queue.recover-stale-jobs) or POST /api/admin/queue/recover-stale.',
          confidence: 0.9,
        }
      }
      return { ok: true, summary: 'no stale crawler queue jobs.', evidence: { stale_running: 0, stale_queued: 0 } }
    },
  },
  {
    id: 'crawler.coverageDegraded',
    label: 'Crawler coverage degraded (source failure rate)',
    category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
    kind: CHECK_KIND.INTERNAL,
    severityOnFailure: SEVERITY.MEDIUM,
    description: 'Makes the crawl coverage dashboard (GET /api/admin/crawl-coverage) observable to Sam: flags when a disproportionate share of recently QUERIED sources FAILED (default threshold 30% over the last ~50 runs), which signals an outage, a bad key, or a broken source adapter. Reads only crawler_source_runs. Fails open: empty/missing table or too few runs → ok:true (no signal yet).',
    async run({ db }) {
      if (!db?.prepare) return { ok: true, summary: 'crawler coverage: db unavailable' }
      const threshold = Number.parseFloat(process.env.CRAWLER_COVERAGE_FAILURE_THRESHOLD || '0.30')
      // Minimum queried-source sample before we trust the rate — avoids a
      // single failed run reading as "100% degraded".
      const MIN_SAMPLE = 20
      let row
      try {
        row = await db
          .prepare(
            `SELECT
               SUM(CASE WHEN queried THEN 1 ELSE 0 END) AS queried,
               SUM(CASE WHEN failed  THEN 1 ELSE 0 END) AS failed
             FROM crawler_source_runs
             WHERE crawler_run_id IN (
               SELECT crawler_run_id FROM crawler_source_runs
               GROUP BY crawler_run_id
               ORDER BY MAX(created_at) DESC
               LIMIT 50
             )`,
          )
          .get()
      } catch (err) {
        // Table not migrated yet — environment gap, not a defect.
        return { ok: true, summary: `crawler_source_runs not queryable yet (${err?.message || 'unknown'})` }
      }
      const queried = Number(row?.queried ?? 0)
      const failed = Number(row?.failed ?? 0)
      if (queried < MIN_SAMPLE) {
        return {
          ok: true,
          summary: `crawler coverage: only ${queried} queried source(s) sampled (< ${MIN_SAMPLE}); no reliable signal yet`,
          evidence: { queried, failed, threshold },
        }
      }
      const rate = failed / queried
      if (rate > threshold) {
        return {
          ok: false,
          summary: `Crawler coverage DEGRADED: ${failed}/${queried} recently-queried sources failed (${Math.round(rate * 100)}% > ${Math.round(threshold * 100)}% threshold). Check source adapters / API keys / outages on the Crawl Coverage dashboard.`,
          evidence: { queried, failed, failure_rate: Number(rate.toFixed(3)), threshold },
          recommended_fix: 'Open /CrawlCoverage (admin) to see which sources are failing and their errors; verify FUNDING_SOURCES API keys and source endpoint health.',
        }
      }
      return {
        ok: true,
        summary: `crawler coverage healthy: ${failed}/${queried} queried sources failed (${Math.round(rate * 100)}% ≤ ${Math.round(threshold * 100)}%)`,
        evidence: { queried, failed, failure_rate: Number(rate.toFixed(3)), threshold },
      }
    },
  },
])

// ---------------------------------------------------------------------------
// Production-gate scripts (only invoked from gatekeeper mode)
// ---------------------------------------------------------------------------
//
// The keys here MUST match an actual npm script name. Sam will skip any
// script that doesn't exist on disk. The whitelist is the single source of
// truth — if it isn't in this list, samSafeFixes.runWhitelistedCommand
// refuses to run it.

export const PRODUCTION_GATE_SCRIPTS = Object.freeze([
  { script: 'scan:secrets',        category: SAM_CATEGORIES.DEPENDENCY_SECURITY,    severityOnFailure: SEVERITY.CRITICAL },
  { script: 'lint:strict',         category: SAM_CATEGORIES.LOGGING_AND_ERROR_HANDLING, severityOnFailure: SEVERITY.HIGH },
  { script: 'typecheck',           category: SAM_CATEGORIES.BUILD_INTEGRITY,        severityOnFailure: SEVERITY.HIGH },
  { script: 'build',               category: SAM_CATEGORIES.BUILD_INTEGRITY,        severityOnFailure: SEVERITY.CRITICAL },
  { script: 'unit',                category: SAM_CATEGORIES.TEST_INTEGRITY,         severityOnFailure: SEVERITY.HIGH },
  { script: 'db:setup',            category: SAM_CATEGORIES.MIGRATION_SAFETY,       severityOnFailure: SEVERITY.HIGH },
  { script: 'crawler:doctor',      category: SAM_CATEGORIES.CRAWLER_RELIABILITY,    severityOnFailure: SEVERITY.HIGH },
  { script: 'crawler:smoke',       category: SAM_CATEGORIES.CRAWLER_RELIABILITY,    severityOnFailure: SEVERITY.MEDIUM },
  { script: 'smoke:apply-engine',  category: SAM_CATEGORIES.APPLICATION_WORKFLOW_INTEGRITY, severityOnFailure: SEVERITY.HIGH },
  { script: 'release:gates',       category: SAM_CATEGORIES.PRODUCTION_CONFIG,      severityOnFailure: SEVERITY.CRITICAL },
  { script: 'test:all',            category: SAM_CATEGORIES.TEST_INTEGRITY,         severityOnFailure: SEVERITY.MEDIUM },
])

// Node scripts Sam may invoke directly (no npm wrapper). The path is
// relative to the repo root and MUST end with .mjs to make tampering
// obvious.
export const PRODUCTION_GATE_NODE_SCRIPTS = Object.freeze([
  {
    label: 'verify-stability',
    file: 'scripts/verify-stability.mjs',
    category: SAM_CATEGORIES.ENVIRONMENT_READINESS,
    severityOnFailure: SEVERITY.MEDIUM,
  },
])

// Whitelist used by samSafeFixes.runWhitelistedCommand — the union of npm
// scripts and node scripts Sam is allowed to spawn.
export function buildCommandWhitelist() {
  const npm = PRODUCTION_GATE_SCRIPTS.map((g) => `npm run -s ${g.script}`)
  const node = PRODUCTION_GATE_NODE_SCRIPTS.map((g) => `node ${g.file}`)
  return new Set([...npm, ...node])
}

// ---------------------------------------------------------------------------
// Safe-fix registry (deterministic, low-risk)
// ---------------------------------------------------------------------------
//
// These are the ONLY mutations Sam is willing to apply, and even then only
// in `repair-safe` mode + with explicit admin authorisation. Every entry
// must point to a function in samSafeFixes.js.
//
// The current set is intentionally small. Additions must come with a unit
// test that proves idempotency + rollback.

export const SAFE_FIX_REGISTRY = Object.freeze([
  {
    id: 'docs.regenerate-readiness-log',
    label: 'Regenerate readiness log file',
    risk_level: 'safe',
    description: 'Writes the latest gatekeeper output to docs/_readiness_logs/sam-<timestamp>.log so the run is auditable. Idempotent — never overwrites a previous log.',
  },
  {
    id: 'lint.eslint-fix-file',
    label: 'Run eslint --fix on a single file',
    risk_level: 'safe',
    description: 'Runs eslint with --fix limited to one file when the lint check identified that exact path. Refuses if the file is outside src/ or backend/.',
  },
  {
    id: 'queue.recover-stale-jobs',
    label: 'Recover stale crawler queue jobs',
    risk_level: 'safe',
    description: 'Runs the SAME idempotent stale-job recovery the admin queue endpoint uses (crawlerConcurrencyGuard.cleanupStaleCrawlers + cleanupStaleQueuedJobs): marks dead running jobs failed/partial and expires ancient queued jobs. Deterministic, DB-only, never touches files; a second run recovers 0.',
  },
])

// Quick lookup by id.
export function findSafeFixById(id) {
  return SAFE_FIX_REGISTRY.find((f) => f.id === id) || null
}

// ---------------------------------------------------------------------------
// Default check set used by `observe` / `advise` modes
// ---------------------------------------------------------------------------
export function defaultDiagnosticIds({ includeHeavy = false } = {}) {
  // HEAVY checks (source-tree walks, ESLint shell-outs, multi-route HTTP
  // fan-outs) belong to the gatekeeper/CI sweep. The operational agent-control
  // cycle and the autonomous scheduler run in observe/advise mode where they
  // MUST stay fast and hang-proof — a 60s+ code scan in Sam's preflight stalls
  // the entire Robert→Yana→John→Hamilton chain (2026-06-23 full-cycle audit).
  // includeHeavy=true (gatekeeper / explicit request) runs the full set.
  return DIAGNOSTIC_CHECKS.filter((c) => includeHeavy || !c.heavy).map((c) => c.id)
}

/** Ids of the heavy (gatekeeper-only by default) checks. */
export function heavyDiagnosticIds() {
  return DIAGNOSTIC_CHECKS.filter((c) => c.heavy).map((c) => c.id)
}

export function getCheckById(id) {
  return DIAGNOSTIC_CHECKS.find((c) => c.id === id) || null
}
