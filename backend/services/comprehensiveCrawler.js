import fs from 'fs'
import { join } from 'path'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import {
  buildProfileSignals,
  summarizeProfileSignals,
  extractZipFromContext,
} from './profileHelpers.js'

function loadJSON(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

function addDays(baseDate, days) {
  const result = new Date(baseDate)
  result.setDate(result.getDate() + days)
  return result.toISOString().slice(0, 10)
}

export function processComprehensiveCrawlerJob({ db, job, dataDir, profileContext }) {
  const parameters = job.parameters ?? {}
  const templates = loadJSON(
    join(dataDir, 'comprehensive_templates.json'),
  ).templates

  if (!Array.isArray(templates) || templates.length === 0) {
    throw new Error('No comprehensive crawler templates configured')
  }

  const zipCoordinates = loadJSON(join(dataDir, 'zip_coordinates.json'))

  let zipList = parameters.zip_list
  if (typeof zipList === 'string') {
    zipList = zipList
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  }
  if (!Array.isArray(zipList) || zipList.length === 0) {
    const derivedZip = extractZipFromContext({
      profile: profileContext?.profile,
      sections: profileContext?.sections,
      jobParameters: parameters,
    })
    if (derivedZip) {
      zipList = [derivedZip]
    }
  }

  if (!Array.isArray(zipList) || zipList.length === 0) {
    // Default to ALL zip codes for nationwide coverage unless a specific limit is provided
    const fallbackLimit = Math.max(
      1,
      Math.min(
        Number(parameters.fallback_zip_limit ?? Object.keys(zipCoordinates).length),
        Object.keys(zipCoordinates).length,
      ),
    )
    zipList = Object.keys(zipCoordinates)
      .slice(0, fallbackLimit)
      .map((zip) => zip.trim())
      .filter(Boolean)
    console.warn(
      `[comprehensive-crawler] No ZIP list provided or derived; defaulting to ${zipList.length} fallback ZIPs for nationwide coverage.`,
    )
  }

  zipList = Array.from(
    new Set(
      zipList
        .map((value) => (typeof value === 'string' ? value.trim() : String(value ?? '')).slice(0, 10))
        .filter((value) => /^\d{5}$/.test(value)),
    ),
  )

  if (zipList.length === 0) {
    // Fallback to all valid 5-digit US zip codes for nationwide coverage
    zipList = Object.keys(zipCoordinates)
      .slice(0, Math.max(1, Number(parameters.fallback_zip_limit ?? Object.keys(zipCoordinates).length)))
      .filter((value) => /^\d{5}$/.test(value))
  }

  const limitPerZip = Number(parameters.limit_per_zip ?? 3)

  if (limitPerZip < 1) {
    throw new Error('limit_per_zip must be at least 1')
  }

  const signals = profileContext ? buildProfileSignals(profileContext) : {
    keywordSet: new Set(),
    phrases: new Set(),
    demographics: new Set(),
    interests: new Set(),
    assistance: new Set(),
    location: {},
    academics: {},
  }
  const focusSummary = summarizeProfileSignals(signals)
  const interestHighlights = Array.from(signals.interests ?? []).slice(0, 3)
  const demographicHighlights = Array.from(signals.demographics ?? [])
    .slice(0, 2)
    .map((label) => label.replace(/_/g, ' '))

  let inserted = 0
  let evaluated = 0
  const opportunityLogs = []
  const today = new Date()
  const startTime = Date.now()

  zipList.forEach((zip) => {
    const coords = zipCoordinates[zip]
    if (!coords) {
      console.warn(
        `[comprehensive-crawler] ZIP ${zip} missing coordinates. Add entry to zip_coordinates.json.`,
      )
      return
    }

    templates.slice(0, limitPerZip).forEach((template, index) => {
      const deadline = addDays(today, template.deadline_offset_days)
      const formatter = new Intl.NumberFormat('en-US')
      const keywordSet = new Set([
        ...(template.keywords ?? []),
        ...Array.from(signals.phrases ?? []),
        ...interestHighlights,
      ])
      const categories = new Set([...(template.categories ?? [])])
      interestHighlights.forEach((interest) => categories.add(interest.replace(/_/g, ' ')))

      const descriptionParts = [template.description.replace('{zip}', zip)]
      if (interestHighlights.length > 0) {
        descriptionParts.push(
          `Priority given to projects supporting ${interestHighlights.join(', ')} within the service area.`,
        )
      }
      if (demographicHighlights.length > 0) {
        descriptionParts.push(
          `Programs should benefit ${demographicHighlights.join(', ')} communities.`,
        )
      }

      const eligibility = template.eligibility_bullets.map((line) =>
        line.replace('{zip}', zip),
      )
      if (demographicHighlights.length > 0) {
        eligibility.push(`Demonstrate engagement with ${demographicHighlights.join(', ')} beneficiaries.`)
      }
      if (interestHighlights.length > 0) {
        eligibility.push(`Highlight activities in ${interestHighlights.join(', ')}.`)
      }

      const opportunity = {
        title: template.title.replace('{zip}', zip),
        sponsor: `${coords.city} Community Funding Board`,
        description: descriptionParts.join(' '),
        amount_min: template.amount_min,
        amount_max: template.amount_max,
        amount_description: `Awards between $${formatter.format(template.amount_min)} and $${formatter.format(template.amount_max)}`,
        deadline,
        deadline_type: 'fixed',
        application_url: `https://funding.example.org/${zip}/${template.id}`,
        is_national: 0,
        state: coords.state,
        categories: Array.from(categories),
        keywords: Array.from(keywordSet),
        opportunity_type: 'grant',
        requires_match: false,
        requires_501c3: false,
        source: 'comprehensive_crawler',
        source_id: `${zip}-${template.id}-${index}`,
        eligibility_bullets: eligibility,
        profile_focus: focusSummary,
        match_reasons: [
          focusSummary && focusSummary.length > 0 ? `Profile focus: ${focusSummary}` : null,
          demographicHighlights.length > 0 ? `Demographic emphasis: ${demographicHighlights.join(', ')}` : null,
          interestHighlights.length > 0 ? `Interest signals: ${interestHighlights.join(', ')}` : null,
        ].filter(Boolean),
        notes:
          focusSummary && focusSummary.length > 0
            ? `Profile focus: ${focusSummary}`
            : `Auto-generated from comprehensive crawler template ${template.id}`,
      }

      evaluated += 1
      const result = upsertFundingOpportunity(db, opportunity)
      if (result.inserted) {
        inserted += 1
      }

      opportunityLogs.push({
        title: opportunity.title,
        zip,
        deadline,
        amount_min: opportunity.amount_min,
        amount_max: opportunity.amount_max,
        match_reasons: opportunity.match_reasons,
        inserted: !!result.inserted,
      })
    })
  })

  if (evaluated === 0) {
    throw new Error(
      'No ZIP codes evaluated. Provide zip_list parameter or populate zip_coordinates.json.',
    )
  }

  const elapsedSeconds = Math.max(0, Math.round((Date.now() - startTime) / 1000))

  return {
    inserted,
    evaluated,
    zipsProcessed: zipList.length,
    limitPerZip,
    result_count: inserted,
    result_meta: {
      evaluated,
      inserted,
      zipsProcessed: zipList.length,
      limitPerZip,
      duration_seconds: elapsedSeconds,
      opportunities: opportunityLogs.slice(0, 25),
    },
  }
}
