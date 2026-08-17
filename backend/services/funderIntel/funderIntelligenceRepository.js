/**
 * Canonical read model over the persisted IRS-990 grant-transaction ledger.
 * This module describes demonstrated historical giving. It deliberately does
 * not decide applicant eligibility or compute a match score; that authority
 * remains matchEngine.computeMatchDecision.
 */
export const FUNDER_INTELLIGENCE_READ_MODEL_VERSION = 'funder-intelligence-v1'
const MAX_ANALYTICS_AMOUNTS = 10_000

// Keep the read model dependency-light: it consumes already-persisted ledger
// rows and must remain usable even when crawler/parser dependencies are not
// loaded. The URL shapes are the persisted ledger's documented provenance.
const PROPUBLICA_ORG_PAGE_URL = (ein) => `https://projects.propublica.org/nonprofits/organizations/${ein}`
const EFILE_XML_URL = (objectId) =>
  `https://gt990datalake-rawdata.s3.amazonaws.com/EfileData/XmlFiles/${objectId}_public.xml`
const isValidObjectId = (value) => /^\d{18}$/.test(String(value ?? ''))
const normalizeEin = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.length === 9 ? digits : null
}

export class FunderIntelligenceError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.name = 'FunderIntelligenceError'
    this.code = code
    this.details = details
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(parsed, max))
}

function optionalTaxYear(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed) || parsed < 1900 || parsed > 2100) {
    throw new FunderIntelligenceError('FUNDER_INTELLIGENCE_VALIDATION', 'tax_year must be between 1900 and 2100')
  }
  return parsed
}

function optionalState(value) {
  if (value === null || value === undefined || value === '') return null
  const state = String(value).trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(state)) {
    throw new FunderIntelligenceError('FUNDER_INTELLIGENCE_VALIDATION', 'recipient_state must be a 2-letter code')
  }
  return state
}

async function tableExists(db, tableName) {
  try {
    if (db?.dialect === 'postgres') {
      const row = await db.prepare('SELECT to_regclass(?) AS table_name').get(tableName)
      return Boolean(row?.table_name)
    }
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
    return Boolean(row?.name)
  } catch {
    return false
  }
}

function filteredWhere(ein, { taxYear, recipientState }) {
  const clauses = ['funder_ein = ?']
  const params = [ein]
  if (taxYear !== null) {
    clauses.push('tax_year = ?')
    params.push(taxYear)
  }
  if (recipientState !== null) {
    clauses.push('recipient_state = ?')
    params.push(recipientState)
  }
  return { sql: clauses.join(' AND '), params }
}

