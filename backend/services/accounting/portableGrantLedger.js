import { createHash } from 'node:crypto'

export const ACCOUNTING_PROVIDERS = Object.freeze(['generic', 'quickbooks', 'xero'])
const MAX_IMPORT_ROWS = 10_000
const SAFE_CURRENCY = /^[A-Z]{3}$/

function requiredText(value, label) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label} is required`)
  return text
}

function safeCurrency(value) {
  const currency = String(value || 'USD').trim().toUpperCase()
  if (!SAFE_CURRENCY.test(currency)) throw new Error('currency must be a three-letter ISO code')
  return currency
}

function safeDate(value) {
  const text = String(value ?? '').trim()
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) throw new Error(`invalid accounting date: ${text || '(empty)'}`)
  const date = `${match[1]}-${match[2]}-${match[3]}`
  const parsed = new Date(`${date}T00:00:00Z`)
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
  ) throw new Error(`invalid accounting date: ${text}`)
  return date
}

function money(value, label = 'amount') {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const negative = /^\(.*\)$/.test(trimmed)
    const parsed = Number(trimmed.replace(/[,$()\s]/g, ''))
    if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`)
    return Math.round((negative ? -parsed : parsed) * 100) / 100
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`)
  return Math.round(parsed * 100) / 100
}

function spreadsheetSafe(value) {
  const text = String(value ?? '')
  return /^[=+\-@]/.test(text) ? `'${text}` : text
}

function csvCell(value) {
  const text = spreadsheetSafe(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function encodeCsv(columns, rows) {
  const header = columns.map(csvCell).join(',')
  const body = rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))
  return `${[header, ...body].join('\r\n')}\r\n`
}

export function parseCsv(csv, { maxRows = MAX_IMPORT_ROWS } = {}) {
  const input = String(csv ?? '')
  const rows = []
  let row = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''))
      cell = ''
      if (row.some((value) => value !== '')) rows.push(row)
      if (rows.length > maxRows + 1) throw new Error(`accounting import exceeds ${maxRows} rows`)
      row = []
    } else {
      cell += char
    }
  }
  if (quoted) throw new Error('accounting CSV contains an unterminated quoted field')
  if (cell || row.length > 0) {
    row.push(cell.replace(/\r$/, ''))
    if (row.some((value) => value !== '')) rows.push(row)
  }
  if (rows.length === 0) return []

  const headers = rows[0].map((value) => String(value).trim())
  if (new Set(headers).size !== headers.length) throw new Error('accounting CSV contains duplicate headers')
  return rows.slice(1).map((values, rowIndex) => {
    const result = {}
    headers.forEach((header, index) => { result[header] = values[index] ?? '' })
    result.__row = rowIndex + 2
    return result
  })
}

function normalizeProvider(provider) {
  const value = String(provider || 'generic').trim().toLowerCase()
  if (!ACCOUNTING_PROVIDERS.includes(value)) {
    throw new Error(`provider must be one of: ${ACCOUNTING_PROVIDERS.join(', ')}`)
  }
  return value
}

function parseBudgetLine(row) {
  let details = {}
  try {
    const parsed = JSON.parse(String(row?.line_items || '{}'))
    details = Array.isArray(parsed) ? parsed[0] || {} : parsed || {}
  } catch { /* retain scalar budget fields */ }
  const quantity = money(details.quantity ?? row?.quantity ?? 1, 'budget quantity')
  const unitCost = money(details.unit_cost ?? row?.unit_cost ?? 0, 'budget unit cost')
  const total = money(details.total ?? row?.total ?? row?.total_amount ?? quantity * unitCost, 'budget total')
  if (total < 0) throw new Error('budget total cannot be negative')
  return {
    id: requiredText(row?.id, 'budget id'),
    grant_id: requiredText(row?.grant_id, 'budget grant_id'),
    category: String(details.category ?? row?.category ?? 'Uncategorized').trim() || 'Uncategorized',
    line_item: String(details.line_item ?? row?.line_item ?? row?.name ?? '').trim() || 'Budget line',
    quantity,
    unit_cost: unitCost,
    total,
    justification: String(details.justification ?? row?.justification ?? '').trim(),
  }
}

function normalizeExpense(row, currency) {
  const amount = money(row?.amount, 'expense amount')
  if (amount < 0) throw new Error('expense amount cannot be negative')
  return {
    id: requiredText(row?.id, 'expense id'),
    grant_id: requiredText(row?.grant_id, 'expense grant_id'),
    date: safeDate(row?.date),
    description: String(row?.description ?? '').trim() || 'Grant expense',
    category: String(row?.category ?? 'Uncategorized').trim() || 'Uncategorized',
    vendor: String(row?.vendor ?? row?.payee ?? '').trim(),
    amount,
    currency,
  }
}

function expenseColumns(provider) {
  if (provider === 'quickbooks') {
    return ['Date', 'Transaction Type', 'Num', 'Name', 'Memo', 'Account', 'Debit', 'Credit', 'Class', 'Currency']
  }
  if (provider === 'xero') {
    return ['Date', 'Amount', 'Payee', 'Description', 'Reference', 'AccountCode', 'TaxType', 'TrackingName1', 'TrackingOption1', 'Currency']
  }
  return ['External ID', 'Grant ID', 'Date', 'Description', 'Category', 'Vendor', 'Amount', 'Currency']
}

