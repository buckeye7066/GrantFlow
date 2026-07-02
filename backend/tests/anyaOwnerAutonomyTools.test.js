/**
 * Owner autonomy tools shipped for the "Anya edits on her own" mission:
 *   owner.moderate_match        — promote/demote/dismiss/restore pipeline matches
 *   owner.requeue_hamilton_task — re-kick blocked/failed Hamilton tasks
 *   owner.recrawl_weak_profile  — targeted coverage repair (seed + re-crawl)
 *   owner.propose_code_fix      — patch → workflow → PR (CI-gated auto-merge)
 *
 * Every tool: owner-gated (hidden from non-owner lists, 403 at invoke), param
 * validation AFTER the auth gate, audited in anya_tool_usage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { invokeTool, listToolMetadata } from '../services/anyaToolRegistry.js'
import { findDismissal } from '../services/pipelineDismissals.js'
import { ensureApplicationTask, getApplicationTask, _resetSchemaCache } from '../services/hamilton/applicationTaskStore.js'

// The recrawl tool leans on Robert's funding-trace bridge (live ProPublica web
// lookups) and the crawler dispatcher — both mocked so these tests stay
// hermetic. The mocks intercept the tool handlers' dynamic imports too.
vi.mock('../services/robert/robertFundingTraceBridge.js', () => ({
  // Mirrors the REAL return shape of robertFundingTraceBridge.autoSeedTraceForProfile.
  autoSeedTraceForProfile: vi.fn(async (_db, { profileId }) => ({
    profile_id: profileId,
    seeds_traced: 2,
    total_addable: 4,
    total_upserted: 3,
    per_entity: [{ entity: 'Peer Org A' }, { entity: 'Peer Org B' }],
  })),
  // Mirrors the REAL return shape of autoSeedWeakestProfiles.
  autoSeedWeakestProfiles: vi.fn(async () => ({ evaluated: 5, weak_profiles: 2, total_upserted: 6, per_profile: [] })),
}))
vi.mock('../services/crawlerJobCreation.js', () => ({
  createCrawlerJob: vi.fn(async () => ({ jobId: 'job-recrawl-1' })),
}))
vi.mock('../services/crawlerDispatcher.js', () => ({
  dispatchCrawlerJob: vi.fn(async () => ({ ok: true })),
}))
import { autoSeedTraceForProfile, autoSeedWeakestProfiles } from '../services/robert/robertFundingTraceBridge.js'
import { createCrawlerJob } from '../services/crawlerJobCreation.js'

const OWNER = 'buckeye7066@gmail.com'
const NEW_TOOLS = [
  'owner.moderate_match',
  'owner.requeue_hamilton_task',
  'owner.recrawl_weak_profile',
  'owner.propose_code_fix',
]

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT,
      status TEXT DEFAULT 'active', created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, source_url TEXT, sponsor TEXT, deadline TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT,
      title TEXT, status TEXT DEFAULT 'discovered', match_score INTEGER,
      source_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
    );
    CREATE TABLE milestones (id TEXT PRIMARY KEY, grant_id TEXT);
    CREATE TABLE expenses (id TEXT PRIMARY KEY, grant_id TEXT);
    CREATE TABLE application_drafts (id TEXT PRIMARY KEY, grant_id TEXT);
    CREATE TABLE documents (id TEXT PRIMARY KEY, grant_id TEXT);
    CREATE TABLE anya_tool_usage (
      id TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      tool_name TEXT, session_id TEXT, user_id TEXT, profile_id TEXT,
      parameters TEXT, success INTEGER, error_message TEXT, execution_time_ms INTEGER
    );
    INSERT INTO profiles (id, display_name, primary_type) VALUES ('p1', 'Weak Profile', 'individual');
    INSERT INTO funding_opportunities (id, title, source_url) VALUES ('opp1', 'Test Opportunity', 'https://example.org/g');
    INSERT INTO grants (id, profile_id, funding_opportunity_id, title, status, match_score, source_url)
      VALUES ('g1', 'p1', 'opp1', 'Test Opportunity', 'discovered', 62, 'https://example.org/g');
    INSERT INTO grants (id, profile_id, title, status, match_score)
      VALUES ('g2', 'p1', 'Awarded Grant', 'awarded', 90);
  `)
  return db
}

const ownerCtx = (db, extra = {}) => ({
  db,
  ctx: { isAdmin: true, email: OWNER, userId: 'owner1' },
  user: { role: 'admin', email: OWNER },
  ...extra,
})
const adminCtx = (db) => ({
  db,
  ctx: { isAdmin: true, email: 'other-admin@example.com', userId: 'u2' },
  user: { role: 'admin', email: 'other-admin@example.com' },
})

describe('owner gate integrity for the new autonomy tools', () => {
  it('hides all four tools from a non-owner admin but shows them to the owner', () => {
    const adminTools = listToolMetadata({ isAdmin: true, email: 'other-admin@example.com' }).map((t) => t.name)
    const ownerTools = listToolMetadata({ isAdmin: true, email: OWNER }).map((t) => t.name)
    for (const name of NEW_TOOLS) {
      expect(adminTools, `${name} must be hidden from non-owner`).not.toContain(name)
      expect(ownerTools, `${name} must be advertised to owner`).toContain(name)
    }
  })

  it('rejects a non-owner admin with 403 BEFORE param validation (no schema disclosure)', async () => {
    const db = createDb()
    try {
      for (const name of NEW_TOOLS) {
        // Deliberately missing required params: an unauthorized caller must get
        // the owner-account 403, never a 400 naming the missing parameter.
        await expect(invokeTool(name, {}, adminCtx(db))).rejects.toThrow(/owner account/i)
      }
    } finally { db.close() }
  })

  it('validates params for the owner (400-class errors AFTER the gate)', async () => {
    const db = createDb()
    try {
      await expect(invokeTool('owner.moderate_match', {}, ownerCtx(db))).rejects.toThrow(/profileId/i)
      await expect(invokeTool('owner.requeue_hamilton_task', {}, ownerCtx(db))).rejects.toThrow(/taskId/i)
      await expect(invokeTool('owner.propose_code_fix', {}, ownerCtx(db))).rejects.toThrow(/patch/i)
    } finally { db.close() }
  })

  it('audits invocations in anya_tool_usage (success and failure)', async () => {
    const db = createDb()
    try {
      await invokeTool('owner.moderate_match', { profileId: 'p1', action: 'promote', grantId: 'g1' }, ownerCtx(db))
      await expect(
        invokeTool('owner.moderate_match', { profileId: 'p1', action: 'promote', grantId: 'missing' }, ownerCtx(db)),
      ).rejects.toThrow(/not found/i)
      const rows = db.prepare(`SELECT tool_name, success FROM anya_tool_usage WHERE tool_name = 'owner.moderate_match'`).all()
      expect(rows.length).toBe(2)
      expect(rows.map((r) => Number(r.success)).sort()).toEqual([0, 1])
    } finally { db.close() }
  })
})

describe('owner.moderate_match', () => {
  it('promote raises the score (default 85) and demote lowers it, profile-scoped', async () => {
    const db = createDb()
    try {
      const { output: promoted } = await invokeTool(
        'owner.moderate_match',
        { profileId: 'p1', action: 'promote', grantId: 'g1' },
        ownerCtx(db),
      )
      expect(promoted.previous_score).toBe(62)
      expect(promoted.new_score).toBe(85)
      expect(db.prepare('SELECT match_score FROM grants WHERE id = ?').get('g1').match_score).toBe(85)

      const { output: demoted } = await invokeTool(
        'owner.moderate_match',
        { profileId: 'p1', action: 'demote', grantId: 'g1', score: 40 },
        ownerCtx(db),
      )
      expect(demoted.new_score).toBe(40)

      // Cross-profile scoping: the grant is invisible to another profile id.
      await expect(
        invokeTool('owner.moderate_match', { profileId: 'other', action: 'promote', grantId: 'g1' }, ownerCtx(db)),
      ).rejects.toThrow(/not found/i)
    } finally { db.close() }
  })

  it('clamps scores to 0-100', async () => {
    const db = createDb()
    try {
      const { output } = await invokeTool(
        'owner.moderate_match',
        { profileId: 'p1', action: 'promote', grantId: 'g1', score: 250 },
        ownerCtx(db),
      )
      expect(output.new_score).toBe(100)
    } finally { db.close() }
  })

  it('dismiss deletes the grant AND records a sticky pipeline_dismissals tombstone', async () => {
    const db = createDb()
    try {
      const { output } = await invokeTool(
        'owner.moderate_match',
        { profileId: 'p1', action: 'dismiss', grantId: 'g1' },
        ownerCtx(db),
      )
      expect(output.dismissed).toBe(true)
      expect(db.prepare('SELECT 1 FROM grants WHERE id = ?').get('g1')).toBeUndefined()
      const tombstone = await findDismissal(db, 'p1', { id: 'opp1', title: 'Test Opportunity', source_url: 'https://example.org/g' })
      expect(tombstone).toBeTruthy()
    } finally { db.close() }
  })

  it('refuses to dismiss a user-progressed (awarded) grant without force:true', async () => {
    const db = createDb()
    try {
      await expect(
        invokeTool('owner.moderate_match', { profileId: 'p1', action: 'dismiss', grantId: 'g2' }, ownerCtx(db)),
      ).rejects.toThrow(/force/i)
      // Still present.
      expect(db.prepare('SELECT 1 FROM grants WHERE id = ?').get('g2')).toBeTruthy()
      // With force it proceeds.
      const { output } = await invokeTool(
        'owner.moderate_match',
        { profileId: 'p1', action: 'dismiss', grantId: 'g2', force: true },
        ownerCtx(db),
      )
      expect(output.dismissed).toBe(true)
    } finally { db.close() }
  })

  it('restore clears the tombstone so the matcher may re-add the opportunity', async () => {
    const db = createDb()
    try {
      await invokeTool('owner.moderate_match', { profileId: 'p1', action: 'dismiss', grantId: 'g1' }, ownerCtx(db))
      expect(await findDismissal(db, 'p1', { id: 'opp1', title: 'Test Opportunity', source_url: 'https://example.org/g' })).toBeTruthy()

      const { output } = await invokeTool(
        'owner.moderate_match',
        { profileId: 'p1', action: 'restore', opportunityId: 'opp1' },
        ownerCtx(db),
      )
      expect(output.tombstones_cleared).toBeGreaterThan(0)
      expect(await findDismissal(db, 'p1', { id: 'opp1', title: 'Test Opportunity', source_url: 'https://example.org/g' })).toBeFalsy()
    } finally { db.close() }
  })

  it('rejects an unknown action', async () => {
    const db = createDb()
    try {
      await expect(
        invokeTool('owner.moderate_match', { profileId: 'p1', action: 'obliterate', grantId: 'g1' }, ownerCtx(db)),
      ).rejects.toThrow(/unknown action/i)
    } finally { db.close() }
  })
})

describe('owner.requeue_hamilton_task', () => {
  // The task store ensures its schema once per process; each test here uses a
  // fresh in-memory db, so the cache must be reset per test.
  beforeEach(() => _resetSchemaCache())

  it('requeues a blocked task to ready via the canonical state machine', async () => {
    const db = createDb()
    try {
      const task = await ensureApplicationTask(db, {
        profileId: 'p1',
        grantId: 'g1',
        automationType: 'portal',
        initialStatus: 'blocked',
      })
      const { output } = await invokeTool(
        'owner.requeue_hamilton_task',
        { taskId: task.id, reason: 'owner asked Anya to re-kick it' },
        ownerCtx(db),
      )
      expect(output.previous_status).toBe('blocked')
      expect(output.new_status).toBe('ready')
      const after = await getApplicationTask(db, task.id)
      expect(after.status).toBe('ready')
    } finally { db.close() }
  })

  it('requeues failed and waiting_for_* tasks but refuses in-flight/terminal ones', async () => {
    const db = createDb()
    try {
      const failed = await ensureApplicationTask(db, { profileId: 'p1', grantId: 'g2', initialStatus: 'failed' })
      const { output } = await invokeTool('owner.requeue_hamilton_task', { taskId: failed.id }, ownerCtx(db))
      expect(output.new_status).toBe('ready')

      const inflight = await ensureApplicationTask(db, { profileId: 'p1', opportunityId: 'opp1', initialStatus: 'in_progress' })
      await expect(
        invokeTool('owner.requeue_hamilton_task', { taskId: inflight.id }, ownerCtx(db)),
      ).rejects.toThrow(/only blocked/i)
    } finally { db.close() }
  })

  it('errors clearly on an unknown task id', async () => {
    const db = createDb()
    try {
      await expect(
        invokeTool('owner.requeue_hamilton_task', { taskId: 'nope' }, ownerCtx(db)),
      ).rejects.toThrow(/not found/i)
    } finally { db.close() }
  })
})

describe('owner.recrawl_weak_profile', () => {
  it('errors clearly on an unknown profile', async () => {
    const db = createDb()
    try {
      await expect(
        invokeTool('owner.recrawl_weak_profile', { profileId: 'missing', skipCrawl: true }, ownerCtx(db)),
      ).rejects.toThrow(/not found/i)
    } finally { db.close() }
  })

  it('targeted mode seeds sources via the trace bridge AND dispatches a crawler job', async () => {
    const db = createDb()
    try {
      const { output } = await invokeTool(
        'owner.recrawl_weak_profile',
        { profileId: 'p1' },
        ownerCtx(db),
      )
      expect(output.ok).toBe(true)
      expect(output.mode).toBe('targeted')
      expect(autoSeedTraceForProfile).toHaveBeenCalled()
      expect(output.seeded.entities).toBe(2)
      expect(output.seeded.upserted).toBe(3)
      expect(output.crawl).toEqual({ job_id: 'job-recrawl-1', type: 'comprehensive' })
      expect(createCrawlerJob).toHaveBeenCalledWith(db, expect.objectContaining({
        type: 'comprehensive',
        parameters: { profile_id: 'p1' },
      }))
    } finally { db.close() }
  })

  it('skipCrawl:true seeds only (no crawler job)', async () => {
    const db = createDb()
    try {
      createCrawlerJob.mockClear()
      const { output } = await invokeTool(
        'owner.recrawl_weak_profile',
        { profileId: 'p1', skipCrawl: true },
        ownerCtx(db),
      )
      expect(output.crawl).toBeNull()
      expect(createCrawlerJob).not.toHaveBeenCalled()
    } finally { db.close() }
  })

  it('without a profileId runs the weakest-profiles sweep', async () => {
    const db = createDb()
    try {
      const { output } = await invokeTool('owner.recrawl_weak_profile', {}, ownerCtx(db))
      expect(output.mode).toBe('weakest_sweep')
      expect(autoSeedWeakestProfiles).toHaveBeenCalled()
      expect(output.weak_profiles).toBe(2)
      expect(output.total_upserted).toBe(6)
    } finally { db.close() }
  })

  it('reports an honest seed_error while still dispatching the re-crawl', async () => {
    const db = createDb()
    try {
      autoSeedTraceForProfile.mockRejectedValueOnce(new Error('propublica down'))
      const { output } = await invokeTool('owner.recrawl_weak_profile', { profileId: 'p1' }, ownerCtx(db))
      expect(output.ok).toBe(true)
      expect(output.seed_error).toMatch(/propublica down/)
      expect(output.crawl?.job_id).toBe('job-recrawl-1')
    } finally { db.close() }
  })
})

describe('owner.propose_code_fix (tool wiring)', () => {
  const PATCH = [
    'diff --git a/backend/services/example.js b/backend/services/example.js',
    '--- a/backend/services/example.js',
    '+++ b/backend/services/example.js',
    '@@ -1 +1 @@',
    '-const x = 1',
    '+const x = 2',
    '',
  ].join('\n')

  it('dispatches via the injected fetch and returns the actions URL', async () => {
    const db = createDb()
    const prevToken = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = 'test-token'
    try {
      let captured = null
      const { output } = await invokeTool(
        'owner.propose_code_fix',
        { patch: PATCH, title: 'bump constant' },
        ownerCtx(db, { fetchImpl: async (url, opts) => { captured = { url, opts }; return { status: 204 } } }),
      )
      expect(output.ok).toBe(true)
      expect(output.dispatched).toBe(true)
      expect(output.automerge).toBe(true)
      expect(captured.url).toContain('/actions/workflows/anya-code-fix-pr.yml/dispatches')
      expect(JSON.parse(captured.opts.body).inputs.pr_title).toBe('bump constant')
    } finally {
      if (prevToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = prevToken
      db.close()
    }
  })

  it('surfaces a protected-path refusal as a thrown, owner-readable error', async () => {
    const db = createDb()
    const prevToken = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = 'test-token'
    try {
      const evil = 'diff --git a/.github/workflows/test.yml b/.github/workflows/test.yml\n--- a/.github/workflows/test.yml\n+++ b/.github/workflows/test.yml\n@@ -1 +1 @@\n-a\n+b\n'
      await expect(
        invokeTool('owner.propose_code_fix', { patch: evil }, ownerCtx(db, { fetchImpl: async () => ({ status: 204 }) })),
      ).rejects.toThrow(/protected path/i)
    } finally {
      if (prevToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = prevToken
      db.close()
    }
  })
})
