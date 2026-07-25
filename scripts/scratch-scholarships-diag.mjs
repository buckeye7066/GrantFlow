// Diagnostic: why can't Hamilton log into scholarships.com after side-by-side login?
// Run: railway run node scratch-scholarships-diag.mjs
const BASE = process.env.GRANTFLOW_API_BASE || 'https://grantflow-production.up.railway.app'
const TOKEN = process.env.GRANTFLOW_ADMIN_TOKEN || process.env.ADMIN_TOKEN
if (!TOKEN) { console.error('NO ADMIN TOKEN in env'); process.exit(1) }
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

async function j(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, { headers: H, ...opts })
  const t = await r.text()
  let body; try { body = JSON.parse(t) } catch { body = t }
  return { status: r.status, body }
}
const isSch = (s) => String(s || '').toLowerCase().includes('scholarships.com')

console.log('=== cloud-login status ===')
console.log(JSON.stringify((await j('/api/hamilton/automation/sessions/cloud-login/status')).body, null, 2))

console.log('\n=== admin vault credentials (scholarships.com) ===')
const adminCreds = await j('/api/hamilton/automation/admin/credentials')
if (adminCreds.status !== 200) console.log('status', adminCreds.status, adminCreds.body)
else {
  const list = adminCreds.body?.credentials || adminCreds.body?.rows || []
  console.log('total admin creds:', list.length)
  for (const c of list.filter(c => isSch(c.portal_host || c.portalHost || c.host)))
    console.log(' •', JSON.stringify(c))
}

console.log('\n=== profiles ===')
const profs = await j('/api/profiles')
const plist = Array.isArray(profs.body) ? profs.body : (profs.body?.profiles || profs.body?.rows || [])
console.log('profiles fetched:', plist.length, '(status', profs.status + ')')

for (const p of plist) {
  const pid = p.id || p.profile_id
  if (!pid) continue
  const name = p.name || p.display_name || p.full_name || pid
  const sessions = await j(`/api/hamilton/automation/sessions?profileId=${encodeURIComponent(pid)}`)
  const creds = await j(`/api/hamilton/automation/credentials?profileId=${encodeURIComponent(pid)}`)
  const sList = (sessions.body?.sessions || []).filter(s => isSch(s.portal_host || s.portalHost || s.host))
  const cList = (creds.body?.credentials || []).filter(c => isSch(c.portal_host || c.portalHost || c.host))
  if (sList.length || cList.length) {
    console.log(`\n--- ${name} (${pid}) ---`)
    for (const s of sList) console.log('  SESSION:', JSON.stringify(s))
    for (const c of cList) console.log('  CRED   :', JSON.stringify(c))
  }
}
console.log('\n=== done ===')
