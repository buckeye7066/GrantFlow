import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  buildExternalApplicationIdentity,
  resolveCanonicalFundingSourceIdentity,
} from '../services/hamilton/hamiltonAutomationOrchestrator.js'
import {
  _resetSubmissionAttemptSchemaCache,
  buildSubmissionAttemptIdempotencyKey,
  createOrClaimSubmissionAttempt,
} from '../services/hamilton/hamiltonSubmissionAttemptStore.js'

const NOW = new Date('2026-08-05T18:00:00.000Z')

function makeDb() {
  _resetSubmissionAttemptSchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

function attemptArgs({ taskId, identity, targetUrl, fundingSourceId = 'funding_opportunity:opp-1' }) {
  return {
    taskId,
    profileId: 'profile-1',
    userId: 'user-1',
    fundingSourceId,
    authorizationTargetId: 'opp-1',
    portalHost: 'portal.example.org',
    targetUrl,
    executableTargetUrl: targetUrl,
    applicationIdentity: identity,
    authorizationVersion: 'hamilton-external-submit-v2',
    authorizationIds: ['auth-submit'],
    consentSnapshot: { version: 'hamilton-external-submit-v2', submit: true },
    answerSnapshotHash: 'a'.repeat(64),
    now: NOW,
  }
}

beforeEach(() => _resetSubmissionAttemptSchemaCache())

describe('Hamilton external application identity', () => {
  it('canonicalizes explicit application IDs and every application query alias', () => {
    const url = 'https://portal.example.org/resume/application?applicationId=ABC-123'
    const explicit = buildExternalApplicationIdentity({
      task: { portal_application_id: 'ABC-123' }, fundingSourceId: 'opp-1', portalUrl: url,
    })
    for (const alias of ['applicationId', 'application_id', 'APPLICATION-ID']) {
      const query = buildExternalApplicationIdentity({
        fundingSourceId: 'opp-1',
        portalUrl: `https://portal.example.org/resume/application?${alias}=ABC-123`,
      })
      expect(query).toBe(explicit)
      expect(query).not.toContain('ABC-123')
    }
  })

  it('preserves application/workspace semantics while converging their own aliases', () => {
    const application = buildExternalApplicationIdentity({
      fundingSourceId: 'opp-1',
      portalUrl: 'https://portal.example.org/apply?application_id=SAME-123',
    })
    const workspace = buildExternalApplicationIdentity({
      fundingSourceId: 'opp-1',
      portalUrl: 'https://portal.example.org/apply?workspaceId=SAME-123',
    })
    const explicitWorkspace = buildExternalApplicationIdentity({
      task: { portal_workspace_id: 'SAME-123' },
      fundingSourceId: 'opp-1',
      portalUrl: 'https://portal.example.org/apply',
    })
    expect(workspace).toBe(explicitWorkspace)
    expect(application).not.toBe(workspace)
  })

  it('fails closed on conflicting explicit/query aliases and multiple explicit sources', () => {
    expect(() => buildExternalApplicationIdentity({
      task: { portal_application_id: 'APP-A' }, fundingSourceId: 'opp-1',
      portalUrl: 'https://portal.example.org/apply?applicationId=APP-B',
    })).toThrow('portal_application_identity_conflict')
    expect(() => buildExternalApplicationIdentity({
      fundingSourceId: 'opp-1',
      portalUrl: 'https://portal.example.org/apply?applicationId=APP-A&application_id=APP-B',
    })).toThrow('portal_application_identity_conflict')
    expect(() => buildExternalApplicationIdentity({
      task: { portal_application_id: 'APP-A' }, opportunity: { portal_application_id: 'APP-B' },
      fundingSourceId: 'opp-1', portalUrl: 'https://portal.example.org/apply',
    })).toThrow('portal_application_identity_conflict')
  })

  it('rejects simultaneous identity kinds unless the reviewed adapter declares and binds one exact query kind', () => {
    const portalUrl = 'https://portal.example.org/apply?applicationId=APP-A&workspaceId=WS-B'
    expect(() => buildExternalApplicationIdentity({
      fundingSourceId: 'opp-1', portalUrl,
    })).toThrow('portal_identity_kind_conflict')
    const adapter = {
      application_identity_kind: 'application',
      status_query: { query_parameter: 'applicationId' },
    }
    expect(buildExternalApplicationIdentity({ fundingSourceId: 'opp-1', portalUrl, submissionAdapter: adapter }))
      .toBe(buildExternalApplicationIdentity({
        fundingSourceId: 'opp-1', portalUrl: 'https://portal.example.org/apply?applicationId=APP-A',
        submissionAdapter: adapter,
      }))
    expect(() => buildExternalApplicationIdentity({
      task: { portal_application_id: 'APP-A' }, fundingSourceId: 'opp-1',
      portalUrl: 'https://portal.example.org/apply?workspaceId=WS-B', submissionAdapter: adapter,
    })).toThrow('reviewed_adapter_exact_identity_query_required')
  })

  it('keeps later cycles distinct when the portal has not issued an application ID', () => {
    const first = buildExternalApplicationIdentity({
      opportunity: { application_round: '2026' },
      fundingSourceId: 'opp-1', portalUrl: 'https://portal.example.org/apply',
    })
    const later = buildExternalApplicationIdentity({
      opportunity: { application_round: '2027' },
      fundingSourceId: 'opp-1', portalUrl: 'https://portal.example.org/apply',
    })
    expect(first).not.toBe(later)
  })

  it('does not treat a funder opportunity/catalog ID as an applicant-specific application identity', () => {
    const withCatalogQuery = buildExternalApplicationIdentity({
      opportunity: { application_round: '2026' }, fundingSourceId: 'opp-1',
      portalUrl: 'https://portal.example.org/apply?opportunityId=PUBLIC-CATALOG-123',
    })
    const withoutCatalogQuery = buildExternalApplicationIdentity({
      opportunity: { application_round: '2026' }, fundingSourceId: 'opp-1',
      portalUrl: 'https://portal.example.org/apply',
    })
    expect(withCatalogQuery).toBe(withoutCatalogQuery)
  })

  it('blocks conflicting fallback cycles/deadlines but normalizes equivalent date forms', () => {
    expect(() => buildExternalApplicationIdentity({
      task: { application_round: '2026' }, opportunity: { application_round: '2027' },
      fundingSourceId: 'opp-1', portalUrl: 'https://portal.example.org/apply',
    })).toThrow('portal_funding_cycle_conflict')
    const dateA = buildExternalApplicationIdentity({
      task: { deadline: '2026-12-01' }, opportunity: { deadline: 'December 1, 2026' },
      fundingSourceId: 'opp-1', portalUrl: 'https://portal.example.org/apply',
    })
    const dateB = buildExternalApplicationIdentity({
      task: { deadline: '2026-12-01T15:00:00Z' },
      fundingSourceId: 'opp-1', portalUrl: 'https://portal.example.org/apply',
    })
    expect(dateA).toBe(dateB)
  })

  it('converges grant and linked-opportunity tasks on one database-enforced attempt', async () => {
    const db = makeDb()
    const targetUrl = 'https://portal.example.org/apply?applicationId=ABC-123&resume=secret'
    const explicitIdentity = buildExternalApplicationIdentity({
      task: { portal_application_id: 'ABC-123' }, fundingSourceId: 'funding_opportunity:opp-1', portalUrl: targetUrl,
    })
    const queryIdentity = buildExternalApplicationIdentity({
      fundingSourceId: 'funding_opportunity:opp-1', portalUrl: targetUrl,
    })
    const fromOpportunity = resolveCanonicalFundingSourceIdentity({ opportunity: { id: 'opp-1' } })
    const fromGrant = resolveCanonicalFundingSourceIdentity({ grant: { id: 'grant-9', funding_opportunity_id: 'opp-1' } })
    expect(fromOpportunity).toBe(fromGrant)
    expect(buildSubmissionAttemptIdempotencyKey({
      profileId: 'profile-1', fundingSourceId: fromOpportunity,
      portalHost: 'portal.example.org', applicationIdentity: explicitIdentity,
    })).toBe(buildSubmissionAttemptIdempotencyKey({
      profileId: 'profile-1', fundingSourceId: fromGrant,
      portalHost: 'portal.example.org', applicationIdentity: queryIdentity,
    }))

    const [a, b] = await Promise.all([
      createOrClaimSubmissionAttempt(db, attemptArgs({ taskId: 'task-grant', identity: explicitIdentity, targetUrl, fundingSourceId: fromGrant })),
      createOrClaimSubmissionAttempt(db, attemptArgs({ taskId: 'task-opportunity', identity: queryIdentity, targetUrl, fundingSourceId: fromOpportunity })),
    ])
    expect(a.attempt.id).toBe(b.attempt.id)
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1)
    const rows = await db.prepare('SELECT id FROM hamilton_submission_attempts').all()
    expect(rows).toHaveLength(1)
    const winner = a.claimed ? a.attempt : b.attempt
    const follower = a.claimed ? b.attempt : a.attempt
    expect(new Set([...winner.task_references, ...follower.task_references])).toEqual(
      new Set(['task-grant', 'task-opportunity']),
    )
  })
})
