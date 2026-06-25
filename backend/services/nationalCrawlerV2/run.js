import path from 'node:path'
import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import crypto from 'crypto'
import { scrubPII } from '../../utils/piiScrubber.js'
import { buildRegistry, getSmokeSafeSources } from './registry.js'
import { RobotsCache } from './robots.js'
import { createFetcher, fetchToBuffer, fetchFileUrl } from './fetchers.js'
import { parseContent } from './parsers.js'
import { normalizeProgram } from './normalize.js'
import { upsertNormalizedProgram } from './store.js'
import { bridgeProgramToCatalog } from '../nationalPrograms/catalogBridge.js'
import { createLogger } from '../../utils/logger.js'
const qualityLog = createLogger('services:nationalCrawlerV2:run')

function isoDay() {
  return new Date().toISOString().slice(0, 10)
}

function newRunId() {
  return crypto.randomUUID()
}

function sha256(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex')
}

function ensureDir(p) {
  return fs.mkdir(p, { recursive: true })
}

function safeWrite(filePath, content) {
  return fs.writeFile(filePath, content, 'utf8')
}

function appendLine(filePath, line) {
  return fs.appendFile(filePath, line + '\n', 'utf8')
}

function redact(line) {
  return scrubPII(line)
}

function nowIso() {
  return new Date().toISOString()
}

function modeFromEnv(scopeMode) {
  if (scopeMode === 'STATE_MODE' || scopeMode === 'NATIONAL_MODE') return scopeMode
  return 'SMOKE_MODE'
}

function fixturesBaseUrl() {
  const repoRoot = path.resolve(process.cwd())
  const fixturesDir = path.join(repoRoot, 'tests', 'crawler', 'fixtures')
  // Use file:// URLs so fetch is fully offline and deterministic.
  return pathToFileURL(fixturesDir).toString().replace(/\/$/, '')
}

function artifactDir() {
  const repoRoot = path.resolve(process.cwd())
  return path.join(repoRoot, 'artifacts', 'crawler', isoDay())
}

async function loggers(dir) {
  await ensureDir(dir)
  const crawlLog = path.join(dir, 'crawl.log')
  const parseLog = path.join(dir, 'parse.log')
  const normalizeLog = path.join(dir, 'normalize.log')
  const apiSmokeLog = path.join(dir, 'api-smoke.log')

  return {
    crawlLog,
    parseLog,
    normalizeLog,
    apiSmokeLog,
    async crawl(line) {
      await appendLine(crawlLog, redact(line))
    },
    async parse(line) {
      await appendLine(parseLog, redact(line))
    },
    async normalize(line) {
      await appendLine(normalizeLog, redact(line))
    },
    async api(line) {
      await appendLine(apiSmokeLog, redact(line))
    },
  }
}

