import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const CONTRACT_COLUMNS = [
  'purpose',
  'eligibility_requirements',
  'estimated_award',
  'open_date',
  'recurrence',
  'required_documents',
  'application_method',
  'first_published_at',
  'current_status',
  'data_quality_score',
  'data_quality_flags',
  'missing_fields',
]

describe('opportunity lifecycle migration parity', () => {
  it('keeps SQLite 169 and Postgres 0174 aligned', async () => {
    const [sqlite, postgres] = await Promise.all([
      readFile(new URL('../db/migrations/169_opportunity_lifecycle_contract.sql', import.meta.url), 'utf8'),
      readFile(new URL('../db/postgres/migrations/0174_opportunity_lifecycle_contract.sql', import.meta.url), 'utf8'),
    ])

    for (const column of CONTRACT_COLUMNS) {
      expect(sqlite).toContain(`ADD COLUMN ${column}`)
      expect(postgres).toContain(`ADD COLUMN IF NOT EXISTS ${column}`)
    }
    expect(sqlite).toContain('CREATE TABLE IF NOT EXISTS opportunity_change_history')
    expect(postgres).toContain('CREATE TABLE IF NOT EXISTS opportunity_change_history')
  })
})
