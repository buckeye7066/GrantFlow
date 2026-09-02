import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resetAgentControlSchedulerForTests,
  resolveScheduledCycleInitialDelayMs,
  resolveScheduledCycleIntervalMs,
  runScheduledAgentCycleTick,
  shouldRunScheduledAgentCycles,
  startAgentControlScheduler,
  stopAgentControlScheduler,
} from '../../backend/services/agentControl/agentControlScheduler.js'

async function withEnv(overrides, fn) {
  const saved = {}
  for (const key of Object.keys(overrides)) saved[key] = process.env[key]
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('scheduled agent cycles default on in deployed production, not local development', async () => {
  await withEnv({
    NODE_ENV: 'development',
    RAILWAY_ENVIRONMENT_ID: undefined,
    RAILWAY_DEPLOYMENT_ID: undefined,
    AGENT_CONTROL_SCHEDULED_ENABLED: undefined,
  }, async () => assert.equal(shouldRunScheduledAgentCycles(), false))

  await withEnv({
    NODE_ENV: 'production',
    RAILWAY_ENVIRONMENT_ID: undefined,
    RAILWAY_DEPLOYMENT_ID: undefined,
    AGENT_CONTROL_SCHEDULED_ENABLED: undefined,
  }, async () => assert.equal(shouldRunScheduledAgentCycles(), true))

  await withEnv({
    NODE_ENV: 'production',
    AGENT_CONTROL_SCHEDULED_ENABLED: 'false',
  }, async () => assert.equal(shouldRunScheduledAgentCycles(), false))

  await withEnv({
    NODE_ENV: 'development',
    AGENT_CONTROL_SCHEDULED_ENABLED: 'true',
  }, async () => assert.equal(shouldRunScheduledAgentCycles(), true))
})

test('scheduled cycle timing uses bounded production defaults', async () => {
  await withEnv({
    AGENT_CONTROL_SCHEDULE_INTERVAL_MS: undefined,
    AGENT_CONTROL_SCHEDULE_INITIAL_DELAY_MS: undefined,
  }, async () => {
    assert.equal(resolveScheduledCycleIntervalMs(), 6 * 60 * 60 * 1000)
    assert.equal(resolveScheduledCycleInitialDelayMs(), 60 * 1000)
  })

  await withEnv({
    AGENT_CONTROL_SCHEDULE_INTERVAL_MS: '1000',
    AGENT_CONTROL_SCHEDULE_INITIAL_DELAY_MS: '0',
  }, async () => {
    assert.equal(resolveScheduledCycleIntervalMs(), 15 * 60 * 1000)
    assert.equal(resolveScheduledCycleInitialDelayMs(), 10 * 1000)
  })
})

test('scheduled tick delegates to the durable scheduled_cycle orchestrator path', async () => {
  resetAgentControlSchedulerForTests()
  let captured = null
  const startCycle = async (db, args) => {
    captured = { db, args }
    return { run: { id: 'run-1', run_type: 'scheduled_cycle' }, steps: [] }
  }
  const db = { dialect: 'postgres' }

  const result = await withEnv({
    NODE_ENV: 'production',
    AGENT_CONTROL_SCHEDULED_ENABLED: undefined,
  }, () => runScheduledAgentCycleTick({
    db,
    startCycle,
    logger: { info() {}, warn() {} },
  }))

  assert.equal(result.run.id, 'run-1')
  assert.equal(captured.db, db)
  assert.equal(captured.args.options.scheduled, true)
  assert.equal(captured.args.options.skip_if_locked, true)
  assert.equal(captured.args.options.lock_acquire_retries, 0)
})

test('scheduler arms once and stops cleanly', async () => {
  resetAgentControlSchedulerForTests()
  const result = await withEnv({
    NODE_ENV: 'development',
    AGENT_CONTROL_SCHEDULED_ENABLED: 'true',
  }, async () => startAgentControlScheduler({
    db: { dialect: 'sqlite' },
    logger: { info() {}, warn() {} },
  }))

  assert.equal(result.started, true)
  assert.equal(startAgentControlScheduler({ db: {}, logger: { info() {}, warn() {} } }).started, false)
  assert.equal(stopAgentControlScheduler().stopped, true)
  resetAgentControlSchedulerForTests()
})

test('scheduled tick fails honestly without crashing the server loop', async () => {
  resetAgentControlSchedulerForTests()
  const result = await withEnv({
    NODE_ENV: 'production',
    AGENT_CONTROL_SCHEDULED_ENABLED: undefined,
  }, () => runScheduledAgentCycleTick({
    db: {},
    startCycle: async () => { throw new Error('database unavailable') },
    logger: { info() {}, warn() {} },
  }))

  assert.deepEqual(result, { failed: true, error: 'database unavailable' })
})
