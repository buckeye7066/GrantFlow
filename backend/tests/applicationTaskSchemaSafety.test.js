import { beforeEach, describe, expect, it } from 'vitest'

import {
  _resetSchemaCache,
  ensureApplicationTaskSchema,
} from '../services/hamilton/applicationTaskStore.js'

function makePostgresDb({ failConstraintAdd = false } = {}) {
  const rootExec = []
  const txExec = []
  let transactionCalls = 0

  return {
    dialect: 'postgres',
    rootExec,
    txExec,
    get transactionCalls() { return transactionCalls },
    prepare() {
      throw new Error('prepare should not be needed by schema bootstrap')
    },
    async exec(sql) {
      rootExec.push(String(sql))
    },
    async withTransaction(fn) {
      transactionCalls += 1
      return fn({
        async exec(sql) {
          const statement = String(sql)
          txExec.push(statement)
          if (failConstraintAdd && /ADD CONSTRAINT application_tasks_status_check/i.test(statement)) {
            throw new Error('check constraint is violated by some row')
          }
        },
      })
    },
  }
}

describe('application_tasks PostgreSQL status constraint safety', () => {
  beforeEach(() => _resetSchemaCache())

  it('runs DROP and ADD through one transactional connection', async () => {
    const db = makePostgresDb()

    await ensureApplicationTaskSchema(db)

    expect(db.transactionCalls).toBe(1)
    expect(db.txExec).toHaveLength(2)
    expect(db.txExec[0]).toMatch(/DROP CONSTRAINT IF EXISTS application_tasks_status_check/i)
    expect(db.txExec[1]).toMatch(/ADD CONSTRAINT application_tasks_status_check CHECK/i)
    expect(
      db.rootExec.some((sql) => /ALTER TABLE application_tasks (?:DROP|ADD) CONSTRAINT/i.test(sql)),
    ).toBe(false)
  })

  it('propagates ADD failure so the transaction can roll the DROP back', async () => {
    const db = makePostgresDb({ failConstraintAdd: true })

    await expect(ensureApplicationTaskSchema(db)).rejects.toThrow(/constraint is violated/i)

    expect(db.transactionCalls).toBe(1)
    expect(db.txExec).toHaveLength(2)
    expect(
      db.rootExec.some((sql) => /ALTER TABLE application_tasks (?:DROP|ADD) CONSTRAINT/i.test(sql)),
    ).toBe(false)
  })

  it('refuses a PostgreSQL adapter without transactional DDL support', async () => {
    const db = makePostgresDb()
    delete db.withTransaction

    await expect(ensureApplicationTaskSchema(db)).rejects.toThrow(/requires transactional DDL/i)
  })
})
