/**
 * SCRATCH — driver to test Hamilton's MTSU portal sync for Anastasia on prod.
 * Run via:  railway run --service GrantFlow node scripts/test-mtsu-sync-anastasia.mjs
 *
 * Reads ADMIN_TOKEN from the injected prod env (never prints it), then:
 *   1. lists profiles, finds "Anastasia"
 *   2. lists her saved Hamilton sessions (the "watched login"), picks the MTSU host
 *   3. triggers a READ-only portal sync (pulls data OUT of MTSU; pushes nothing)
 *   4. reports the run result + persists
 * This exercises the MTSU connector's session-application + LLM extraction path.
 */
const BASE = process.env.GRANTFLOW_API_BASE || 'https://grantflow-production.up.railway.app'
const TOKEN = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || process.env.GRANTFLOW_ADMIN_TOKEN

if (!TOKEN) {
  console.error('No ADMIN_TOKEN in env — run via `railway run` (prod env injection).')
  process.exit(2)
}

const H = {
  Authorization: `Bearer ${TOKEN}`,
  'X-Admin-Token': TOKEN,
  'Content-Type': 'application/json',
}

async function j(r) {
  const t = await r.text()
  let body
  try { body = JSON.parse(t) } catch { body = t }
  return { status: r.status, body }
}

function looksMtsu(s) {
  const hay = JSON.stringify(s)
  return /mtsu/i.test(hay)
}

async function main() {
  // 1. Find Anastasia's profile.
  console.log('--- listing profiles (admin) ---')
  const pr = await j(await fetch(`${BASE}/api/profiles?limit=1000`, { headers: H }))
  if (pr.status !== 200) { console.error('profiles list failed:', pr.status, JSON.stringify(pr.body)); process.exit(3) }
  const profiles = Array.isArray(pr.body) ? pr.body : (pr.body?.profiles || [])
  const cand = profiles.filter((p) => /anastasia/i.test(`${p.display_name || ''} ${p.name || ''} ${p.primary_email || ''}`))
  console.log('Anastasia candidates:', cand.map((p) => ({ id: p.id, name: p.display_name, email: p.primary_email })))
  const anastasiaId = cand[0]?.id
  if (!anastasiaId) { console.error('No Anastasia profile found.'); process.exit(4) }
  console.log('Using profileId =', anastasiaId)

  // 2. List her saved Hamilton sessions (watched logins) + student portals.
  const sr = await j(await fetch(`${BASE}/api/hamilton/automation/sessions?profileId=${anastasiaId}`, { headers: H }))
  const sessions = sr.body?.sessions || []
  console.log('--- saved Hamilton sessions ---')
  for (const s of sessions) console.log(JSON.stringify({ id: s.id, host: s.host || s.portal_host || s.portalHost, has_storage_state: s.has_storage_state, expires: s.expires_at, created: s.created_at }, null, 0))
  const mtsuSession = sessions.find(looksMtsu)
  let portalHost = mtsuSession?.host || mtsuSession?.portal_host || mtsuSession?.portalHost || null

  if (!portalHost) {
    // Fallback: look at student portals.
    const sp = await j(await fetch(`${BASE}/api/profiles/${anastasiaId}/school-portals`, { headers: H })).catch(() => null)
    const portals = sp?.body?.portals || sp?.body || []
    const arr = Array.isArray(portals) ? portals : []
    const m = arr.find((p) => /mtsu/i.test(JSON.stringify(p)))
    portalHost = m && (m.portal_url || m.login_url || m.application_url || '').replace(/^https?:\/\//, '').split('/')[0]
  }

  if (!portalHost) { console.error('No MTSU session or portal found for Anastasia.'); process.exit(5) }
  // Normalize to a bare host (strip path/scheme).
  portalHost = String(portalHost).replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
  console.log('Using portalHost =', portalHost)

  if (process.env.RUN_SYNC === '1') {
    // 3. Trigger a READ sync. Outlive the HTTP edge timeout: if the response
    // aborts/504s, the prod handler keeps running and persists — we then poll.
    console.log('--- triggering READ portal-sync ---')
    let sync = null
    try {
      const ctrl = new AbortController()
      const to = setTimeout(() => ctrl.abort(), 120000)
      sync = await j(await fetch(`${BASE}/api/hamilton/portal-sync/sync`, {
        method: 'POST', headers: H, signal: ctrl.signal,
        body: JSON.stringify({ profileId: anastasiaId, portalHost, direction: 'read' }),
      }))
      clearTimeout(to)
    } catch (e) { console.log('sync fetch aborted/errored (will poll runs):', e?.name || e?.message) }
    if (sync) console.log('SYNC RESPONSE:', sync.status, JSON.stringify(sync.body, null, 2))

    // 4. Poll runs (the sync can outlive the HTTP edge timeout).
    await new Promise((r) => setTimeout(r, 3000))
    const rr = await j(await fetch(`${BASE}/api/hamilton/portal-sync/runs?profileId=${anastasiaId}&portalHost=${portalHost}`, { headers: H }))
    console.log('--- recent runs ---')
    console.log(JSON.stringify(rr.body, null, 2))
  } else {
    console.log('\nRUN_SYNC != 1 — skipped the live sync (dry probe only).')
    console.log('To drive the real MTSU READ sync, re-run with RUN_SYNC=1.')
  }
}

main().catch((e) => { console.error('FAILED:', e?.stack || e); process.exit(1) })