function median(sorted) {
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function emptyReadModel(ein, state = null) {
  return {
    read_model_version: FUNDER_INTELLIGENCE_READ_MODEL_VERSION,
    ein,
    funder_name: null,
    data_state: 'not_ingested',
    historical_evidence_only: true,
    interpretation:
      'Filed grants show historical giving, not a current open opportunity or a promise of eligibility.',
    summary: {
      transaction_count: 0,
      total_amount: null,
      average_amount: null,
      median_amount: null,
      minimum_amount: null,
      maximum_amount: null,
      analytics_truncated: false,
    },
    amount_trends: [],
    recipient_patterns: { top_recipients: [], recipient_states: [] },
    filing_provenance: [],
    transactions: [],
    page: { limit: 25, offset: 0, returned: 0, total: 0 },
    ingest_state: state,
  }
}

export async function getFunderIntelligence(db, options = {}) {
  const ein = normalizeEin(options.ein)
  if (!ein) {
    throw new FunderIntelligenceError('FUNDER_INTELLIGENCE_VALIDATION', 'EIN must contain exactly 9 digits')
  }
  const taxYear = optionalTaxYear(options.taxYear)
  const recipientState = optionalState(options.recipientState)
  const limit = integer(options.limit, 25, { min: 1, max: 100 })
  const offset = integer(options.offset, 0, { min: 0, max: 1_000_000 })
  const transactionTableAvailable = await tableExists(db, 'grant_transactions')
  const ingestStateAvailable = await tableExists(db, 'funder_990_ingest_state')

  let ingestState = null
  if (ingestStateAvailable) {
    ingestState = await db
      .prepare(
        `SELECT funder_ein, attempted_at, attempts, env_attempts, last_reason,
                ingested_object_id, tax_year, transactions_found, updated_at
           FROM funder_990_ingest_state
          WHERE funder_ein = ?`,
      )
      .get(ein)
  }

  if (!transactionTableAvailable) {
    return {
      ...emptyReadModel(ein, ingestState),
      schema_available: false,
      data_state: ingestState?.attempted_at ? 'answered_without_transactions' : 'not_ingested',
    }
  }

  const where = filteredWhere(ein, { taxYear, recipientState })
  const ledgerSummary = await db
    .prepare(
      `SELECT COUNT(*) AS transaction_count, MIN(funder_name) AS funder_name
         FROM grant_transactions
        WHERE funder_ein = ?`,
    )
    .get(ein)
  const ledgerTransactionCount = Number(ledgerSummary?.transaction_count ?? 0)
  const aggregate = await db
    .prepare(
      `SELECT COUNT(*) AS transaction_count,
              SUM(amount) AS total_amount,
              AVG(amount) AS average_amount,
              MIN(amount) AS minimum_amount,
              MAX(amount) AS maximum_amount,
              MIN(funder_name) AS funder_name
         FROM grant_transactions
        WHERE ${where.sql}`,
    )
    .get(...where.params)
  const transactionCount = Number(aggregate?.transaction_count ?? 0)

  const amountRows = await db
    .prepare(
      `SELECT amount
         FROM grant_transactions
        WHERE ${where.sql} AND amount IS NOT NULL
        ORDER BY amount ASC
        LIMIT ?`,
    )
    .all(...where.params, MAX_ANALYTICS_AMOUNTS + 1)
  const amountAnalyticsTruncated = (amountRows ?? []).length > MAX_ANALYTICS_AMOUNTS
  const sortedAmounts = amountAnalyticsTruncated
    ? []
    : (amountRows ?? []).map((row) => numberOrNull(row.amount)).filter((value) => value !== null)

  const amountTrends = await db
    .prepare(
      `SELECT tax_year,
              COUNT(*) AS transaction_count,
              SUM(amount) AS total_amount,
              AVG(amount) AS average_amount,
              MIN(amount) AS minimum_amount,
              MAX(amount) AS maximum_amount
         FROM grant_transactions
        WHERE ${where.sql}
        GROUP BY tax_year
        ORDER BY tax_year DESC`,
    )
    .all(...where.params)

  const topRecipients = await db
    .prepare(
      `SELECT recipient_name,
              COUNT(*) AS grant_count,
              SUM(amount) AS total_amount,
              AVG(amount) AS average_amount,
              MAX(tax_year) AS latest_tax_year
         FROM grant_transactions
        WHERE ${where.sql}
        GROUP BY recipient_name
        ORDER BY total_amount DESC, grant_count DESC, recipient_name ASC
        LIMIT 10`,
    )
    .all(...where.params)

  const recipientStates = await db
    .prepare(
      `SELECT recipient_state,
              COUNT(*) AS grant_count,
              SUM(amount) AS total_amount
         FROM grant_transactions
        WHERE ${where.sql} AND recipient_state IS NOT NULL AND recipient_state <> ''
        GROUP BY recipient_state
        ORDER BY total_amount DESC, grant_count DESC, recipient_state ASC
        LIMIT 20`,
    )
    .all(...where.params)

  const filingRows = await db
    .prepare(
      `SELECT source_object_id,
              MAX(tax_year) AS tax_year,
              MIN(form_type) AS form_type,
              MIN(created_at) AS first_persisted_at,
              COUNT(*) AS transaction_count,
              SUM(amount) AS total_amount
         FROM grant_transactions
        WHERE funder_ein = ?
        GROUP BY source_object_id
        ORDER BY tax_year DESC, source_object_id DESC`,
    )
    .all(ein)

  const transactions = await db
    .prepare(
      `SELECT id, funder_ein, funder_name, recipient_name, recipient_ein,
              recipient_city, recipient_state, recipient_country, amount,
              purpose, tax_year, form_type, source_object_id, created_at
         FROM grant_transactions
        WHERE ${where.sql}
        ORDER BY tax_year DESC, amount DESC, id ASC
        LIMIT ? OFFSET ?`,
    )
    .all(...where.params, limit, offset)

  const filingProvenance = (filingRows ?? []).map((row) => {
    const objectId = String(row.source_object_id ?? '')
    const isIngestedFiling = objectId && objectId === String(ingestState?.ingested_object_id ?? '')
    return {
      source_object_id: objectId || null,
      tax_year: numberOrNull(row.tax_year),
      form_type: row.form_type ?? null,
      transaction_count: Number(row.transaction_count ?? 0),
      total_amount: numberOrNull(row.total_amount),
      retrieved_at: isIngestedFiling
        ? ingestState?.updated_at ?? row.first_persisted_at ?? null
        : row.first_persisted_at ?? null,
      retrieval_basis: isIngestedFiling ? 'funder_990_ingest_state.updated_at' : 'grant_transactions.created_at',
      filing_xml_url: isValidObjectId(objectId) ? EFILE_XML_URL(objectId) : null,
      organization_index_url: PROPUBLICA_ORG_PAGE_URL(ein),
      provenance: 'IRS e-file XML indexed by ProPublica and retrieved from the GivingTuesday 990 data lake.',
    }
  })

  let dataState = 'not_ingested'
  if (transactionCount > 0) dataState = 'available'
  else if (ledgerTransactionCount > 0) dataState = 'no_matches'
  else if (Number(ingestState?.transactions_found) === 0 && ingestState?.attempted_at) dataState = 'no_itemized_grants'
  else if (ingestState?.attempted_at) dataState = 'answered_without_transactions'

  return {
    read_model_version: FUNDER_INTELLIGENCE_READ_MODEL_VERSION,
    schema_available: true,
    ein,
    funder_name: aggregate?.funder_name ?? ledgerSummary?.funder_name ?? null,
    data_state: dataState,
    historical_evidence_only: true,
    interpretation:
      'Filed grants show historical giving, not a current open opportunity or a promise of eligibility.',
    filters: { tax_year: taxYear, recipient_state: recipientState },
    ledger_transaction_count: ledgerTransactionCount,
    summary: {
      transaction_count: transactionCount,
      total_amount: numberOrNull(aggregate?.total_amount),
      average_amount: numberOrNull(aggregate?.average_amount),
      median_amount: amountAnalyticsTruncated ? null : median(sortedAmounts),
      minimum_amount: numberOrNull(aggregate?.minimum_amount),
      maximum_amount: numberOrNull(aggregate?.maximum_amount),
      analytics_truncated: amountAnalyticsTruncated,
      median_unavailable_reason: amountAnalyticsTruncated ? 'more_than_10000_amounts' : null,
    },
    amount_trends: (amountTrends ?? []).map((row) => ({
      tax_year: numberOrNull(row.tax_year),
      transaction_count: Number(row.transaction_count ?? 0),
      total_amount: numberOrNull(row.total_amount),
      average_amount: numberOrNull(row.average_amount),
      minimum_amount: numberOrNull(row.minimum_amount),
      maximum_amount: numberOrNull(row.maximum_amount),
    })),
    recipient_patterns: {
      top_recipients: (topRecipients ?? []).map((row) => ({
        recipient_name: row.recipient_name,
        grant_count: Number(row.grant_count ?? 0),
        total_amount: numberOrNull(row.total_amount),
        average_amount: numberOrNull(row.average_amount),
        latest_tax_year: numberOrNull(row.latest_tax_year),
      })),
      recipient_states: (recipientStates ?? []).map((row) => ({
        recipient_state: row.recipient_state,
        grant_count: Number(row.grant_count ?? 0),
        total_amount: numberOrNull(row.total_amount),
      })),
    },
    filing_provenance: filingProvenance,
    transactions: (transactions ?? []).map((row) => ({
      ...row,
      amount: numberOrNull(row.amount),
      tax_year: numberOrNull(row.tax_year),
    })),
    page: { limit, offset, returned: (transactions ?? []).length, total: transactionCount },
    ingest_state: ingestState
      ? {
          attempted_at: ingestState.attempted_at ?? null,
          attempts: Number(ingestState.attempts ?? 0),
          environment_attempts: Number(ingestState.env_attempts ?? 0),
          last_reason: ingestState.last_reason ?? null,
          ingested_object_id: ingestState.ingested_object_id ?? null,
          tax_year: numberOrNull(ingestState.tax_year),
          transactions_found: numberOrNull(ingestState.transactions_found),
          retrieved_at: ingestState.updated_at ?? null,
        }
      : null,
  }
}

export default { getFunderIntelligence }
