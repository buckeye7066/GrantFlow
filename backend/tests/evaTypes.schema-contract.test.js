import { describe, expect, it } from 'vitest'
import { validateResultPayload } from '../services/eva/evaTypes.js'

function validPayload() {
  return {
    schema_version: 1,
    run_id: 'run-abc-1',
    runner_id: 'runner-1',
    started_at: '2026-08-25T12:34:56.789Z',
    completed_at: '2026-08-25T12:35:56+00:00',
    environment: 'fixture',
    runner_version: '1.0.0',
    catchup: false,
    apps: [
      {
        app_id: 'grantflow',
        display_name: 'GrantFlow',
        repo: 'owner/grantflow',
        commit_sha: 'a'.repeat(40),
        app_status: 'tested',
        blocker_reason: '',
        duration_ms: 1000,
        feature_coverage: {
          features_total: 2,
          features_covered: 1,
          unautomated_features: ['Export results'],
        },
        journeys: [
          {
            journey_id: 'login.happy-path',
            name: 'Login',
            status: 'passed',
            severity: 'info',
            retry_classification: 'not-retried',
            duration_ms: 12,
            route_or_control: '/login',
            failure_class: '',
            error_signature: '',
            expected_behavior: '',
            observed_behavior: '',
            repro_steps: [],
            user_impact: '',
            likely_root_cause: '',
            recommended_fix: '',
            candidate_files: [],
            diagnostic_confidence: 1,
            missing_evidence: '',
            evidence: [
              {
                kind: 'screenshot',
                ref: 'artifacts/login.png',
                sha256: 'a'.repeat(64),
                bytes: 123,
              },
            ],
          },
        ],
      },
    ],
  }
}

function minimalApp(index = 0) {
  return {
    app_id: `app-${index}`,
    display_name: '',
    app_status: 'tested',
    duration_ms: 0,
    journeys: [],
  }
}

function minimalJourney(index = 0) {
  return { journey_id: `journey-${index}`, name: '', status: 'passed' }
}

function clonePayload() {
  return structuredClone(validPayload())
}

function app(payload) {
  return payload.apps[0]
}

function journey(payload) {
  return app(payload).journeys[0]
}

function evidence(payload) {
  return journey(payload).evidence[0]
}

function expectInvalid(payload, fragment) {
  const result = validateResultPayload(payload)
  expect(result.ok, result.errors.join('\n')).toBe(false)
  if (fragment) expect(result.errors.join('\n')).toContain(fragment)
}

