/**
 * SCRATCH — enumerate prod's `unanswered_unreadable` active-pipeline grants
 * (the "83 READ-but-unparseable rows" Anya finding) plus per-row failure detail.
 *
 * Intended to run INSIDE the prod container (postgres.railway.internal is not
 * resolvable locally):
 *   railway ssh --service GrantFlow -- "node /dev/stdin" < scripts/probe-prod-amount-residual.mjs
 * Reads DATABASE_URL from the container env. Prints JSON summaries only.
 */
import pg from 'pg'

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

// Mirror the pipeline.amountCoverage census predicates (samRegistry.js).
const AMY = "NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = g.profile_id AND p.created_by = 'agent:amy')"
const V = `(COALESCE(g.amount_requested, g.amount_max, g.amount_min, 0))`
const isDir = `LOWER(COALESCE(fo.opportunity_kind, '')) IN ('directory','benefit')`
const nonePub = `(COALESCE(g.amount_status,'')='none_published' OR COALESCE(fo.amount_status,'')='none_published')`
const honestLabel = `(COALESCE(g.amount_status,'') IN ('varies','contact_required','estimated') OR COALESCE(g.amount_text,'')<>'' OR COALESCE(fo.amount_status,'') IN ('varies','contact_required','estimated') OR COALESCE(fo.amount_text,'')<>'')`
const unanswered = `${V}=0 AND NOT ${isDir} AND NOT ${nonePub} AND NOT ${honestLabel}`
const attempted = `COALESCE(fo.amount_enrich_attempted_at, g.amount_enrich_attempted_at)`
const attemptCount = `COALESCE(fo.amount_enrich_attempts, g.amount_enrich_attempts, 0)`
const envAttemptCount = `COALESCE(fo.amount_enrich_env_attempts, g.amount_enrich_env_attempts, 0)`

const STATUS = `('discovered','queued','reviewing','applying','submitted','awarded','rejected','waiting')`

const { rows: byHost } = await db.query(`
  SELECT
    CASE
      WHEN COALESCE(fo.source_url, fo.application_url, g.application_url, g.portal_url, '') = '' THEN 'NONE'
      ELSE lower((regexp_split_to_array(
         regexp_replace(regexp_replace(COALESCE(fo.source_url, fo.application_url, g.application_url, g.portal_url, ''), '^https?://', ''), '^www\\.', ''),
         '/',''))[1])
    END AS host,
    COUNT(*) AS n
  FROM grants g
  LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
  WHERE g.status IN ${STATUS}
    AND ${AMY}
    AND ${unanswered} AND ${attempted} IS NOT NULL
  GROUP BY 1 ORDER BY n DESC`)

const { rows: detail } = await db.query(`
  SELECT g.id AS grant_id, g.profile_id, g.status, fo.id AS fo_id,
    fo.source, fo.source_id, fo.record_origin,
    COALESCE(fo.source_url, fo.application_url, g.application_url, g.portal_url) AS url,
    fo.amount_status AS fo_status, g.amount_status AS g_status,
    g.amount_enrich_attempts AS g_attempts, fo.amount_enrich_attempts AS fo_attempts,
    g.amount_enrich_env_attempts AS g_env, fo.amount_enrich_env_attempts AS fo_env,
    g.amount_enrich_attempted_at AS g_mark, fo.amount_enrich_attempted_at AS fo_mark,
    substr(COALESCE(fo.amount_text, g.amount_text,''),1,80) AS amount_text
  FROM grants g
  LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
  WHERE g.status IN ${STATUS}
    AND ${AMY}
    AND ${unanswered} AND ${attempted} IS NOT NULL
  ORDER BY url DESC NULLS LAST LIMIT 120`)

await db.end()

console.log('=== UNREADABLE BY HOST ===')
console.log(JSON.stringify(byHost, null, 0))
console.log(`\n=== TOTAL UNREADABLE: ${byHost.reduce((a,r)=>a+Number(r.n),0)} ===`)
console.log('\n=== PER-ROW DETAIL (top 120) ===')
for (const r of detail) {
  const host = r.url ? r.url.replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0] : 'NONE'
  console.log(JSON.stringify({ host, source: r.source, source_id: r.source_id, origin: r.record_origin, fo_status: r.fo_status, g_status: r.g_status, fo_attempts: r.fo_attempts, g_attempts: r.g_attempts, fo_env: r.fo_env, g_env: r.g_env, fo_mark: r.fo_mark?.slice(0,10), g_mark: r.g_mark?.slice(0,10), url: r.url, amount_text: r.amount_text }))
}
console.log('\nDONE')
