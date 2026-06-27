import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { searchWeb, _resetWebSearchEngineForTests } from '../../backend/services/shared/webSearchEngine.js'

test('shared web search does not call live providers during the unit-test gate', async () => {
  const previousRunner = process.env.GRANTFLOW_TEST_RUNNER
  const previousAllow = process.env.GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS
  const previousNodeEnv = process.env.NODE_ENV

  process.env.GRANTFLOW_TEST_RUNNER = '1'
  process.env.NODE_ENV = 'development'
  delete process.env.GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS
  _resetWebSearchEngineForTests()

  try {
    const startedAt = performance.now()
    const results = await searchWeb('site:example.com grants for farms', { count: 5, timeoutMs: 5000 })
    const elapsedMs = performance.now() - startedAt

    assert.deepEqual(results, [])
    assert.ok(
      elapsedMs < 250,
      `unit-test search guard should return before a network timeout; elapsed ${elapsedMs.toFixed(1)}ms`,
    )
  } finally {
    if (previousRunner === undefined) delete process.env.GRANTFLOW_TEST_RUNNER
    else process.env.GRANTFLOW_TEST_RUNNER = previousRunner
    if (previousAllow === undefined) delete process.env.GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS
    else process.env.GRANTFLOW_ALLOW_LIVE_WEB_IN_TESTS = previousAllow
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    _resetWebSearchEngineForTests()
  }
})
