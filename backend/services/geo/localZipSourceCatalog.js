/**
 * Local ZIP Source Catalog
 *
 * These are "real, verifiable" directory/search endpoints that a user can use
 * to locate local assistance for a specific ZIP code.
 *
 * They are intentionally ZIP-scoped and do NOT include national/statewide grant databases
 * (Grants.gov, Benefits.gov, etc). Those should be handled by separate crawlers.
 */

function safeZip(zip) {
  const z = String(zip || '').trim()
  return /^\d{5}$/.test(z) ? z : null
}

function makeDirectory({
  zip_code,
  source,
  source_id,
  title,
  sponsor,
  url,
  description,
  categories = [],
  keywords = [],
}) {
  const now = new Date().toISOString()
  return {
    title,
    sponsor,
    source,
    source_id,
    source_url: url,
    application_url: url,
    description,
    is_national: false,
    categories,
    keywords,
    opportunity_type: 'program',
    type: 'DIRECTORY',
    evidence_url: url,
    last_verified_at: now,
    record_origin: 'curated_verified',
    zip_code,
    requires_match: 0,
    requires_501c3: 0,
    contact_info: JSON.stringify({ website: url }),
  }
}

export function buildLocalZipSources(zipEntry) {
  const zip = safeZip(zipEntry?.zip_code ?? zipEntry?.zip)
  if (!zip) return []

  // NOTE: Not all of these endpoints support deep-linking with ZIP query params reliably.
  // We keep URLs conservative (landing/search pages) so they're always real and usable.
  // The ZIP code is stored on the record so the local crawler can surface them for that ZIP.
  const sources = [
    makeDirectory({
      zip_code: zip,
      source: 'zip_directory',
      source_id: `unitedway:${zip}`,
      title: `Find your local United Way (ZIP ${zip})`,
      sponsor: 'United Way',
      url: 'https://www.unitedway.org/find-your-united-way',
      description:
        'Use this locator to find the United Way serving your ZIP code for community and emergency assistance programs.',
      categories: ['community', 'local', 'directory'],
      keywords: ['united way', 'local', 'assistance', zip],
    }),
    makeDirectory({
      zip_code: zip,
      source: 'zip_directory',
      source_id: `feedingamerica:${zip}`,
      title: `Find your local food bank (ZIP ${zip})`,
      sponsor: 'Feeding America',
      url: 'https://www.feedingamerica.org/find-your-local-foodbank',
      description:
        'Use this locator to find the Feeding America food bank serving your ZIP code.',
      categories: ['food', 'local', 'directory'],
      keywords: ['food bank', 'food assistance', 'local', zip],
    }),
    makeDirectory({
      zip_code: zip,
      source: 'zip_directory',
      source_id: `cap:${zip}`,
      title: `Find a Community Action Agency (ZIP ${zip})`,
      sponsor: 'Community Action Partnership',
      url: 'https://communityactionpartnership.com/find-a-cap/',
      description:
        'Community Action Agencies help with housing, utilities, food, and employment services. Use this finder to locate one near you.',
      categories: ['poverty', 'utilities', 'housing', 'local', 'directory'],
      keywords: ['community action', 'utilities', 'housing', 'local', zip],
    }),
    makeDirectory({
      zip_code: zip,
      source: 'zip_directory',
      source_id: `salvationarmy:${zip}`,
      title: `Find Salvation Army services (ZIP ${zip})`,
      sponsor: 'The Salvation Army',
      url: 'https://www.salvationarmyusa.org/usn/plugins/gdosCenterSearch',
      description:
        'Use the Salvation Army locator to find local centers offering emergency assistance (rent, utilities, food, disaster relief).',
      categories: ['emergency', 'local', 'directory'],
      keywords: ['salvation army', 'emergency assistance', 'local', zip],
    }),
    makeDirectory({
      zip_code: zip,
      source: 'zip_directory',
      source_id: `hud_pha:${zip}`,
      title: `Find your local Public Housing Authority (ZIP ${zip})`,
      sponsor: 'HUD',
      url: 'https://www.hud.gov/program_offices/public_indian_housing/pha/contacts',
      description:
        'Use HUD’s Public Housing Authority contacts to locate Section 8 / housing voucher administrators and affordable housing programs near you.',
      categories: ['housing', 'local', 'directory'],
      keywords: ['hud', 'public housing authority', 'section 8', 'housing voucher', zip],
    }),
  ]

  return sources
}

export default { buildLocalZipSources }