export async function runNationalCrawlerV2({
  db,
  scopeMode = 'SMOKE_MODE',
  state = null,
  useLiveSources = false,
  sourceSet = 'DEFAULT',
  maxSources = 10,
  maxUrlsPerSource = 8,
  timeoutSeconds = 25,
} = {}) {
  if (!db) throw new Error('db required')

  const mode = modeFromEnv(scopeMode)
  const runId = newRunId()
  const dir = artifactDir()
  const logs = await loggers(dir)

  const fixtureBaseUrl = fixturesBaseUrl()
  const registry =
    sourceSet === 'SMOKE_SAFE_SOURCES'
      ? getSmokeSafeSources()
      : buildRegistry({ useLive: useLiveSources, fixtureBaseUrl })

  const selectedSources = registry
    .filter((s) => s.enabled)
    .filter((s) => {
      if (sourceSet === 'SMOKE_SAFE_SOURCES') return true
      if (mode === 'SMOKE_MODE') return (s.tags || []).includes('smoke')
      if (mode === 'STATE_MODE') return s.jurisdiction === 'federal' || s.state === state
      return true
    })
    .slice(0, maxSources)

  // Persist sources into DB (evidence)
  const insertSourceSql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO crawler_sources (
            source_id, name, jurisdiction, state, county, source_family, base_url, seed_urls, enabled, tags, configuration
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (source_id) DO UPDATE SET
            name = excluded.name,
            jurisdiction = excluded.jurisdiction,
            state = excluded.state,
            county = excluded.county,
            source_family = excluded.source_family,
            base_url = excluded.base_url,
            seed_urls = excluded.seed_urls,
            enabled = excluded.enabled,
            tags = excluded.tags,
            configuration = excluded.configuration
        `
      : `
          INSERT OR REPLACE INTO crawler_sources (
            source_id, name, jurisdiction, state, county, source_family, base_url, seed_urls, enabled, tags, configuration
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `

  const insertSource = db.prepare(insertSourceSql)
  for (const s of selectedSources) {
    await insertSource.run(
      s.source_id,
      s.name,
      s.jurisdiction,
      s.state,
      s.county,
      s.source_family,
      s.base_url,
      JSON.stringify(s.seed_urls || []),
      Boolean(s.enabled),
      JSON.stringify(s.tags || []),
      JSON.stringify(s.configuration || {}),
    )
  }

  await db.prepare(
    `
      INSERT INTO crawl_runs (
        crawl_run_id, started_at, status, mode, scope,
        sources_attempted, sources_succeeded, sources_failed,
        programs_extracted, programs_normalized, programs_upserted, versions_created, failures_count
      ) VALUES (?, ?, 'running', ?, ?, 0, 0, 0, 0, 0, 0, 0, 0)
    `,
  ).run(
    runId,
    nowIso(),
    mode,
    JSON.stringify({
      state,
      useLiveSources,
      maxSources,
      maxUrlsPerSource,
      timeoutSeconds,
    }),
  )

  const robots = new RobotsCache({ ttlMs: 6 * 60 * 60 * 1000 })
  const fetcher = createFetcher({
    timeoutMs: timeoutSeconds * 1000,
    perHostConcurrency: mode === 'NATIONAL_MODE' ? 3 : 2,
    perHostMinDelayMs: mode === 'NATIONAL_MODE' ? 700 : 900,
    maxRetries: mode === 'SMOKE_MODE' ? 1 : 2,
  })

  const counts = {
    sources_attempted: 0,
    sources_succeeded: 0,
    sources_failed: 0,
    programs_extracted: 0,
    programs_normalized: 0,
    programs_upserted: 0,
    versions_created: 0,
    failures: [],
  }

  const insertEvent = db.prepare(
    `
      INSERT INTO crawl_events (crawl_run_id, source_id, url, event_type, message, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  )

  const insertFailure = db.prepare(
    `
      INSERT INTO parse_failures (
        crawl_run_id, source_id, url, failure_type, parser_name, http_status, retry_count, stack, message, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )

  const updateRun = async (finalStatus) => {
    await db.prepare(
      `
        UPDATE crawl_runs
        SET completed_at = ?,
            status = ?,
            sources_attempted = ?,
            sources_succeeded = ?,
            sources_failed = ?,
            programs_extracted = ?,
            programs_normalized = ?,
            programs_upserted = ?,
            versions_created = ?,
            failures_count = ?
        WHERE crawl_run_id = ?
      `,
    ).run(
      nowIso(),
      finalStatus,
      counts.sources_attempted,
      counts.sources_succeeded,
      counts.sources_failed,
      counts.programs_extracted,
      counts.programs_normalized,
      counts.programs_upserted,
      counts.versions_created,
      counts.failures.length,
      runId,
    )
  }

  try {
    await logs.crawl(`[run=${runId}] start mode=${mode} sources=${selectedSources.length} live=${useLiveSources}`)

    for (const source of selectedSources) {
      counts.sources_attempted += 1
      await insertEvent.run(runId, source.source_id, null, 'source_start', 'Starting source', JSON.stringify({ source }))
      await logs.crawl(`[run=${runId}] source_start ${source.source_id} ${source.name}`)

      try {
        const urls = (source.seed_urls || []).slice(0, maxUrlsPerSource)
        let anySuccess = false

        for (const url of urls) {
          try {
            await insertEvent.run(runId, source.source_id, url, 'fetch_start', 'Fetching', JSON.stringify({ url }))
            await logs.crawl(`[run=${runId}] fetch_start ${source.source_id} url=${url}`)
          } catch (dbError) {
            await logs.crawl(`[run=${runId}] db_error during event logging: ${dbError.message}`)
          }

          let fetchResult
          let httpStatus = null
          let contentType = null
          let buffer
          let contentHash = null

          try {
            if (url.startsWith('mock://')) {
              // Mock sources are not allowed — fabricated funding data must never reach users.
              qualityLog.error(`[nationalCrawlerV2] Rejecting mock:// URL for source ${source.source_id}. Mock sources have been disabled.`)
              continue
            } else if (url.startsWith('file://')) {
              fetchResult = await fetchFileUrl(url)
              httpStatus = fetchResult.status
              contentType = fetchResult.contentType
              buffer = fetchResult.buffer
              contentHash = fetchResult.contentHash
            } else {
              const allowed = await robots.canFetch({
                fetcher,
                url,
                userAgent: 'grantflownationalcrawler/2.0',
              })
              if (!allowed) {
                throw new Error('Blocked by robots.txt policy')
              }

              const net = await fetchToBuffer(fetcher, url)
              httpStatus = net.status
              contentType = net.contentType
              buffer = net.buffer
              contentHash = sha256(buffer.toString('utf8'))

              // Dead-link / HTTP error detection (mandatory)
              if (!net.ok || (typeof httpStatus === 'number' && httpStatus >= 400)) {
                const statusLabel = typeof httpStatus === 'number' ? `HTTP ${httpStatus}` : 'HTTP error'
                const err = new Error(statusLabel)
                err.httpStatus = httpStatus
                throw err
              }
            }

            await insertEvent.run(runId, source.source_id, url, 'fetch_success', 'Fetched', JSON.stringify({ httpStatus, contentType }))
            await logs.crawl(`[run=${runId}] fetch_success ${source.source_id} status=${httpStatus} ct=${contentType || 'n/a'} url=${url}`)

            const { parser_name, extracted_text, doc } = await parseContent({
              url,
              contentType,
              buffer,
              sourceFamily: source.source_family,
            })

            await insertEvent.run(runId, source.source_id, url, 'parse_success', 'Parsed', JSON.stringify({ parser_name }))
            await logs.parse(`[run=${runId}] parse_success ${source.source_id} parser=${parser_name} url=${url}`)

            counts.programs_extracted += 1

            const fetchedAt = nowIso()
            const { normalizedByTrack } = normalizeProgram({
              source,
              url,
              extractedText: extracted_text,
              parsedDoc: doc,
              contentHash,
              fetchedAt,
              httpStatus,
              contentType,
              parserName: parser_name,
            })

            await insertEvent.run(runId, source.source_id, url, 'normalize_success', 'Normalized', JSON.stringify({ tracks: normalizedByTrack.map((n) => n.funding_track) }))
            await logs.normalize(`[run=${runId}] normalize_success ${source.source_id} tracks=${normalizedByTrack.map((n) => n.funding_track).join(',')} url=${url}`)

            for (const normalized of normalizedByTrack) {
              // Enforce Track A/B separation invariant
              if (normalized.funding_track === 'TRACK_A' && (normalized.provider_requirements !== null && normalized.provider_requirements !== undefined)) {
                await logs.normalize(`[run=${runId}] warning: TRACK_A record has provider_requirements, cleaning up`)
                normalized.provider_requirements = null
              }

              let upsert = null
              try {
                upsert = await upsertNormalizedProgram({
                  db,
                  crawlRunId: runId,
                  normalized,
                  contentHash,
                  httpStatus,
                  contentType,
                  parserName: parser_name,
                })
              } catch (upsertError) {
                await logs.normalize(`[run=${runId}] upsert_error ${source.source_id}: ${upsertError.message}`)
                counts.failures.push({ url, failure_type: 'database_error', message: upsertError.message, stack: upsertError.stack, parser_name: parser_name, retry_count: 0, source_id: source.source_id })
              }
              if ((upsert !== null && upsert !== undefined)) {
                counts.programs_normalized += 1
                counts.programs_upserted += 1
                counts.versions_created += upsert.versions_created

                // Bridge into the canonical funding catalog (reality gate +
                // dedupe) so V2 programs reach the Discover Grants UI (G3).
                // Never let a catalog write abort the crawl.
                try {
                  const catalogResult = await bridgeProgramToCatalog({
                    db,
                    track: normalized.funding_track === 'TRACK_B' ? 'PROVIDER' : 'CLIENT',
                    program: {
                      program_name: normalized.program_name,
                      jurisdiction: normalized.jurisdiction,
                      state: normalized.state,
                      administering_agency: normalized.administering_agency,
                      program_type: normalized.program_type,
                      eligible_population: Array.isArray(normalized.eligible_population)
                        ? normalized.eligible_population.join('; ')
                        : normalized.eligible_population,
                      covered_services: Array.isArray(normalized.covered_services)
                        ? normalized.covered_services.join('; ')
                        : normalized.covered_services,
                      application_method: normalized.application_url || normalized.application_method,
                      source_url: normalized.source_url,
                    },
                    agent: { administeringAgency: normalized.administering_agency },
                  })
                  if (!catalogResult?.inserted && !catalogResult?.updated && catalogResult?.reason) {
                    await logs.normalize(`[run=${runId}] catalog_skip ${source.source_id} reason=${catalogResult.reason}`)
                  }
                } catch (bridgeError) {
                  await logs.normalize(`[run=${runId}] catalog_bridge_error ${source.source_id}: ${bridgeError.message}`)
                }
              }
            }

            anySuccess = true
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const stack = error instanceof Error ? error.stack : null
            const failureType =
              typeof error?.httpStatus === 'number' || (typeof httpStatus === 'number' && httpStatus >= 400)
                ? 'http_error'
                : url.startsWith('http')
                ? 'fetch_error'
                : 'parse_error'
            counts.failures.push({ url, failure_type: failureType, message, stack, parser_name: null, retry_count: 0, source_id: source.source_id })

            await insertEvent.run(runId, source.source_id, url, 'parse_failure', 'Failed', JSON.stringify({ message }))
            await insertFailure.run(
              runId,
              source.source_id,
              url,
              failureType,
              null,
              httpStatus,
              0,
              stack,
              message,
              JSON.stringify({}),
            )
            await logs.parse(`[run=${runId}] failure ${source.source_id} url=${url} error=${message}`)
          }
        }

        if (anySuccess) {
          counts.sources_succeeded += 1
          await insertEvent.run(runId, source.source_id, null, 'source_success', 'Source completed', JSON.stringify({}))
          await logs.crawl(`[run=${runId}] source_success ${source.source_id}`)
        } else {
          counts.sources_failed += 1
          await insertEvent.run(runId, source.source_id, null, 'source_failure', 'Source failed', JSON.stringify({}))
          await logs.crawl(`[run=${runId}] source_failure ${source.source_id}`)
        }
      } catch (error) {
        counts.sources_failed += 1
        const message = error instanceof Error ? error.message : String(error)
        await insertEvent.run(runId, source.source_id, null, 'source_failure', message, JSON.stringify({}))
        await logs.crawl(`[run=${runId}] source_failure ${source.source_id} error=${message}`)
      }
    }

    await updateRun('completed')

    const failuresPath = path.join(dir, 'failures.json')
    const samplePath = path.join(dir, 'sample_output.json')
    const failuresRunPath = path.join(dir, `failures.${runId}.json`)
    const sampleRunPath = path.join(dir, `sample_output.${runId}.json`)

    const sampleA = await db.prepare('SELECT * FROM nf_programs_a ORDER BY last_verified DESC LIMIT 5').all()
    const sampleB = await db.prepare('SELECT * FROM nf_programs_b ORDER BY last_verified DESC LIMIT 5').all()

    const failuresJson = JSON.stringify(counts.failures, null, 2)
    const sampleJson = JSON.stringify(
      {
        crawl_run_id: runId,
        mode,
        sources: selectedSources.map((s) => ({
          source_id: s.source_id,
          jurisdiction: s.jurisdiction,
          state: s.state,
          county: s.county,
        })),
        samples: { track_a: sampleA, track_b: sampleB },
      },
      null,
      2,
    )

    // Preserve per-run artifacts and update "latest" pointers (failures.json/sample_output.json)
    await safeWrite(failuresRunPath, failuresJson)
    await safeWrite(sampleRunPath, sampleJson)
    await safeWrite(failuresPath, failuresJson)
    await safeWrite(samplePath, sampleJson)

    await logs.crawl(`[run=${runId}] complete ok sources_ok=${counts.sources_succeeded}/${counts.sources_attempted} programs_upserted=${counts.programs_upserted}`)

    return {
      crawl_run_id: runId,
      artifacts_dir: dir,
      counts,
    }
  } catch (error) {
    await logs.crawl(`[run=${runId}] fatal error=${error instanceof Error ? error.message : String(error)}`)
    await updateRun('failed')
    throw error
  }
}