function expenseRow(expense, provider, grantName) {
  if (provider === 'quickbooks') {
    return {
      Date: expense.date,
      'Transaction Type': 'Expense',
      Num: expense.id,
      Name: expense.vendor,
      Memo: expense.description,
      Account: expense.category,
      Debit: expense.amount.toFixed(2),
      Credit: '',
      Class: grantName,
      Currency: expense.currency,
    }
  }
  if (provider === 'xero') {
    return {
      Date: expense.date,
      Amount: expense.amount.toFixed(2),
      Payee: expense.vendor,
      Description: expense.description,
      Reference: expense.id,
      AccountCode: expense.category,
      TaxType: 'NONE',
      TrackingName1: 'Grant',
      TrackingOption1: grantName,
      Currency: expense.currency,
    }
  }
  return {
    'External ID': expense.id,
    'Grant ID': expense.grant_id,
    Date: expense.date,
    Description: expense.description,
    Category: expense.category,
    Vendor: expense.vendor,
    Amount: expense.amount.toFixed(2),
    Currency: expense.currency,
  }
}

function checksum(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function exportGrantAccountingBundle({ grant, budgets = [], expenses = [], provider = 'generic', currency = 'USD' }) {
  const resolvedProvider = normalizeProvider(provider)
  const resolvedCurrency = safeCurrency(currency)
  const grantId = requiredText(grant?.id, 'grant id')
  const grantName = String(grant?.title ?? grant?.name ?? grantId).trim() || grantId
  const budgetRows = budgets.map(parseBudgetLine).filter((row) => row.grant_id === grantId)
    .sort((left, right) => left.id.localeCompare(right.id))
  const expenseRows = expenses.map((row) => normalizeExpense(row, resolvedCurrency))
    .filter((row) => row.grant_id === grantId)
    .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id))

  const budgetColumns = ['Line ID', 'Grant ID', 'Category', 'Line Item', 'Quantity', 'Unit Cost', 'Total', 'Justification', 'Currency']
  const budgetCsv = encodeCsv(budgetColumns, budgetRows.map((row) => ({
    'Line ID': row.id,
    'Grant ID': row.grant_id,
    Category: row.category,
    'Line Item': row.line_item,
    Quantity: row.quantity.toFixed(2),
    'Unit Cost': row.unit_cost.toFixed(2),
    Total: row.total.toFixed(2),
    Justification: row.justification,
    Currency: resolvedCurrency,
  })))
  const columns = expenseColumns(resolvedProvider)
  const expenseCsv = encodeCsv(columns, expenseRows.map((row) => expenseRow(row, resolvedProvider, grantName)))
  const files = [
    { name: `grantflow-${grantId}-budget.csv`, media_type: 'text/csv', content: budgetCsv, sha256: checksum(budgetCsv) },
    { name: `grantflow-${grantId}-${resolvedProvider}-expenses.csv`, media_type: 'text/csv', content: expenseCsv, sha256: checksum(expenseCsv) },
  ]

  return {
    schema_version: 'grantflow-accounting-bundle-v1',
    provider: resolvedProvider,
    grant: { id: grantId, name: grantName, currency: resolvedCurrency },
    row_counts: { budgets: budgetRows.length, expenses: expenseRows.length },
    totals: {
      budget: money(budgetRows.reduce((sum, row) => sum + row.total, 0)),
      expenses: money(expenseRows.reduce((sum, row) => sum + row.amount, 0)),
    },
    files,
  }
}

function importedExpense(row, provider) {
  if (provider === 'quickbooks') {
    return {
      row: row.__row,
      external_id: String(row.Num || '').trim(),
      amount: money(money(row.Debit || 0) - money(row.Credit || 0)),
      date: safeDate(row.Date),
    }
  }
  if (provider === 'xero') {
    return {
      row: row.__row,
      external_id: String(row.Reference || '').trim(),
      amount: money(row.Amount),
      date: safeDate(row.Date),
    }
  }
  return {
    row: row.__row,
    external_id: String(row['External ID'] || '').trim(),
    amount: money(row.Amount),
    date: safeDate(row.Date),
  }
}

export function reconcileAccountingImport({ provider = 'generic', csv, expenses = [] }) {
  const resolvedProvider = normalizeProvider(provider)
  const imported = parseCsv(csv).map((row) => importedExpense(row, resolvedProvider))
  const local = new Map(expenses.map((row) => {
    const normalized = normalizeExpense(row, safeCurrency(row?.currency || 'USD'))
    return [normalized.id, normalized]
  }))
  const seen = new Set()
  const matched = []
  const amount_mismatch = []
  const missing_in_grantflow = []
  const invalid = []

  for (const row of imported) {
    if (!row.external_id) {
      invalid.push({ row: row.row, reason: 'missing_external_id' })
      continue
    }
    if (seen.has(row.external_id)) {
      invalid.push({ row: row.row, external_id: row.external_id, reason: 'duplicate_external_id' })
      continue
    }
    seen.add(row.external_id)
    const expense = local.get(row.external_id)
    if (!expense) {
      missing_in_grantflow.push(row)
      continue
    }
    if (Math.abs(expense.amount - row.amount) > 0.009) {
      amount_mismatch.push({ ...row, grantflow_amount: expense.amount })
      continue
    }
    matched.push({ ...row, grantflow_amount: expense.amount })
  }

  const unlinked_expenses = [...local.values()]
    .filter((expense) => !seen.has(expense.id))
    .map((expense) => ({ external_id: expense.id, amount: expense.amount, date: expense.date }))

  return {
    schema_version: 'grantflow-accounting-reconciliation-v1',
    provider: resolvedProvider,
    counts: {
      imported: imported.length,
      matched: matched.length,
      amount_mismatch: amount_mismatch.length,
      missing_in_grantflow: missing_in_grantflow.length,
      invalid: invalid.length,
      unlinked_expenses: unlinked_expenses.length,
    },
    matched,
    amount_mismatch,
    missing_in_grantflow,
    invalid,
    unlinked_expenses,
  }
}
