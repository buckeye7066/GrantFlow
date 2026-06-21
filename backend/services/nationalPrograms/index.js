import crypto from 'crypto'
import { RateLimitedFetcher } from './fetcher.js'
import { parseHtmlToText } from './parsers/html.js'
import { parsePdfToText } from './parsers/pdf.js'
import { parseDocxToText } from './parsers/docx.js'
import { normalizeFromDocument } from './normalize.js'
import { upsertProgramWithVersion } from './store.js'
import { auditLog } from './audit.js'
import { bridgeProgramToCatalog } from './catalogBridge.js'
import { federalAgent } from './agents/federal.js'
import { tennesseeAgent } from './agents/tn.js'

function sha256(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex')
}

function isLikelyProgramUrl(url) {
  const u = url.toLowerCase()
  return (
    u.includes('medicaid') ||
    u.includes('waiver') ||
    u.includes('hcbs') ||
    u.includes('benefit') ||
    u.includes('assistance') ||
    u.includes('program') ||
    u.includes('reimbursement') ||
    u.includes('provider') ||
    u.includes('caregiver') ||
    u.includes('choices')
  )
}

function sameHost(a, b) {
  try {
    return new URL(a).host === new URL(b).host
  } catch {
    return false
  }
}

async function parseResponseToDocument(url, response, buffer) {
  const contentTypeHeader = response?.headers?.get?.('content-type') || ''
  const contentType = contentTypeHeader.split(';')[0].trim().toLowerCase()

  if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
    return { ...(await parsePdfToText(buffer)), contentType: contentType || 'application/pdf' }
  }
  if (
    contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
    url.toLowerCase().endsWith('.docx')
  ) {
    return { ...(await parseDocxToText(buffer)), contentType }
  }
  // default html-ish
  const html = buffer.toString('utf8')
  return parseHtmlToText(html, { url })
}

