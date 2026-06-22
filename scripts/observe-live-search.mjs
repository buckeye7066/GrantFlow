/**
 * Observation harness — runs a LIVE funding search for a Robert White-style
 * profile and shows, per source, what comes back and what survives the 80%
 * slider. Read-only: hits the real external APIs (Grants.gov search2 +
 * DuckDuckGo need no key), scores with the canonical engine, applies the floor.
 * Not committed as product code — a diagnostic the owner asked for.
 */
import { searchLiveFederalByProfile } from '../backend/services/shared/liveFederalSearch.js'
import { searchLocalWebByProfile, buildLocalFundingQueries } from '../backend/services/shared/liveWebSearch.js'
import { buildGrantsGovQueryTerms } from '../backend/services/sourceRegistry.js'
import { scoreOpportunity } from '../backend/services/matchEngine.js'

const MIN_SCORE = 80 // slider at 80%

// Robert White (from project memory): paramedic @ Bradley County EMS, student at
// Cleveland State Community College, Cleveland TN (Bradley County).
const profileContext = {
  profile: {
    id: 'robert-white-test',
    display_name: 'Robert White',
    primary_type: 'individual',
    state: 'TN',
    city: 'Cleveland',
  },
  signals: {
    location: { city: 'Cleveland', county: 'Bradley', state: 'TN', zip: '37312' },
    needs: ['paramedic training', 'emergency medical services', 'continuing education'],
    interests: ['ems', 'first responder', 'healthcare'],
    applicantTypes: new Set(['individual', 'student']),
    keywordSet: new Set(['paramedic', 'ems', 'emergency medical', 'first responder']),
    occupation: 'paramedic',
    employer: 'Bradley County EMS',
    school: 'Cleveland State Community College',
  },
}

const line = (s = '') => process.stdout.write(s + '\n')

line('=== PROFILE-DERIVED QUERY TERMS ===')
line('Federal (buildGrantsGovQueryTerms): ' + JSON.stringify(buildGrantsGovQueryTerms(profileContext, { limit: 8 })))
line('Local web (buildLocalFundingQueries): ' + JSON.stringify(buildLocalFundingQueries(profileContext)))
line('')

function summarize(label, opps) {
  const scored = opps.map((o) => {
    let s = null
    try { s = scoreOpportunity(profileContext, o) } catch (e) { s = { score: -1, _err: e.message } }
    return { title: (o.title || o.name || '').slice(0, 70), source: o.source, score: s?.score ?? null, reasons: (s?.reasons || []).slice(0, 3) }
  })
  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const passed = scored.filter((x) => (x.score ?? 0) >= MIN_SCORE)
  line(`=== ${label}: ${opps.length} acquired, ${passed.length} pass @${MIN_SCORE}% ===`)
  line('Top 8 by score:')
  for (const x of scored.slice(0, 8)) {
    line(`  [${String(x.score).padStart(3)}] (${x.source}) ${x.title}`)
    if (x.reasons.length) line(`        reasons: ${x.reasons.join(' | ')}`)
  }
  const dist = scored.reduce((acc, x) => { const b = Math.floor((x.score ?? 0) / 10) * 10; acc[b] = (acc[b] || 0) + 1; return acc }, {})
  line('Score distribution (by 10s): ' + JSON.stringify(dist))
  line('')
  return { scored, passed }
}

const t0 = Date.now()
line('Running live federal search (Grants.gov/SAM/USASpending/NIH)...')
let federal = { opportunities: [], debug: {} }
try { federal = await searchLiveFederalByProfile(profileContext, { timeoutMs: 20000 }) }
catch (e) { line('FEDERAL ERROR: ' + e.message) }
line('federal debug: ' + JSON.stringify(federal.debug))
summarize('FEDERAL', federal.opportunities || [])

line('Running local web search (DuckDuckGo/Brave)...')
let web = { opportunities: [], debug: {} }
try { web = await searchLocalWebByProfile(profileContext, { timeoutMs: 20000 }) }
catch (e) { line('WEB ERROR: ' + e.message) }
line('web debug: ' + JSON.stringify(web.debug))
summarize('WEB', web.opportunities || [])

line(`Total wall-clock: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
