import Database from 'better-sqlite3'
import path from 'path'

const dbPath = path.join('backend', 'data', 'grantflow.db')
const db = new Database(dbPath)

function findProfileIdWithState() {
  const rows = db
    .prepare(
      `
        SELECT profile_id, section_key, data
        FROM profile_sections
        WHERE section_key IN ('basic_information', 'location_focus')
        ORDER BY updated_at DESC
        LIMIT 500
      `,
    )
    .all()

  // Use the same extraction logic as the backend crawlers.
  // Note: imported dynamically to avoid ESM import ordering issues in this small script.
  // eslint-disable-next-line no-use-before-define
  const { extractStateFromContext } = stateExtractor

  for (const row of rows) {
    try {
      const data = JSON.parse(row.data)
      const sections = {
        [row.section_key]: data,
      }
      const state = extractStateFromContext({ profile: {}, sections, jobParameters: {} })
      if (state) {
        return row.profile_id
      }
    } catch {
      // ignore
    }
  }
  return null
}

const stateExtractor = await import('../backend/services/profileHelpers.js')

const profileId = findProfileIdWithState()
if (!profileId) {
  const keys = db
    .prepare(
      `
        SELECT section_key, COUNT(*) AS count
        FROM profile_sections
        GROUP BY section_key
        ORDER BY count DESC
        LIMIT 25
      `,
    )
    .all()
  console.log('No profile with state found in profile_sections; cannot smoke-test local crawler.')
  console.log('Top profile_sections keys:', keys)

  const samples = db
    .prepare(
      `
        SELECT section_key, data
        FROM profile_sections
        WHERE section_key IN ('basic_information', 'location_focus')
        ORDER BY updated_at DESC
        LIMIT 3
      `,
    )
    .all()
    .map((row) => {
      let parsed = null
      try {
        parsed = JSON.parse(row.data)
      } catch {
        parsed = null
      }
      return {
        section_key: row.section_key,
        keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 30) : null,
        preview: row.data.slice(0, 220),
      }
    })
  console.log('Sample basic/location section payloads:', samples)
  process.exit(0)
}

const { loadProfileContext } = await import('../backend/services/profileHelpers.js')
const { processLocalCrawlerJob } = await import('../backend/services/localCrawler.js')

const dataDir = path.resolve('backend', 'data', 'crawlers')
const profileContext = loadProfileContext(db, profileId)

const before = db.prepare('SELECT COUNT(*) AS c FROM funding_opportunities WHERE is_active = 1').get().c
const result = processLocalCrawlerJob({
  db,
  job: { id: 'smoke-local', parameters: {} },
  dataDir,
  profileContext,
})
const after = db.prepare('SELECT COUNT(*) AS c FROM funding_opportunities WHERE is_active = 1').get().c

console.log({
  profileId,
  resolvedState:
    profileContext?.profile?.state ??
    profileContext?.sections?.location_focus?.state ??
    null,
  before,
  after,
  delta: after - before,
  result,
})

