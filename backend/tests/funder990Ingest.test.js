/**
 * funder990Ingest — burn/retry discipline and honest writes.
 *
 * The fetcher is injected; every test states exactly what each of the two
 * fixed hosts returns. The burn rules under test are enforceAmountEnrichment's,
 * funder-scoped: the mark is written ONLY once the funder's ANSWER is known;
 * a transient failure spends nothing; an environment wall (403/429) spends
 * env_attempts only; stable-but-retryable outcomes spend `attempts` and burn
 * at the bound; the mark is written only AFTER the data write succeeded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runFunder990Ingest } from '../services/funderIntel/funder990Ingest.js'
import { FUNDER_GIVING_MARKER } from '../config/funderBehavior.js'

const EIN = '131684331'
const OID = '202513219349106006'
const ORG_URL = `https://projects.propublica.org/nonprofits/organizations/${EIN}`
const XML_URL = `https://gt990datalake-rawdata.s3.amazonaws.com/EfileData/XmlFiles/${OID}_public.xml`

const ORG_HTML = `<a href="/nonprofits/download-xml?object_id=${OID}">XML</a>`

const PF_XML = `<?xml version="1.0"?><Return xmlns="http://www.irs.gov/efile">
  <ReturnHeader><ReturnTypeCd>990PF</ReturnTypeCd><TaxYr>2024</TaxYr>
    <Filer><BusinessName><BusinessNameLine1Txt>FORD FOUNDATION</BusinessNameLine1Txt></BusinessName></Filer>
  </ReturnHeader>
  <ReturnData><IRS990PF><SupplementaryInformationGrp>
    <GrantOrContributionPdDurYrGrp>
      <RecipientBusinessName><BusinessNameLine1Txt>APPALACHIAN HOUSING ALLIANCE</BusinessNameLine1Txt></RecipientBusinessName>
      <RecipientUSAddress><CityNm>KNOXVILLE</CityNm><StateAbbreviationCd>TN</StateAbbreviationCd></RecipientUSAddress>
      <GrantOrContributionPurposeTxt>FOR EMERGENCY RENT ASSISTANCE</GrantOrContributionPurposeTxt>
      <Amt>50000</Amt>
    </GrantOrContributionPdDurYrGrp>
  </SupplementaryInformationGrp></IRS990PF></ReturnData></Return>`

const EMPTY_990_XML = `<?xml version="1.0"?><Return xmlns="http://www.irs.gov/efile">
  <ReturnHeader><ReturnTypeCd>990</ReturnTypeCd><TaxYr>2023</TaxYr></ReturnHeader>
  <ReturnData><IRS990/></ReturnData></Return>`

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      source TEXT, source_id TEXT, categories TEXT DEFAULT '[]',
      state TEXT, is_national INTEGER, is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE grant_transactions (
      id TEXT PRIMARY KEY, funder_ein TEXT NOT NULL, funder_name TEXT,
      recipient_name TEXT NOT NULL, recipient_ein TEXT, recipient_city TEXT,
      recipient_state TEXT, recipient_country TEXT, amount NUMERIC, purpose TEXT,
      tax_year INTEGER, form_type TEXT, source_object_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE funder_990_ingest_state (
      funder_ein TEXT PRIMARY KEY, attempted_at DATETIME, attempts INTEGER DEFAULT 0,
      env_attempts INTEGER DEFAULT 0, last_reason TEXT, ingested_object_id TEXT,
      tax_year INTEGER, transactions_found INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

const wrap = (db) => ({ dialect: 'sqlite', prepare: (sql) => db.prepare(sql) })

function seedFunder(db, { ein = EIN, id = 'fo-ford' } = {}) {
  db.prepare(
    `INSERT INTO funding_opportunities (id, title, sponsor, description, source, source_id, categories, state)
     VALUES (?, ?, ?, ?, 'propublica_990', ?, '["programs"]', 'NY')`,
  ).run(id, 'Ford Foundation — Foundation/Grantmaker', 'Ford Foundation', 'Location: New York, NY | NTEE: T20', ein)
}

function fetcherFrom(map, calls = []) {
  return async (url) => {
    calls.push(url)
    const entry = map[url]
    if (!entry) return { status: 404, body: '' }
    if (entry instanceof Error) throw entry
    return entry
  }
}

let ENV_SNAPSHOT
beforeEach(() => { ENV_SNAPSHOT = { ...process.env } })
afterEach(() => { process.env = ENV_SNAPSHOT })

describe('runFunder990Ingest — the happy path writes REAL filed facts', () => {
  it('org page → lake XML → transactions + answered state + enriched funder row', async () => {
    const db = makeDb()
    seedFunder(db)
    const res = await runFunder990Ingest(wrap(db), {
      fetchImpl: fetcherFrom({ [ORG_URL]: { status: 200, body: ORG_HTML }, [XML_URL]: { status: 200, body: PF_XML } }),
    })
    expect(res.ingested).toBe(1)
    expect(res.transactions).toBe(1)

    const tx = db.prepare('SELECT * FROM grant_transactions').all()
    expect(tx).toHaveLength(1)
    expect(tx[0]).toMatchObject({
      funder_ein: EIN,
      funder_name: 'FORD FOUNDATION',
      recipient_name: 'APPALACHIAN HOUSING ALLIANCE',
      recipient_state: 'TN',
      amount: 50000,
      tax_year: 2024,
      form_type: '990PF',
      source_object_id: OID,
    })

    const state = db.prepare('SELECT * FROM funder_990_ingest_state WHERE funder_ein = ?').get(EIN)
    expect(state.attempted_at).toBeTruthy()
    expect(state.last_reason).toBe('parsed')
    expect(state.transactions_found).toBe(1)

    // Enrichment: honest giving line + evidenced need merged into categories.
    const fo = db.prepare('SELECT description, categories FROM funding_opportunities WHERE id = ?').get('fo-ford')
    expect(fo.description).toContain(FUNDER_GIVING_MARKER)
    expect(fo.description).toContain('Location: New York, NY')
    expect(JSON.parse(fo.categories)).toContain('housing')
    expect(JSON.parse(fo.categories)).toContain('programs')
  })

  it('is idempotent: an answered funder is excluded by SQL predicate — no second fetch', async () => {
    const db = makeDb()
    seedFunder(db)
    const calls = []
    const fetchImpl = fetcherFrom({ [ORG_URL]: { status: 200, body: ORG_HTML }, [XML_URL]: { status: 200, body: PF_XML } }, calls)
    await runFunder990Ingest(wrap(db), { fetchImpl })
    const callsAfterFirst = calls.length
    const second = await runFunder990Ingest(wrap(db), { fetchImpl })
    expect(second.scanned).toBe(0)
    expect(calls.length).toBe(callsAfterFirst)
    expect(db.prepare('SELECT COUNT(*) AS n FROM grant_transactions').get().n).toBe(1)
  })

  it('a filing with ZERO itemized grants is ANSWERED (no_itemized_grants), never retried', async () => {
    const db = makeDb()
    seedFunder(db)
    const res = await runFunder990Ingest(wrap(db), {
      fetchImpl: fetcherFrom({ [ORG_URL]: { status: 200, body: ORG_HTML }, [XML_URL]: { status: 200, body: EMPTY_990_XML } }),
    })
    expect(res.ingested).toBe(1)
    expect(res.transactions).toBe(0)
    const state = db.prepare('SELECT * FROM funder_990_ingest_state WHERE funder_ein = ?').get(EIN)
    expect(state.attempted_at).toBeTruthy()
    expect(state.last_reason).toBe('no_itemized_grants')
    // No fabricated enrichment either.
    const fo = db.prepare('SELECT description FROM funding_opportunities').get()
    expect(fo.description).not.toContain(FUNDER_GIVING_MARKER)
  })
})

describe('burn/retry discipline — the amount-enrichment rules, funder-scoped', () => {
  it('a TRANSIENT org-page failure (500) spends NOTHING', async () => {
    const db = makeDb()
    seedFunder(db)
    await runFunder990Ingest(wrap(db), { fetchImpl: fetcherFrom({ [ORG_URL]: { status: 500, body: '' } }) })
    const state = db.prepare('SELECT * FROM funder_990_ingest_state WHERE funder_ein = ?').get(EIN)
    expect(state.attempted_at).toBe(null)
    expect(state.attempts).toBe(0)
    expect(state.last_reason).toBe('org_page_transient:500')
  })

  it('a network throw spends NOTHING', async () => {
    const db = makeDb()
    seedFunder(db)
    await runFunder990Ingest(wrap(db), { fetchImpl: fetcherFrom({ [ORG_URL]: new Error('ECONNRESET') }) })
    const state = db.prepare('SELECT * FROM funder_990_ingest_state WHERE funder_ein = ?').get(EIN)
    expect(state.attempted_at).toBe(null)
    expect(state.attempts).toBe(0)
  })

  it('an ENVIRONMENT wall (403) spends env_attempts only — never the burn', async () => {
    const db = makeDb()
    seedFunder(db)
    await runFunder990Ingest(wrap(db), { fetchImpl: fetcherFrom({ [ORG_URL]: { status: 403, body: 'Security Check' } }) })
    const state = db.prepare('SELECT * FROM funder_990_ingest_state WHERE funder_ein = ?').get(EIN)
    expect(state.attempted_at).toBe(null)
    expect(state.attempts).toBe(0)
    expect(state.env_attempts).toBe(1)
  })

  it('an org page 404 is a REAL answer about the EIN — burned', async () => {
    const db = makeDb()
    seedFunder(db)
    await runFunder990Ingest(wrap(db), { fetchImpl: fetcherFrom({ [ORG_URL]: { status: 404, body: '' } }) })
    const state = db.prepare('SELECT * FROM funder_990_ingest_state WHERE funder_ein = ?').get(EIN)
    expect(state.attempted_at).toBeTruthy()
    expect(state.last_reason).toBe('org_page_404')
  })

  it('a page with NO e-file XML links is a REAL answer (paper filer) — burned', async () => {
    const db = makeDb()
    seedFunder(db)
    await runFunder990Ingest(wrap(db), {
      fetchImpl: fetcherFrom({ [ORG_URL]: { status: 200, body: '<html>filings, but only PDFs</html>' } }),
    })
    const state = db.prepare('SELECT * FROM funder_990_ingest_state WHERE funder_ein = ?').get(EIN)
    expect(state.attempted_at).toBeTruthy()
    expect(state.last_reason).toBe('no_efile_xml')
  })

  it('lake-404 (not yet mirrored) spends an ATTEMPT and burns only at the bound', async () => {
    const db = makeDb()
    seedFunder(db)
    const fetchImpl = fetcherFrom({ [ORG_URL]: { status: 200, body: ORG_HTML }, [XML_URL]: { status: 404, body: '' } })
    await runFunder990Ingest(wrap(db), { fetchImpl, maxAttempts: 2 })
    let state = db.prepare('SELECT * FROM funder_990_ingest_state WHERE funder_ein = ?').get(EIN)
    expect(state.attempts).toBe(1)
    expect(state.attempted_at).toBe(null)
    expect(state.last_reason).toBe('xml_not_in_lake')
    await runFunder990Ingest(wrap(db), { fetchImpl, maxAttempts: 2 })
    state = db.prepare('SELECT * FROM funder_990_ingest_state WHERE funder_ein = ?').get(EIN)
    expect(state.attempts).toBe(2)
    expect(state.attempted_at).toBeTruthy() // exhausted at the bound — visible, final
  })

  it('a bot-wall HTML body served as the XML is a parse error — spends an attempt, never fabricates', async () => {
    const db = makeDb()
    seedFunder(db)
    await runFunder990Ingest(wrap(db), {
      fetchImpl: fetcherFrom({
        [ORG_URL]: { status: 200, body: ORG_HTML },
        [XML_URL]: { status: 200, body: '<html><title>Security Check</title></html>' },
      }),
    })
    const state = db.prepare('SELECT * FROM funder_990_ingest_state WHERE funder_ein = ?').get(EIN)
    expect(state.attempts).toBe(1)
    expect(state.attempted_at).toBe(null)
    expect(String(state.last_reason)).toContain('xml_parse_error')
    expect(db.prepare('SELECT COUNT(*) AS n FROM grant_transactions').get().n).toBe(0)
  })

  it('re-ingesting the same object id REPLACES its rows (no duplicates)', async () => {
    const db = makeDb()
    seedFunder(db)
    const fetchImpl = fetcherFrom({ [ORG_URL]: { status: 200, body: ORG_HTML }, [XML_URL]: { status: 200, body: PF_XML } })
    await runFunder990Ingest(wrap(db), { fetchImpl })
    // Force a re-run by clearing the answered mark (simulates a future refresh lane).
    db.prepare('UPDATE funder_990_ingest_state SET attempted_at = NULL, attempts = 0').run()
    await runFunder990Ingest(wrap(db), { fetchImpl })
    expect(db.prepare('SELECT COUNT(*) AS n FROM grant_transactions').get().n).toBe(1)
    // Enrichment marker did not stack either.
    const fo = db.prepare('SELECT description FROM funding_opportunities').get()
    expect(fo.description.split('\n').filter((l) => l.includes(FUNDER_GIVING_MARKER))).toHaveLength(1)
  })
})

describe('count-only + bounds', () => {
  it('ENFORCE_FUNDER_990_INGEST=0 → NO egress, NO writes, honest remaining count', async () => {
    const db = makeDb()
    seedFunder(db)
    process.env.ENFORCE_FUNDER_990_INGEST = '0'
    const calls = []
    const res = await runFunder990Ingest(wrap(db), {
      fetchImpl: fetcherFrom({ [ORG_URL]: { status: 200, body: ORG_HTML }, [XML_URL]: { status: 200, body: PF_XML } }, calls),
    })
    expect(res.enforced).toBe(false)
    expect(res.remaining).toBe(1)
    expect(calls).toHaveLength(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM grant_transactions').get().n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM funder_990_ingest_state').get().n).toBe(0)
  })

  it('a non-9-digit source_id is never a candidate (no URL from junk)', async () => {
    const db = makeDb()
    seedFunder(db, { ein: 'not-an-ein', id: 'fo-junk' })
    const calls = []
    const res = await runFunder990Ingest(wrap(db), { fetchImpl: fetcherFrom({}, calls) })
    expect(res.scanned).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('missing tables → skipped:"schema", never a throw', async () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, source TEXT, source_id TEXT)')
    const res = await runFunder990Ingest(wrap(db), { fetchImpl: fetcherFrom({}) })
    expect(res.skipped).toBe('schema')
  })
})
