import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'

import healthRouter, {
  checkApplicationTaskStatusConstraint,
  checkBootMigrationHealth,
} from '../../backend/routes/health.js'
import { TASK_STATUSES } from '../../backend/services/hamilton/applicationTaskStore.js'

function quotedStatusDefinition(statuses = TASK_STATUSES) {
  return `CHECK ((status = ANY (ARRAY[${statuses.map((status) => `'${status}'::text`).join(', ')}])))`
}

function makeDb({
  migrationValue = '[]',
  constraint = { definition: quotedStatusDefinition(), validated: true },
} = {}) {
  return {
    dialect: 'postgres',
    async healthcheck() { return { ok: true, dialect: 'postgres' } },
    prepare(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      return {
        async get(...args) {
          if (normalized.includes('from system_kv')) {
            return migrationValue === null ? undefined : { value: migrationValue }
          }
          if (normalized.includes('from pg_constraint')) return constraint
          if (normalized.includes('from information_schema.columns')) {
            return args.length === 2 ? { present: 1 } : undefined
          }
          if (normalized === 'select 1 as ok') return { ok: 1 }
          throw new Error(`unexpected readiness SQL: ${normalized}`)
        },
      }
    },
  }
}

async function startReadyServer({ db = makeDb(), locals = {} } = {}) {
  const app = express()
  Object.assign(app.locals, locals)
  app.use((req, _res, next) => {
    req.db = db
    next()
  })
  app.use(healthRouter)
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('boot migration health fails closed on durable failed migration signal', async () => {
  const result = await checkBootMigrationHealth(makeDb({
    migrationValue: JSON.stringify(['0167_hamilton_submission_attempt_states.sql']),
  }))
  assert.deepEqual(result, {
    ok: false,
    reason: 'boot_migrations_incomplete',
    failed_count: 1,
  })
})

test('boot migration health fails closed when its durable signal is absent or invalid', async () => {
  assert.equal(
    (await checkBootMigrationHealth(makeDb({ migrationValue: null }))).reason,
    'boot_migration_health_unavailable',
  )
  assert.equal(
    (await checkBootMigrationHealth(makeDb({ migrationValue: '{}' }))).reason,
    'boot_migration_health_invalid',
  )
})

test('boot migration health rejects a deliberately skipped or incomplete current boot', async () => {
  assert.equal(
    (await checkBootMigrationHealth(makeDb(), {
      migrate_boot_attempted: false,
      migrate_boot_complete: false,
    }, { requireCurrentBoot: true })).reason,
    'boot_migration_not_run',
  )
  assert.equal(
    (await checkBootMigrationHealth(makeDb(), {
      migrate_boot_attempted: true,
      migrate_boot_complete: false,
    }, { requireCurrentBoot: true })).reason,
    'boot_migration_incomplete',
  )
})

test('PostgreSQL readiness requires the exact validated application task status constraint', async () => {
  assert.deepEqual(await checkApplicationTaskStatusConstraint(makeDb()), {
    ok: true,
    applicable: true,
  })

  const missingOne = TASK_STATUSES.slice(0, -1)
  assert.equal(
    (await checkApplicationTaskStatusConstraint(makeDb({
      constraint: { definition: quotedStatusDefinition(missingOne), validated: true },
    }))).reason,
    'application_task_status_constraint_invalid',
  )
  assert.equal(
    (await checkApplicationTaskStatusConstraint(makeDb({
      constraint: { definition: quotedStatusDefinition(), validated: false },
    }))).reason,
    'application_task_status_constraint_invalid',
  )
})

test('/readyz returns redacted 503 when this boot reports migration failures', async () => {
  const srv = await startReadyServer({
    locals: {
      migrate_boot_failed_migrations: ['0167_hamilton_submission_attempt_states.sql'],
    },
  })
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/readyz`)
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.reason, 'boot_migrations_incomplete')
    assert.equal(body.failed_migration_count, 1)
    assert.equal(body.details_redacted, true)
    assert.equal(JSON.stringify(body).includes('0167_hamilton'), false)
  } finally {
    await srv.close()
  }
})

test('/readyz returns 503 when the durable migration signal is unavailable', async () => {
  const srv = await startReadyServer({ db: makeDb({ migrationValue: null }) })
  try {
    const response = await fetch(`http://127.0.0.1:${srv.port}/readyz`)
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.reason, 'boot_migration_health_unavailable')
    assert.equal(body.details_redacted, true)
  } finally {
    await srv.close()
  }
})
