#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const file = path.resolve('backend/services/amy/amyAgent.js')
let source = fs.readFileSync(file, 'utf8')

function replaceOnce(before, after, label) {
  const first = source.indexOf(before)
  if (first < 0 || first !== source.lastIndexOf(before)) {
    throw new Error(`[amy-preflight-watchdog] ${label} missing or ambiguous`)
  }
  source = source.replace(before, after)
}

if (!source.includes("from './amyPreflight.js'")) {
  replaceOnce(
    `import { insertActivityEvent } from '../agentTelemetry/agentTelemetryStore.js'`,
    `import { insertActivityEvent } from '../agentTelemetry/agentTelemetryStore.js'\nimport { boundedAmyPreflight } from './amyPreflight.js'`,
    'preflight import',
  )
}

if (!source.includes("boundedAmyPreflight('mesh_context'")) {
  replaceOnce(
`  try {
    meshInbox = await mesh.consumeInbox(db, 'amy', { now: clock() })
    meshLessonsHeard = await mesh.readLessons(db, {
      topics: ['crawler_reliability'],
      excludeAuthor: 'amy',
      freshWithinHours: 48,
      limit: 5,
      now: clock(),
    })
    searchDegraded = meshLessonsHeard.length > 0
    if (searchDegraded) {
      logger.info('Amy heard fresh crawler_reliability lesson(s) from the mesh — low_results learning suspended this run', {
        run_id: runId,
        lessons: meshLessonsHeard.map((l) => \`${'${l.author}'}: ${'${l.claim}'}\`),
      })
    }
  } catch (err) {
    logger.warn('Amy agent-mesh read failed (continuing without peer context)', { error: err?.message })
  }`,
`  const meshContext = await boundedAmyPreflight('mesh_context', async () => {
    const [inbox, lessons] = await Promise.all([
      mesh.consumeInbox(db, 'amy', { now: clock() }),
      mesh.readLessons(db, {
        topics: ['crawler_reliability'],
        excludeAuthor: 'amy',
        freshWithinHours: 48,
        limit: 5,
        now: clock(),
      }),
    ])
    return { inbox, lessons }
  }, {
    timeoutMs: 15_000,
    logger,
    fallback: { inbox: [], lessons: [] },
  })
  meshInbox = Array.isArray(meshContext?.inbox) ? meshContext.inbox : []
  meshLessonsHeard = Array.isArray(meshContext?.lessons) ? meshContext.lessons : []
  searchDegraded = meshLessonsHeard.length > 0
  if (searchDegraded) {
    logger.info('Amy heard fresh crawler_reliability lesson(s) from the mesh — low_results learning suspended this run', {
      run_id: runId,
      lessons: meshLessonsHeard.map((l) => \`${'${l.author}'}: ${'${l.claim}'}\`),
    })
  }`,
    'mesh preflight',
  )
}

if (source.includes('fleetGaps = await refreshScoreboard(db, { limit: gapScanLimit, now: clock() })')) {
  replaceOnce(
    `fleetGaps = await refreshScoreboard(db, { limit: gapScanLimit, now: clock() })`,
    `fleetGaps = await boundedAmyPreflight(
        'fleet_gap_scoreboard',
        () => refreshScoreboard(db, { limit: gapScanLimit, now: clock() }),
        { timeoutMs: 45_000, logger, fallback: null },
      )`,
    'scoreboard preflight',
  )
}

if (source.includes('searchOutcome = await searchForMissingConditionSources(db, gapActions.structural, { searchWeb })')) {
  replaceOnce(
    `searchOutcome = await searchForMissingConditionSources(db, gapActions.structural, { searchWeb })`,
    `searchOutcome = await boundedAmyPreflight(
          'condition_source_search',
          () => searchForMissingConditionSources(db, gapActions.structural, { searchWeb }),
          { timeoutMs: 30_000, logger, fallback: { ran: false, reason: 'preflight_timeout_or_error' } },
        )`,
    'condition search preflight',
  )
}