export async function processNationalProgramsJob({ db, job, dataDir }) {
  const startedAt = Date.now()

  const parameters = job?.parameters && typeof job.parameters === 'object' ? job.parameters : {}
  const maxUrls = Number.isFinite(parameters.max_urls) ? parameters.max_urls : 200
  const maxDepth = Number.isFinite(parameters.max_depth) ? parameters.max_depth : 2
  // Cap how many catalog opportunities a single run can emit, so one run can
  // never flood funding_opportunities. Defaults generously (1 per fetched URL).
  const maxOpportunities = Number.isFinite(parameters.max_opportunities)
    ? parameters.max_opportunities
    : maxUrls * 2
  const agentsRequested = Array.isArray(parameters.agents) ? parameters.agents : null

  const agents = [federalAgent, tennesseeAgent].filter((a) =>
    agentsRequested ? agentsRequested.includes(a.id) : true,
  )

  const fetcher = new RateLimitedFetcher({
    perHostConcurrency: 2,
    perHostMinDelayMs: 900,
    timeoutMs: 25000,
    maxRetries: 2,
  })

  const stats = {
    agents: agents.map((a) => a.id),
    fetched: 0,
    parsed: 0,
    programs_created: 0,
    programs_updated: 0,
    programs_unchanged: 0,
    crosslinks_created: 0,
    // Canonical catalog bridge (funding_opportunities) outcomes.
    catalog_inserted: 0,
    catalog_updated: 0,
    catalog_skipped: 0,
    catalog_skip_reasons: {},
    errors: [],
  }

  const bridgeToCatalog = async ({ track, payload, agent }) => {
    if (stats.catalog_inserted >= maxOpportunities) return
    try {
      const result = await bridgeProgramToCatalog({ db, track, program: payload, agent })
      if (result?.inserted) {
        stats.catalog_inserted += 1
      } else if (result?.updated) {
        stats.catalog_updated += 1
      } else {
        stats.catalog_skipped += 1
        const reason = result?.reason || 'unknown'
        stats.catalog_skip_reasons[reason] = (stats.catalog_skip_reasons[reason] || 0) + 1
      }
    } catch (bridgeError) {
      // Never let a catalog write abort the crawl — log + continue.
      stats.catalog_skipped += 1
      const reason = `bridge_error:${bridgeError instanceof Error ? bridgeError.message : String(bridgeError)}`
      stats.catalog_skip_reasons[reason] = (stats.catalog_skip_reasons[reason] || 0) + 1
    }
  }

  await auditLog({
    action: 'national_programs_job_start',
    job_id: job?.id,
    parameters,
    agents: stats.agents,
  })

  for (const agent of agents) {
    const queue = agent.seedUrls.map((url) => ({ url, depth: 0 }))
    const visited = new Set()

    while (queue.length > 0 && visited.size < maxUrls) {
      const { url, depth } = queue.shift()
      if (!url || visited.has(url)) continue
      visited.add(url)

      let response = null
      let buffer = null

      try {
        response = await fetcher.fetch(url)
        stats.fetched += 1

        const httpStatus = response?.status ?? null
        const contentType = response?.headers?.get?.('content-type') || null

        buffer = Buffer.from(await response.arrayBuffer())
        let doc;
        try {
          doc = await parseResponseToDocument(url, response, buffer)
        } catch (parseError) {
          stats.errors.push({
            url,
            agent: agent.id,
            error: `Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`
          })
          continue
        }
        stats.parsed += 1

        const normalized = normalizeFromDocument({
          agent,
          doc,
          url,
          jurisdiction: agent.jurisdiction,
          state: agent.state,
          county: null,
          administeringAgency: agent.administeringAgency,
        })

        // Upsert programs per inferred track(s) while keeping datasets separate
        const createdTracks = []
        const resultsByTrack = new Map()
        for (const track of normalized.tracks) {
          const payload =
            track === 'PROVIDER'
              ? {
                  ...normalized.base,
                  provider_requirements: normalized.base.provider_requirements || 'See source URL',
                }
              : { ...normalized.base }

          const upserted = await upsertProgramWithVersion({
            db,
            track,
            normalized: payload,
            extractedText: normalized.extracted_text,
            contentHash: normalized.content_hash,
            sourceUrlHash: normalized.source_url_hash || sha256(url),
            httpStatus,
            contentType,
            fetchedAt: new Date().toISOString(),
          })
          resultsByTrack.set(track, upserted)
          createdTracks.push(track)

          if (upserted.change_type === 'created') stats.programs_created += 1
          else if (upserted.change_type === 'updated') stats.programs_updated += 1
          else stats.programs_unchanged += 1

          // Bridge every real program into the canonical funding catalog so it
          // reaches the Discover Grants UI (G3) through the mandatory reality
          // gate + dedupe. Skips (no URL / no sponsor / loan / placeholder /
          // duplicate) are counted with their reason — never silently dropped.
          await bridgeToCatalog({ track, payload, agent })
        }

        // If page yields both tracks, auto-crosslink (but keep tables separate)
        if (createdTracks.includes('CLIENT') && createdTracks.includes('PROVIDER')) {
          const a = resultsByTrack.get('CLIENT')
          const b = resultsByTrack.get('PROVIDER')
          try {
            await db.prepare(
              `
                INSERT INTO program_crosslinks (
                  client_program_id,
                  provider_program_id,
                  relationship_type,
                  evidence_url,
                  notes
                ) VALUES (?, ?, ?, ?, ?)
              `,
            ).run(
              a.program_id,
              b.program_id,
              'related_same_source_url',
              url,
              'Auto-linked because a single source URL contained both client-facing and provider-facing signals.',
            )
            stats.crosslinks_created += 1
          } catch (crosslinkError) {
            stats.errors.push({
              url,
              agent: agent.id,
              error: `Crosslink creation failed: ${crosslinkError instanceof Error ? crosslinkError.message : String(crosslinkError)}`
            })
          }
        }

        // Discovery: enqueue links (same host, limited depth, keyword-filtered)
        if (depth < maxDepth && Array.isArray(doc.links) && doc.links.length > 0) {
          for (const link of doc.links) {
            if (!sameHost(url, link)) continue
            if (!isLikelyProgramUrl(link)) continue
            if (visited.has(link)) continue
            queue.push({ url: link, depth: depth + 1 })
            if (visited.size + queue.length >= maxUrls) break
          }
        }
      } catch (error) {
        stats.errors.push({
          url,
          agent: agent.id,
          error: error instanceof Error ? error.message : String(error),
        })
        await auditLog({
          action: 'fetch_or_parse_error',
          job_id: job?.id,
          agent: agent.id,
          url,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  await auditLog({
    action: 'national_programs_job_complete',
    job_id: job?.id,
    stats,
    duration_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
  })

  return {
    inserted: stats.programs_created,
    result_meta: {
      mode: 'programs',
      ...stats,
    },
  }
}

