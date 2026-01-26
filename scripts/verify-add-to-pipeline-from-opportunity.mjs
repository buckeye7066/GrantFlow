/**
 * Lightweight verification:
 * - hits POST /api/grants/from-opportunity with a directory-style opportunity payload
 * - expects 200/201 (never 500) and a returned grant id
 *
 * Usage:
 *   # in one terminal
 *   npm run backend
 *
 *   # in another terminal
 *   node scripts/verify-add-to-pipeline-from-opportunity.mjs http://localhost:8080
 *
 * Notes:
 * - Requires you to be authenticated in that backend (cookie/JWT) depending on your setup.
 * - If you're not authenticated, it will return 401 and the script will fail (expected).
 */
const baseUrl = process.argv[2] || 'http://localhost:8080'

async function main() {
  const res = await fetch(`${baseUrl}/api/grants/from-opportunity`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // NOTE: If your backend uses bearer tokens locally, add:
      // authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      opportunity_id: null,
      profile_id: process.env.PROFILE_ID || null,
      organization_id: process.env.ORGANIZATION_ID || null,
      match_score: 85,
      match_reasons: ['Directory resource (test)'],
      opportunity_data: {
        title: 'Test Directory Resource (United Way Locator)',
        sponsor: 'United Way',
        deadline: null,
        url: 'https://www.unitedway.org/find-your-united-way',
        awardMin: null,
        awardMax: null,
        descriptionMd: 'Test directory resource for pipeline insertion.',
        eligibilityBullets: [],
        source: 'local_funding',
      },
    }),
  })

  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // keep raw text
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  if (!json?.id) {
    throw new Error(`Expected response with id, got: ${text}`)
  }

  console.log('[verify] ok', { status: res.status, id: json.id, already_exists: Boolean(json.already_exists) })
}

main().catch((err) => {
  console.error('[verify] failed', err?.message || err)
  process.exitCode = 1
})

