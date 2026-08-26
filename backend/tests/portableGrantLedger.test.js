import { describe, expect, it } from 'vitest'
import {
  AccountingValidationError,
  exportGrantAccountingBundle,
  parseCsv,
  reconcileAccountingImport,
} from '../services/accounting/portableGrantLedger.js'

const grant = { id: 'grant-1', title: 'Rural Health Initiative' }
const budgets = [
  {
    id: 'budget-2',
    grant_id: 'grant-1',
    line_items: JSON.stringify({ category: 'Travel', line_item: 'Site visits', quantity: 2, unit_cost: 250, total: 500 }),
  },
  {
    id: 'budget-1',
    grant_id: 'grant-1',
    name: 'Personnel',
    total_amount: 1500,
    line_items: JSON.stringify({ category: 'Personnel', line_item: 'Coordinator', quantity: 10, unit_cost: 150, total: 1500 }),
  },
]
const expenses = [
  { id: 'expense-2', grant_id: 'grant-1', date: '2026-08-20', description: 'Travel, lodging', category: 'Travel', amount: 225.5 },
  { id: 'expense-1', grant_id: 'grant-1', date: '2026-08-10', description: '=HYPERLINK("bad")', category: 'Personnel', amount: 300 },
]

describe('portable grant accounting exchange', () => {
  it('builds deterministic QuickBooks and Xero import bundles without credentials', () => {
    const quickbooks = exportGrantAccountingBundle({ grant, budgets, expenses, provider: 'quickbooks' })
    const xero = exportGrantAccountingBundle({ grant, budgets, expenses, provider: 'xero' })

    expect(quickbooks.schema_version).toBe('grantflow-accounting-bundle-v1')
    expect(quickbooks.row_counts).toEqual({ budgets: 2, expenses: 2 })
    expect(quickbooks.totals).toEqual({ budget: 2000, expenses: 525.5 })
    expect(quickbooks.files[1].content).toContain('Transaction Type')
    expect(quickbooks.files[1].content.indexOf('expense-1')).toBeLessThan(quickbooks.files[1].content.indexOf('expense-2'))
    expect(quickbooks.files[1].content).toContain("'=HYPERLINK")
    expect(quickbooks.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)

    expect(xero.files[1].content).toContain('TrackingName1')
    expect(xero.files[1].content).toContain('Rural Health Initiative')
    expect(exportGrantAccountingBundle({ grant, budgets, expenses, provider: 'quickbooks' })).toEqual(quickbooks)
  })

  it('parses quoted multiline cells and rejects malformed CSV', () => {
    expect(parseCsv('A,B\r\n"one, two","line 1\nline 2"\r\n')).toEqual([
      { A: 'one, two', B: 'line 1\nline 2', __row: 2 },
    ])
    expect(() => parseCsv('A\n"unterminated')).toThrow(/unterminated/)
    expect(parseCsv('\uFEFFA,B\r\n1,2\r\n')).toEqual([{ A: '1', B: '2', __row: 2 }])
    expect(() => exportGrantAccountingBundle({
      grant,
      budgets: [],
      expenses: [{ id: 'bad-date', grant_id: 'grant-1', date: '2026-02-31', amount: 1 }],
    })).toThrow(/invalid accounting date/)
    expect(() => exportGrantAccountingBundle({
      grant,
      budgets: [],
      expenses: [{ id: 'bad-suffix', grant_id: 'grant-1', date: '2026-08-10garbage', amount: 1 }],
    })).toThrow(/invalid accounting date/)
    expect(exportGrantAccountingBundle({
      grant,
      budgets: [],
      expenses: [{ id: 'timestamp', grant_id: 'grant-1', date: '2026-08-10T23:59:58.123Z', amount: 1 }],
    }).files[1].content).toContain('2026-08-10')
    expect(() => exportGrantAccountingBundle({ grant, provider: 'unsupported' }))
      .toThrow(AccountingValidationError)
  })

  it('exports every legacy line_items array entry with a stable derived identifier', () => {
    const bundle = exportGrantAccountingBundle({
      grant,
      expenses: [],
      budgets: [{
        id: 'legacy-budget',
        grant_id: 'grant-1',
        line_items: JSON.stringify([
          { category: 'Personnel', line_item: 'Coordinator', quantity: 2, unit_cost: 400 },
          { category: 'Travel', line_item: 'Site visit', quantity: 3, unit_cost: 125, total: 375 },
        ]),
      }],
    })

    expect(bundle.row_counts.budgets).toBe(2)
    expect(bundle.totals.budget).toBe(1175)
    expect(bundle.files[0].content).toContain('legacy-budget:0001')
    expect(bundle.files[0].content).toContain('legacy-budget:0002')
    expect(bundle.files[0].content.indexOf('legacy-budget:0001')).toBeLessThan(
      bundle.files[0].content.indexOf('legacy-budget:0002'),
    )
  })

  it('reconciles by durable external id and reports every non-match class', () => {
    const csv = [
      'Date,Transaction Type,Num,Name,Memo,Account,Debit,Credit,Class,Currency',
      '2026-08-10,Expense,expense-1,,Coordinator,Personnel,300.00,,Rural Health Initiative,USD',
      '2026-08-20,Expense,expense-2,,Hotel,Travel,200.00,,Rural Health Initiative,USD',
      '2026-08-22,Expense,external-9,,Unknown,Travel,10.00,,Rural Health Initiative,USD',
      '2026-08-22,Expense,external-9,,Duplicate,Travel,10.00,,Rural Health Initiative,USD',
      '2026-08-22,Expense,,,No reference,Travel,10.00,,Rural Health Initiative,USD',
    ].join('\r\n')
    const result = reconcileAccountingImport({ provider: 'quickbooks', csv, expenses })

    expect(result.counts).toEqual({
      imported: 5,
      matched: 1,
      amount_mismatch: 1,
      missing_in_grantflow: 1,
      invalid: 2,
      unlinked_expenses: 0,
    })
    expect(result.matched[0].external_id).toBe('expense-1')
    expect(result.amount_mismatch[0]).toMatchObject({ external_id: 'expense-2', amount: 200, grantflow_amount: 225.5 })
    expect(result.invalid.map((row) => row.reason)).toEqual(['duplicate_external_id', 'missing_external_id'])
  })
})