if (!source.includes("boundedAmyPreflight('gap_scoreboard_telemetry'")) {
  replaceOnce(
`    await Promise.resolve(recordActivity(db, {
      agent_name: 'amy',
      event_type: 'amy.gap_scoreboard.refreshed',
      status: 'succeeded',
      severity: 'info',
      title: \`Amy refreshed the fleet coverage-gap scoreboard: ${'${fleetGaps.gaps?.length || 0}'} gap class(es) across ${'${fleetGaps.profiles_scanned}'} profile(s)\`,
      description: topGap ? \`Top gap (${'${topGap.count}'} profile(s)): ${'${topGap.statement}'}\` : 'No fleet coverage gaps detected.',
      metric_key: 'fleet_gap_classes',
      metric_value: fleetGaps.gaps?.length || 0,
      details_json: {
        run_id: runId,
        top_gaps: (fleetGaps.gaps || []).slice(0, 5),
        category_weights: categoryWeights,
        actionable: gapActions.actionable.length,
        structural: gapActions.structural.length,
      },
    })).catch(() => {})`,
`    await boundedAmyPreflight('gap_scoreboard_telemetry', () => Promise.resolve(recordActivity(db, {
      agent_name: 'amy',
      event_type: 'amy.gap_scoreboard.refreshed',
      status: 'succeeded',
      severity: 'info',
      title: \`Amy refreshed the fleet coverage-gap scoreboard: ${'${fleetGaps.gaps?.length || 0}'} gap class(es) across ${'${fleetGaps.profiles_scanned}'} profile(s)\`,
      description: topGap ? \`Top gap (${'${topGap.count}'} profile(s)): ${'${topGap.statement}'}\` : 'No fleet coverage gaps detected.',
      metric_key: 'fleet_gap_classes',
      metric_value: fleetGaps.gaps?.length || 0,
      details_json: {
        run_id: runId,
        top_gaps: (fleetGaps.gaps || []).slice(0, 5),
        category_weights: categoryWeights,
        actionable: gapActions.actionable.length,
        structural: gapActions.structural.length,
      },
    })), { timeoutMs: 10_000, logger, fallback: null })`,
    'scoreboard telemetry preflight',
  )
}

if (!source.includes("boundedAmyPreflight('adapter_wishlist_telemetry'")) {
  replaceOnce(
`      await Promise.resolve(recordActivity(db, {
        agent_name: 'amy',
        event_type: 'amy.adapter_wishlist',
        // Only still 'blocked' when nothing could be queued for ANY of them. If a
        // candidate is queued the gap is being worked, not blocked — and reporting
        // "blocked" then would understate the loop exactly as reporting "added"
        // would overstate it.
        status: queued > 0 ? 'succeeded' : 'blocked',
        severity: queued > 0 ? 'info' : 'medium',
        title: queued > 0
          ? \`Adapter wishlist: queued ${'${queued}'} candidate source(s) for ${'${searchOutcome.searched}'} condition(s) — pending the gates on each profile's next crawl\`
          : \`Adapter wishlist: ${'${gapActions.structural.length}'} structural coverage gap(s) Amy cannot fix (source adapter needed)\`,
        description: gapActions.structural
          .slice(0, 3)
          .map((w) => \`${'${w.detail || w.lane}'}: ${'${w.statement}'} (${'${w.affected_profiles_count}'} profile(s))\`)
          .join(' | '),
        metric_key: 'adapter_wishlist',
        metric_value: gapActions.structural.length,
        // \`condition_search\` records what the SEARCH did (queued ≠ added — the gates
        // have not run yet). Anya's report reads the evidence store for the rest.
        details_json: { run_id: runId, wishlist: gapActions.structural, condition_search: searchOutcome },
      })).catch(() => {})`,
`      await boundedAmyPreflight('adapter_wishlist_telemetry', () => Promise.resolve(recordActivity(db, {
        agent_name: 'amy',
        event_type: 'amy.adapter_wishlist',
        // Only still 'blocked' when nothing could be queued for ANY of them. If a
        // candidate is queued the gap is being worked, not blocked — and reporting
        // "blocked" then would understate the loop exactly as reporting "added"
        // would overstate it.
        status: queued > 0 ? 'succeeded' : 'blocked',
        severity: queued > 0 ? 'info' : 'medium',
        title: queued > 0
          ? \`Adapter wishlist: queued ${'${queued}'} candidate source(s) for ${'${searchOutcome.searched}'} condition(s) — pending the gates on each profile's next crawl\`
          : \`Adapter wishlist: ${'${gapActions.structural.length}'} structural coverage gap(s) Amy cannot fix (source adapter needed)\`,
        description: gapActions.structural
          .slice(0, 3)
          .map((w) => \`${'${w.detail || w.lane}'}: ${'${w.statement}'} (${'${w.affected_profiles_count}'} profile(s))\`)
          .join(' | '),
        metric_key: 'adapter_wishlist',
        metric_value: gapActions.structural.length,
        // \`condition_search\` records what the SEARCH did (queued ≠ added — the gates
        // have not run yet). Anya's report reads the evidence store for the rest.
        details_json: { run_id: runId, wishlist: gapActions.structural, condition_search: searchOutcome },
      })), { timeoutMs: 10_000, logger, fallback: null })`,
    'wishlist telemetry preflight',
  )
}

const required = [
  "from './amyPreflight.js'",
  "boundedAmyPreflight('mesh_context'",
  "'fleet_gap_scoreboard'",
  "'condition_source_search'",
  "boundedAmyPreflight('gap_scoreboard_telemetry'",
  "boundedAmyPreflight('adapter_wishlist_telemetry'",
]
const missing = required.filter((signature) => !source.includes(signature))
if (missing.length) throw new Error(`[amy-preflight-watchdog] final signatures missing: ${missing.join(', ')}`)

fs.writeFileSync(file, source)
console.log('[source-materialization] Amy pre-profile work is bounded and fail-open')
