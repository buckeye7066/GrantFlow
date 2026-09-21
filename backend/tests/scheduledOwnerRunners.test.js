import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ lock: vi.fn(), amy: vi.fn(), robert: vi.fn() }))
vi.mock('../services/schedulerLock.js', () => ({ runWithSchedulerLock: mocks.lock }))
vi.mock('../services/amy/amyAgent.js', () => ({ runAmyTraining: mocks.amy }))
vi.mock('../services/robert/robertAgent.js', () => ({ runRobert: mocks.robert }))
import { getOwnerAiScope } from '../services/ownerAi/ownerAiScope.js'
import { launchAmyRun } from '../services/amy/amyRunner.js'
import { startRobertScheduler, stopRobertScheduler } from '../services/robert/robertScheduler.js'

let db
let lease
beforeEach(() => {
  vi.stubEnv('OWNER_AI_BACKGROUND_ENABLED', 'true')
  vi.stubEnv('OWNER_AI_EMAIL', 'scheduler-owner@example.test')
  vi.stubEnv('OWNER_AI_USER_ID', '')
  vi.stubEnv('ROBERT_ENABLED', 'true')
  vi.stubEnv('ROBERT_RUN_ON_STARTUP', 'true')
  vi.stubEnv('ROBERT_RUN_ON_SCHEDULE', 'false')
  vi.stubEnv('ROBERT_AUTOSEED_ON_SCHEDULE', 'false')
  vi.stubEnv('ROBERT_ACQUIRE_ON_SCHEDULE', 'false')
  db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'))
  db.prepare('INSERT INTO users (id, primary_email, is_admin) VALUES (?, ?, ?)').run('owner-scheduler', 'scheduler-owner@example.test', 1)
  lease = new AbortController()
  mocks.lock.mockReset().mockImplementation((_db, options, work) => work(options.heartbeat ? { signal: lease.signal } : {}))
  mocks.amy.mockReset()
  mocks.robert.mockReset()
})
afterEach(() => { stopRobertScheduler(); db.close(); vi.unstubAllEnvs() })

it('Robert scheduled discovery renews its lock and receives verified subscription scope plus lease cancellation', async () => {
  let observed
  mocks.robert.mockImplementation(async ({ signal }) => {
    observed = { workload: getOwnerAiScope()?.workload, signal }
    lease.abort()
    return { status: 'completed' }
  })
  startRobertScheduler({ db, logger: { info() {}, error() {} } })
  await vi.waitFor(() => expect(observed).toBeDefined())
  expect(mocks.lock.mock.calls[0][1].heartbeat).toBe(true)
  expect(observed.workload).toBe('robert_discovery')
  expect(observed.signal?.aborted).toBe(true)
})

it('Amy scheduled training receives subscription scope while manual launches cannot opt themselves in', async () => {
  const seen = []
  mocks.amy.mockImplementation(async ({ signal }) => {
    seen.push({ workload: getOwnerAiScope()?.workload ?? null, signal })
    return { summary: {} }
  })
  await launchAmyRun({ db, source: 'scheduler', withArtifacts: false, logger: { info() {}, error() {} } }).promise
  await launchAmyRun({ db, source: 'admin', withArtifacts: false, logger: { info() {}, error() {} } }).promise
  expect(seen.map(item => item.workload)).toEqual(['amy_training', null])
  expect(mocks.lock.mock.calls.every(call => call[1].heartbeat === true)).toBe(true)
})