describe('validateResultPayload schema contract', () => {
  it('accepts the complete contract and exact schema boundaries', () => {
    const stringBoundaries = [
      (payload) => { payload.run_id = 'a'.repeat(128) },
      (payload) => { payload.runner_id = 'a'.repeat(64) },
      (payload) => { payload.runner_version = 'a'.repeat(32) },
      (payload) => { app(payload).app_id = 'a'.repeat(64) },
      (payload) => { app(payload).display_name = '😀'.repeat(128) },
      (payload) => { app(payload).repo = 'a'.repeat(128) },
      (payload) => { app(payload).commit_sha = 'a'.repeat(64) },
      (payload) => { app(payload).blocker_reason = 'a'.repeat(500) },
      (payload) => { app(payload).feature_coverage.unautomated_features[0] = 'a'.repeat(200) },
      (payload) => { journey(payload).journey_id = 'a'.repeat(128) },
      (payload) => { journey(payload).name = 'a'.repeat(200) },
      (payload) => { journey(payload).route_or_control = 'a'.repeat(300) },
      (payload) => { journey(payload).failure_class = 'a'.repeat(80) },
      (payload) => { journey(payload).error_signature = 'a'.repeat(500) },
      (payload) => { journey(payload).expected_behavior = 'a'.repeat(1000) },
      (payload) => { journey(payload).observed_behavior = 'a'.repeat(1000) },
      (payload) => { journey(payload).repro_steps[0] = 'a'.repeat(300) },
      (payload) => { journey(payload).user_impact = 'a'.repeat(1000) },
      (payload) => { journey(payload).likely_root_cause = 'a'.repeat(1000) },
      (payload) => { journey(payload).recommended_fix = 'a'.repeat(1000) },
      (payload) => { journey(payload).candidate_files[0] = 'a'.repeat(300) },
      (payload) => { journey(payload).missing_evidence = 'a'.repeat(500) },
      (payload) => { evidence(payload).ref = 'a'.repeat(400) },
    ]

    expect(validateResultPayload(validPayload())).toEqual({ ok: true, errors: [] })
    for (const mutate of stringBoundaries) {
      const payload = clonePayload()
      mutate(payload)
      expect(validateResultPayload(payload)).toEqual({ ok: true, errors: [] })
    }

    const arrayBoundaries = [
      (payload) => { payload.apps = Array.from({ length: 100 }, (_, index) => minimalApp(index)) },
      (payload) => { app(payload).journeys = Array.from({ length: 200 }, (_, index) => minimalJourney(index)) },
      (payload) => { app(payload).feature_coverage.unautomated_features = Array(200).fill('a') },
      (payload) => { journey(payload).repro_steps = Array(40).fill('a') },
      (payload) => { journey(payload).candidate_files = Array(20).fill('a') },
      (payload) => { journey(payload).evidence = Array.from({ length: 30 }, () => ({ kind: 'trace', ref: '' })) },
    ]
    for (const mutate of arrayBoundaries) {
      const payload = clonePayload()
      mutate(payload)
      expect(validateResultPayload(payload)).toEqual({ ok: true, errors: [] })
    }
  })

  it('rejects unknown properties at every object level', () => {
    const cases = [
      [(payload) => { payload.extra = true }, 'payload.extra'],
      [(payload) => { app(payload).extra = true }, 'apps[0].extra'],
      [(payload) => { app(payload).feature_coverage.extra = true }, 'feature_coverage.extra'],
      [(payload) => { journey(payload).extra = true }, 'journeys[0].extra'],
      [(payload) => { evidence(payload).extra = true }, 'evidence[0].extra'],
    ]
    for (const [mutate, fragment] of cases) {
      const payload = clonePayload()
      mutate(payload)
      expectInvalid(payload, fragment)
    }
  })

  it('rejects null for every optional property family', () => {
    const cases = [
      [(payload) => { payload.runner_version = null }, 'runner_version'],
      [(payload) => { payload.catchup = null }, 'catchup'],
      [(payload) => { app(payload).repo = null }, '.repo'],
      [(payload) => { app(payload).commit_sha = null }, '.commit_sha'],
      [(payload) => { app(payload).blocker_reason = null }, '.blocker_reason'],
      [(payload) => { app(payload).feature_coverage = null }, '.feature_coverage'],
      [(payload) => { app(payload).feature_coverage.features_total = null }, '.features_total'],
      [(payload) => { app(payload).feature_coverage.features_covered = null }, '.features_covered'],
      [(payload) => { app(payload).feature_coverage.unautomated_features = null }, '.unautomated_features'],
      [(payload) => { journey(payload).severity = null }, '.severity'],
      [(payload) => { journey(payload).retry_classification = null }, '.retry_classification'],
      [(payload) => { journey(payload).duration_ms = null }, '.duration_ms'],
      [(payload) => { journey(payload).route_or_control = null }, '.route_or_control'],
      [(payload) => { journey(payload).failure_class = null }, '.failure_class'],
      [(payload) => { journey(payload).error_signature = null }, '.error_signature'],
      [(payload) => { journey(payload).expected_behavior = null }, '.expected_behavior'],
      [(payload) => { journey(payload).observed_behavior = null }, '.observed_behavior'],
      [(payload) => { journey(payload).repro_steps = null }, '.repro_steps'],
      [(payload) => { journey(payload).user_impact = null }, '.user_impact'],
      [(payload) => { journey(payload).likely_root_cause = null }, '.likely_root_cause'],
      [(payload) => { journey(payload).recommended_fix = null }, '.recommended_fix'],
      [(payload) => { journey(payload).candidate_files = null }, '.candidate_files'],
      [(payload) => { journey(payload).diagnostic_confidence = null }, '.diagnostic_confidence'],
      [(payload) => { journey(payload).missing_evidence = null }, '.missing_evidence'],
      [(payload) => { journey(payload).evidence = null }, '.evidence'],
      [(payload) => { evidence(payload).sha256 = null }, '.sha256'],
      [(payload) => { evidence(payload).bytes = null }, '.bytes'],
    ]
    for (const [mutate, fragment] of cases) {
      const payload = clonePayload()
      mutate(payload)
      expectInvalid(payload, fragment)
    }
  })

  it('enforces every string and array maximum immediately above the boundary', () => {
    const cases = [
      [(payload) => { payload.run_id = 'a'.repeat(129) }, 'run_id'],
      [(payload) => { payload.runner_id = 'a'.repeat(65) }, 'runner_id'],
      [(payload) => { payload.runner_version = 'a'.repeat(33) }, 'runner_version'],
      [(payload) => { app(payload).app_id = 'a'.repeat(65) }, '.app_id'],
      [(payload) => { app(payload).display_name = 'a'.repeat(129) }, '.display_name'],
      [(payload) => { app(payload).repo = 'a'.repeat(129) }, '.repo'],
      [(payload) => { app(payload).commit_sha = 'a'.repeat(65) }, '.commit_sha'],
      [(payload) => { app(payload).blocker_reason = 'a'.repeat(501) }, '.blocker_reason'],
      [(payload) => { app(payload).feature_coverage.unautomated_features[0] = 'a'.repeat(201) }, '.unautomated_features[0]'],
      [(payload) => { journey(payload).journey_id = 'a'.repeat(129) }, '.journey_id'],
      [(payload) => { journey(payload).name = 'a'.repeat(201) }, '.name'],
      [(payload) => { journey(payload).route_or_control = 'a'.repeat(301) }, '.route_or_control'],
      [(payload) => { journey(payload).failure_class = 'a'.repeat(81) }, '.failure_class'],
      [(payload) => { journey(payload).error_signature = 'a'.repeat(501) }, '.error_signature'],
      [(payload) => { journey(payload).expected_behavior = 'a'.repeat(1001) }, '.expected_behavior'],
      [(payload) => { journey(payload).observed_behavior = 'a'.repeat(1001) }, '.observed_behavior'],
      [(payload) => { journey(payload).repro_steps = ['a'.repeat(301)] }, '.repro_steps[0]'],
      [(payload) => { journey(payload).user_impact = 'a'.repeat(1001) }, '.user_impact'],
      [(payload) => { journey(payload).likely_root_cause = 'a'.repeat(1001) }, '.likely_root_cause'],
      [(payload) => { journey(payload).recommended_fix = 'a'.repeat(1001) }, '.recommended_fix'],
      [(payload) => { journey(payload).candidate_files = ['a'.repeat(301)] }, '.candidate_files[0]'],
      [(payload) => { journey(payload).missing_evidence = 'a'.repeat(501) }, '.missing_evidence'],
      [(payload) => { evidence(payload).ref = 'a'.repeat(401) }, '.ref'],
      [(payload) => { payload.apps = Array.from({ length: 101 }, (_, index) => minimalApp(index)) }, 'apps'],
      [(payload) => { app(payload).journeys = Array.from({ length: 201 }, (_, index) => minimalJourney(index)) }, '.journeys'],
      [(payload) => { app(payload).feature_coverage.unautomated_features = Array(201).fill('a') }, '.unautomated_features'],
      [(payload) => { journey(payload).repro_steps = Array(41).fill('a') }, '.repro_steps'],
      [(payload) => { journey(payload).candidate_files = Array(21).fill('a') }, '.candidate_files'],
      [(payload) => { journey(payload).evidence = Array.from({ length: 31 }, () => ({ kind: 'trace', ref: '' })) }, '.evidence'],
    ]
    for (const [mutate, fragment] of cases) {
      const payload = clonePayload()
      mutate(payload)
      expectInvalid(payload, fragment)
    }
  })

  it('enforces identifier patterns, date-time format, enums, and numeric types', () => {
    const cases = [
      [(payload) => { payload.run_id = 'short' }, 'run_id'],
      [(payload) => { payload.run_id = 'run has spaces' }, 'run_id'],
      [(payload) => { payload.runner_id = 'ab' }, 'runner_id'],
      [(payload) => { payload.runner_id = 'runner:bad' }, 'runner_id'],
      [(payload) => { payload.started_at = '2026-02-30T12:00:00Z' }, 'started_at'],
      [(payload) => { payload.completed_at = '2026-08-25T12:00:00' }, 'completed_at'],
      [(payload) => { payload.environment = 'production' }, 'environment'],
      [(payload) => { app(payload).app_id = 'GrantFlow' }, '.app_id'],
      [(payload) => { app(payload).app_status = 'passing' }, '.app_status'],
      [(payload) => { app(payload).duration_ms = 0.5 }, '.duration_ms'],
      [(payload) => { app(payload).feature_coverage.features_total = -1 }, '.features_total'],
      [(payload) => { app(payload).feature_coverage.features_covered = 1.5 }, '.features_covered'],
      [(payload) => { journey(payload).journey_id = 'Bad Journey' }, '.journey_id'],
      [(payload) => { journey(payload).status = 'flaky' }, '.status'],
      [(payload) => { journey(payload).severity = 'urgent' }, '.severity'],
      [(payload) => { journey(payload).retry_classification = 'sometimes' }, '.retry_classification'],
      [(payload) => { journey(payload).duration_ms = -1 }, '.duration_ms'],
      [(payload) => { journey(payload).diagnostic_confidence = Number.NaN }, '.diagnostic_confidence'],
      [(payload) => { evidence(payload).kind = 'html' }, '.kind'],
      [(payload) => { evidence(payload).sha256 = 'A'.repeat(64) }, '.sha256'],
      [(payload) => { evidence(payload).bytes = 1.5 }, '.bytes'],
    ]
    for (const [mutate, fragment] of cases) {
      const payload = clonePayload()
      mutate(payload)
      expectInvalid(payload, fragment)
    }
  })

  it('validates required evidence and feature-coverage contents', () => {
    const cases = [
      [(payload) => { app(payload).feature_coverage = [] }, '.feature_coverage'],
      [(payload) => { app(payload).feature_coverage.unautomated_features = [3] }, '.unautomated_features[0]'],
      [(payload) => { journey(payload).evidence = [{}] }, '.kind'],
      [(payload) => { journey(payload).evidence = [{ kind: 'trace' }] }, '.ref'],
      [(payload) => { journey(payload).evidence = ['trace'] }, '.evidence[0]'],
    ]
    for (const [mutate, fragment] of cases) {
      const payload = clonePayload()
      mutate(payload)
      expectInvalid(payload, fragment)
    }
  })

  it('keeps the stricter low-confidence evidence safeguards', () => {
    const failed = clonePayload()
    Object.assign(journey(failed), {
      status: 'failed',
      severity: 'high',
      retry_classification: 'reproducible',
      failure_class: '',
      expected_behavior: '',
      observed_behavior: '',
      repro_steps: [],
      user_impact: '',
      diagnostic_confidence: 0.7,
      missing_evidence: '',
    })
    expect(validateResultPayload(failed)).toEqual({ ok: true, errors: [] })

    journey(failed).diagnostic_confidence = 0.69
    expectInvalid(failed, 'missing_evidence required')

    journey(failed).missing_evidence = 'Need an application trace'
    expect(validateResultPayload(failed)).toEqual({ ok: true, errors: [] })

    journey(failed).diagnostic_confidence = 0.39
    journey(failed).candidate_files = ['src/login.js']
    expectInvalid(failed, 'candidate_files asserted')

    journey(failed).diagnostic_confidence = 0.4
    expect(validateResultPayload(failed)).toEqual({ ok: true, errors: [] })
  })
})
