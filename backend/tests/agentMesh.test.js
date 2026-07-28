/**
 * Agent mesh — awareness / communication / learning between the resident agents.
 *
 * Proves:
 *   - REGISTRY TOTALITY (CLAUDE.md registry rule): every agent id known to any
 *     other roster (agentControlTypes.ALL_AGENTS / STATUS_AGENTS, the adapter
 *     registry, backend/crawler-os/agents/*) is registered in
 *     agentMeshRegistry, plus Amy (who lives outside all three). A new agent
 *     added anywhere without registering here reds CI.
 *   - MESSAGE STORE: append / inbox / ack / broadcast semantics, identity
 *     choke point (unregistered agents refused loudly), body cap, ring bound.
 *   - LESSON STORE: record + (author, topic, claim) dedupe-refresh, topic
 *     closed list, read filters (topics / excludeAuthor / freshWithinHours /
 *     notConsumedBy), consumption stamping (author cannot consume own),
 *     confirm/refute (author self-votes refused; a vote flips the opposite),
 *     ring bound.
 *   - SAM WIRING: consumeMeshForSam surfaces a fresh peer lesson as a one-shot
 *     INFO finding and stamps it consumed; teachMeshFromSamFindings turns a
 *     crawler_reliability finding into a lesson + a message to Amy, and NEVER
 *     re-teaches a cross-agent finding (echo-chamber guard); runSam threads
 *     the whole exchange into summary.agent_mesh.
 *   - AMY WIRING (the cross-agent teach→learn loop, end to end): without a
 *     Sam lesson an all-zero cohort learns `low_results`; WITH a fresh Sam
 *     crawler_reliability lesson the same cohort suppresses `low_results`
 *     (outage ≠ archetype weakness), never CLEARS prior lessons, stamps the
 *     lesson consumed, and Amy's own persistent gaps are taught back to the
 *     board + messaged to Sam.
 *   - ANYA REPORT: the "Agent mesh" section renders messages exchanged and
 *     lessons taught/consumed.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGENT_MESH_REGISTRY,
  AGENT_MESH_IDS,
  assertMeshAgent,
  isMeshAgent,
} from '../services/agentMesh/agentMeshRegistry.js'
import {
  MESH_MESSAGES_MAX,
  MESH_LESSONS_MAX,
  MESH_BODY_MAX_CHARS,
  MESH_LESSON_TOPICS,
  postMeshMessage,
  readMeshInbox,
  ackMeshMessages,
  consumeMeshInbox,
  recordMeshLesson,
  readMeshLessons,
  markMeshLessonConsumed,
  confirmMeshLesson,
  refuteMeshLesson,
  readMeshOverview,
} from '../services/agentMesh/agentMeshStore.js'
import { ALL_AGENTS, STATUS_AGENTS } from '../services/agentControl/agentControlTypes.js'
import { listAdapters } from '../services/agentControl/agentAdapters/agentAdapterRegistry.js'
import { runSam, consumeMeshForSam, teachMeshFromSamFindings } from '../services/sam/samAgent.js'
import { makeFinding, SEVERITY, SAM_CATEGORIES } from '../services/sam/samTypes.js'
import { runAmyTraining } from '../services/amy/amyAgent.js'
import { getArchetypeLearning, KV_LEARNING_KEY } from '../services/amy/archetypeLearning.js'
import { CATEGORY_IDS } from '../services/amy/syntheticProfileCatalog.js'
import { buildOwnerReport, summarizeAgentMesh } from '../services/anya/anyaDailyOwnerReport.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function makeDb() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
  return db
}

// ── Registry totality ────────────────────────────────────────────────────────

describe('agent mesh registry — TOTALITY', () => {
  it('registers every agent-control agent (ALL_AGENTS + STATUS_AGENTS)', () => {
    for (const id of [...ALL_AGENTS, ...STATUS_AGENTS]) {
      expect(AGENT_MESH_REGISTRY[id], `agent-control agent "${id}" missing from agentMeshRegistry`).toBeTruthy()
    }
  })

  it('registers every adapter in the agent-control adapter registry', () => {
    for (const id of Object.keys(listAdapters())) {
      expect(AGENT_MESH_REGISTRY[id], `adapter "${id}" missing from agentMeshRegistry`).toBeTruthy()
    }
  })

  it('registers every crawler-os agent module', () => {
    const dir = path.resolve(__dirname, '..', 'crawler-os', 'agents')
    const ids = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.js') && f !== 'index.js')
      .map((f) => f.replace(/\.js$/, ''))
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect(AGENT_MESH_REGISTRY[id], `crawler-os agent "${id}" missing from agentMeshRegistry`).toBeTruthy()
    }
  })

  it('registers Amy (who lives outside every other roster)', () => {
    expect(AGENT_MESH_REGISTRY.amy).toBeTruthy()
  })

  it('every entry is complete and keyed by its own id', () => {
    for (const [key, entry] of Object.entries(AGENT_MESH_REGISTRY)) {
      expect(entry.id).toBe(key)
      for (const field of ['name', 'role', 'charter', 'telemetry', 'control']) {
        expect(String(entry[field] || '').length, `${key}.${field} empty`).toBeGreaterThan(0)
      }
      expect(entry.capabilities.length).toBeGreaterThan(0)
      expect(entry.entry_points.length).toBeGreaterThan(0)
      expect(entry.learning_stores.length).toBeGreaterThan(0)
    }
    expect(AGENT_MESH_IDS.length).toBe(Object.keys(AGENT_MESH_REGISTRY).length)
  })

  it('assertMeshAgent is a loud choke point', () => {
    expect(assertMeshAgent('Amy')).toBe('amy')
    expect(() => assertMeshAgent('skynet')).toThrow(/unregistered/)
    expect(isMeshAgent('sam')).toBe(true)
    expect(isMeshAgent('nobody')).toBe(false)
  })
})

// ── Message store ────────────────────────────────────────────────────────────

describe('agent mesh — message store', () => {
  it('posts, reads, and acks a direct message', async () => {
    const db = makeDb()
    const msg = await postMeshMessage(db, { from: 'sam', to: 'amy', kind: 'lesson', body: 'search backend degraded' })
    expect(msg.id).toMatch(/^msg_/)

    const inbox = await readMeshInbox(db, 'amy')
    expect(inbox.map((m) => m.id)).toEqual([msg.id])
    // Not addressed to john:
    expect(await readMeshInbox(db, 'john')).toEqual([])

    expect(await ackMeshMessages(db, 'amy', [msg.id])).toBe(1)
    expect(await readMeshInbox(db, 'amy')).toEqual([])
    // Ack is per-agent and idempotent.
    expect(await ackMeshMessages(db, 'amy', [msg.id])).toBe(0)
  })

  it('broadcast reaches every OTHER agent, never echoes to the sender', async () => {
    const db = makeDb()
    await postMeshMessage(db, { from: 'amy', body: 'cohort finished' })
    expect((await readMeshInbox(db, 'sam')).length).toBe(1)
    expect((await readMeshInbox(db, 'hamilton')).length).toBe(1)
    expect((await readMeshInbox(db, 'amy')).length).toBe(0)
    // consumeMeshInbox acks only for the consuming agent.
    const got = await consumeMeshInbox(db, 'sam')
    expect(got.length).toBe(1)
    expect((await readMeshInbox(db, 'sam')).length).toBe(0)
    expect((await readMeshInbox(db, 'hamilton')).length).toBe(1)
  })

  it('refuses unregistered agents, self-messages, and empty bodies', async () => {
    const db = makeDb()
    await expect(postMeshMessage(db, { from: 'skynet', to: 'amy', body: 'x' })).rejects.toThrow(/unregistered/)
    await expect(postMeshMessage(db, { from: 'amy', to: 'hal9000', body: 'x' })).rejects.toThrow(/unregistered/)
    await expect(postMeshMessage(db, { from: 'amy', to: 'amy', body: 'x' })).rejects.toThrow(/itself/)
    await expect(postMeshMessage(db, { from: 'amy', to: 'sam', body: '   ' })).rejects.toThrow(/required/)
    await expect(readMeshInbox(db, 'nobody')).rejects.toThrow(/unregistered/)
  })

  it('caps the body and bounds the ring (oldest dropped first)', async () => {
    const db = makeDb()
    const long = 'x'.repeat(MESH_BODY_MAX_CHARS + 500)
    const msg = await postMeshMessage(db, { from: 'sam', to: 'amy', body: long })
    expect(msg.body.length).toBeLessThanOrEqual(MESH_BODY_MAX_CHARS)

    for (let i = 0; i < MESH_MESSAGES_MAX + 10; i += 1) {
      await postMeshMessage(db, { from: 'sam', to: 'amy', body: `m${i}` })
    }
    const row = db.prepare('SELECT value FROM system_kv WHERE key = ?').get('agent_mesh_messages')
    const store = JSON.parse(row.value)
    expect(store.messages.length).toBe(MESH_MESSAGES_MAX)
    // The very first (long) message fell off the ring.
    expect(store.messages.some((m) => m.id === msg.id)).toBe(false)
    expect(store.messages[store.messages.length - 1].body).toBe(`m${MESH_MESSAGES_MAX + 9}`)
  })
})

// ── Lesson store ─────────────────────────────────────────────────────────────

describe('agent mesh — lesson store', () => {
  it('records a lesson and dedupes repeats into a refresh (times_seen)', async () => {
    const db = makeDb()
    const first = await recordMeshLesson(db, {
      author: 'sam',
      topic: 'crawler_reliability',
      claim: 'SearXNG collapses multi-word queries',
      evidence: { night: 1 },
      now: new Date('2026-07-27T05:00:00Z'),
    })
    const again = await recordMeshLesson(db, {
      author: 'sam',
      topic: 'crawler_reliability',
      claim: 'searxng collapses MULTI-WORD queries', // same claim, different case
      evidence: { night: 2 },
      now: new Date('2026-07-28T05:00:00Z'),
    })
    expect(again.id).toBe(first.id)
    const lessons = await readMeshLessons(db)
    expect(lessons.length).toBe(1)
    expect(lessons[0].times_seen).toBe(2)
    expect(lessons[0].evidence).toEqual({ night: 2 })
    expect(lessons[0].created_at).toBe('2026-07-27T05:00:00.000Z')
    expect(lessons[0].updated_at).toBe('2026-07-28T05:00:00.000Z')
  })

  it('refuses unknown topics and unregistered authors (closed lists)', async () => {
    const db = makeDb()
    await expect(recordMeshLesson(db, { author: 'sam', topic: 'vibes', claim: 'x' })).rejects.toThrow(/unknown lesson topic/)
    await expect(recordMeshLesson(db, { author: 'skynet', topic: 'coverage_gap', claim: 'x' })).rejects.toThrow(/unregistered/)
    expect(MESH_LESSON_TOPICS).toContain('crawler_reliability')
    expect(MESH_LESSON_TOPICS).toContain('coverage_gap')
  })

  it('filters by topic, author, freshness, and consumption; consumption is one-shot surfacing', async () => {
    const db = makeDb()
    const old = new Date('2026-07-01T00:00:00Z')
    const fresh = new Date('2026-07-28T05:00:00Z')
    const now = new Date('2026-07-28T09:00:00Z')
    await recordMeshLesson(db, { author: 'sam', topic: 'crawler_reliability', claim: 'stale lesson', now: old })
    const l2 = await recordMeshLesson(db, { author: 'sam', topic: 'crawler_reliability', claim: 'fresh lesson', now: fresh })
    await recordMeshLesson(db, { author: 'amy', topic: 'coverage_gap', claim: 'gap lesson', now: fresh })

    expect((await readMeshLessons(db, { topics: ['coverage_gap'] })).map((l) => l.claim)).toEqual(['gap lesson'])
    expect((await readMeshLessons(db, { excludeAuthor: 'amy' })).every((l) => l.author === 'sam')).toBe(true)
    expect((await readMeshLessons(db, { freshWithinHours: 48, now })).map((l) => l.claim).sort()).toEqual(['fresh lesson', 'gap lesson'])

    // notConsumedBy: consumed lessons stop surfacing to that agent only.
    await markMeshLessonConsumed(db, l2.id, 'amy', { now })
    const forAmy = await readMeshLessons(db, { topics: ['crawler_reliability'], notConsumedBy: 'amy' })
    expect(forAmy.map((l) => l.claim)).toEqual(['stale lesson'])
    const forJohn = await readMeshLessons(db, { topics: ['crawler_reliability'], notConsumedBy: 'john' })
    expect(forJohn.length).toBe(2)
  })

  it('an author never consumes/confirms/refutes their own lesson; votes flip', async () => {
    const db = makeDb()
    const lesson = await recordMeshLesson(db, { author: 'sam', topic: 'crawler_reliability', claim: 'brave 402s' })
    await expect(markMeshLessonConsumed(db, lesson.id, 'sam')).rejects.toThrow(/own lesson/)
    await expect(confirmMeshLesson(db, lesson.id, 'sam')).rejects.toThrow(/own lesson/)
    await expect(refuteMeshLesson(db, lesson.id, 'sam')).rejects.toThrow(/own lesson/)

    expect(await confirmMeshLesson(db, lesson.id, 'amy')).toBe(true)
    let [stored] = await readMeshLessons(db)
    expect(stored.confirmations.map((c) => c.agent)).toEqual(['amy'])
    // A refute by the same agent REPLACES their confirmation.
    await refuteMeshLesson(db, lesson.id, 'amy')
    ;[stored] = await readMeshLessons(db)
    expect(stored.confirmations).toEqual([])
    expect(stored.refutations.map((c) => c.agent)).toEqual(['amy'])
  })

  it('bounds the board (oldest-updated dropped first)', async () => {
    const db = makeDb()
    for (let i = 0; i < MESH_LESSONS_MAX + 5; i += 1) {
      await recordMeshLesson(db, {
        author: 'sam',
        topic: 'pipeline_quality',
        claim: `lesson ${i}`,
        now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      })
    }
    const all = await readMeshLessons(db, { limit: MESH_LESSONS_MAX + 50 })
    expect(all.length).toBe(MESH_LESSONS_MAX)
    expect(all.some((l) => l.claim === 'lesson 0')).toBe(false)
    expect(all.some((l) => l.claim === `lesson ${MESH_LESSONS_MAX + 4}`)).toBe(true)
  })
})

// ── Sam wiring ───────────────────────────────────────────────────────────────

describe('Sam ⇄ mesh wiring', () => {
  it('consumeMeshForSam surfaces a fresh peer lesson as a one-shot INFO finding', async () => {
    const db = makeDb()
    await postMeshMessage(db, { from: 'amy', to: 'sam', kind: 'lesson', body: 'gaps persist' })
    const lesson = await recordMeshLesson(db, {
      author: 'amy',
      topic: 'coverage_gap',
      claim: 'Structural coverage gaps persist: cipn; ehlers-danlos',
    })

    const heard = await consumeMeshForSam(db, {})
    expect(heard.inbox.length).toBe(1)
    expect(heard.lessons.map((l) => l.id)).toEqual([lesson.id])
    expect(heard.findings.length).toBe(1)
    expect(heard.findings[0].severity).toBe(SEVERITY.INFO)
    expect(heard.findings[0].title).toContain('Cross-agent lesson from amy')
    expect(heard.findings[0].evidence.mesh_lesson_id).toBe(lesson.id)

    // One-shot: the lesson is stamped consumed and the inbox drained.
    const [stored] = await readMeshLessons(db)
    expect(stored.consumed_by.sam).toBeTruthy()
    const secondPass = await consumeMeshForSam(db, {})
    expect(secondPass.lessons.length).toBe(0)
    expect(secondPass.inbox.length).toBe(0)
  })

  it('teachMeshFromSamFindings teaches crawler_reliability findings to Amy — but never echoes a cross-agent finding', async () => {
    const db = makeDb()
    const real = makeFinding({
      severity: SEVERITY.HIGH,
      category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
      title: 'Web-search backend degraded: SearXNG first-word collapse',
      description: 'Multi-word queries return first-word-only results.',
    })
    const heardEcho = makeFinding({
      severity: SEVERITY.MEDIUM,
      category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
      title: 'Cross-agent lesson from amy: something',
      evidence: { mesh_lesson_id: 'lsn_x' },
    })
    const offTopic = makeFinding({
      severity: SEVERITY.HIGH,
      category: SAM_CATEGORIES.SQL_SAFETY,
      title: 'unrelated',
    })
    const lowSev = makeFinding({
      severity: SEVERITY.INFO,
      category: SAM_CATEGORIES.CRAWLER_RELIABILITY,
      title: 'informational only',
    })

    const taught = await teachMeshFromSamFindings(db, [real, heardEcho, offTopic, lowSev], {})
    expect(taught.length).toBe(1)
    expect(taught[0].claim).toBe(real.title)

    const lessons = await readMeshLessons(db)
    expect(lessons.length).toBe(1)
    expect(lessons[0].author).toBe('sam')
    expect(lessons[0].topic).toBe('crawler_reliability')

    const amyInbox = await readMeshInbox(db, 'amy')
    expect(amyInbox.length).toBe(1)
    expect(amyInbox[0].kind).toBe('lesson')
    expect(amyInbox[0].data.lesson_id).toBe(lessons[0].id)
  })

  it('runSam threads the mesh exchange into summary.agent_mesh (and a mesh failure never fails the run)', async () => {
    const db = makeDb()
    await recordMeshLesson(db, { author: 'amy', topic: 'coverage_gap', claim: 'persistent gap: rare_disease lane' })

    const out = await runSam({ db, persist: false, checkIds: ['__agent_mesh_test_unknown__'] })
    expect(out.ok).toBe(true)
    expect(out.summary.agent_mesh.lessons_heard).toBe(1)
    expect(out.findings.some((f) => f.title.includes('Cross-agent lesson from amy'))).toBe(true)

    // Second run: the lesson was consumed — no wallpaper.
    const out2 = await runSam({ db, persist: false, checkIds: ['__agent_mesh_test_unknown__'] })
    expect(out2.summary.agent_mesh.lessons_heard).toBe(0)
    expect(out2.findings.some((f) => f.title.includes('Cross-agent lesson'))).toBe(false)

    // A broken mesh degrades to a recorded error, never a failed run.
    const boom = {
      consumeInbox: async () => { throw new Error('mesh down') },
      readLessons: async () => [],
      recordLesson: async () => ({}),
      postMessage: async () => ({}),
      markConsumed: async () => true,
    }
    const out3 = await runSam({ db, persist: false, checkIds: ['__agent_mesh_test_unknown__'], mesh: boom })
    expect(out3.ok).toBe(true)
    expect(out3.summary.agent_mesh.error).toContain('mesh down')
  })
})

// ── Amy wiring (the teach → learn loop, end to end) ─────────────────────────

function makeAmyDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '[]',
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_by TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(profile_id, section_key)
    );
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `)
  return db
}

/** Discovery stub: every profile comes back ZERO — the low_results signature. */
function makeZeroDiscovery(db) {
  let i = 0
  return async ({ profileId }) => {
    const row = db.prepare('SELECT primary_type FROM profiles WHERE id = ?').get(profileId)
    i += 1
    return {
      run: {
        run_id: `zero-${i}`,
        stored: 0,
        sources: [{ source_id: 'web', outcome: 'EMPTY', fetched: 0 }],
        recommendations: [],
        zero_result: { zero_result_reason: 'no_sources_matched' },
      },
      persisted: { opportunities: 0, dry_run: true },
      thesis: {
        applicant_types: [row?.primary_type || 'individual'],
        needs: ['funding'],
        location: { state: 'TN', zip: '37203' },
        min_match_score: 8,
      },
    }
  }
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

function amyRunOptions(db) {
  return {
    db,
    categories: [CATEGORY_IDS[0]],
    perCategory: 3,
    dryRunDiscovery: true,
    keepProfiles: true,
    saveReport: false,
    improve: true,
    applyLearning: true,
    gapLearning: false,
    runDiscovery: makeZeroDiscovery(db),
    runPipeline: async () => ({}),
    recordActivity: () => {},
    logger: silentLogger,
    thresholdEditor: {
      read: async () => 8,
      apply: async () => ({ applied: false }),
      restore: async () => true,
    },
  }
}

describe('Amy ⇄ mesh wiring (teach → learn loop)', () => {
  it('WITHOUT a Sam lesson: an all-zero cohort learns low_results AND Amy teaches her gap classes to the board', async () => {
    const db = makeAmyDb()
    const result = await runAmyTraining(amyRunOptions(db))

    expect(result.combined.agent_mesh.search_degraded).toBe(false)
    expect(result.combined.agent_mesh.suppressed_low_results).toEqual([])

    // The cohort's weakness was LEARNED (the pre-mesh behavior is intact).
    const store = await getArchetypeLearning(db)
    const learned = Object.values(store?.archetypes || {})
    expect(learned.some((e) => (e.classes || []).includes('low_results'))).toBe(true)

    // TEACH: Amy's persistent gap classes landed on the shared board…
    const lessons = await readMeshLessons(db, { topics: ['coverage_gap'] })
    expect(lessons.length).toBeGreaterThan(0)
    expect(lessons[0].author).toBe('amy')
    expect(result.combined.agent_mesh.taught.length).toBeGreaterThan(0)

    // …and Sam's inbox holds the message (the awareness half of the loop).
    const samInbox = await readMeshInbox(db, 'sam')
    expect(samInbox.length).toBeGreaterThan(0)
    expect(samInbox[0].from).toBe('amy')
    expect(samInbox[0].kind).toBe('lesson')
  })

  it('WITH a fresh Sam crawler_reliability lesson: low_results is SUPPRESSED, nothing is cleared, and the lesson is stamped consumed', async () => {
    const db = makeAmyDb()
    // A prior legitimate lesson that a degraded night must NOT erase.
    db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      KV_LEARNING_KEY,
      JSON.stringify({ archetypes: { veteran: { classes: ['low_results'], run_id: 'earlier' } } }),
      new Date().toISOString(),
    )
    const samLesson = await recordMeshLesson(db, {
      author: 'sam',
      topic: 'crawler_reliability',
      claim: 'Web-search backend degraded: SearXNG first-word collapse',
    })

    const result = await runAmyTraining(amyRunOptions(db))

    expect(result.combined.agent_mesh.search_degraded).toBe(true)
    expect(result.combined.agent_mesh.lessons_heard.map((l) => l.id)).toContain(samLesson.id)
    expect(result.combined.agent_mesh.suppressed_low_results.length).toBeGreaterThan(0)

    const store = await getArchetypeLearning(db)
    // The outage was NOT learned as an archetype weakness…
    for (const [key, entry] of Object.entries(store?.archetypes || {})) {
      if (key === 'veteran') continue
      expect((entry.classes || []).includes('low_results'), `archetype ${key} learned low_results from an outage`).toBe(false)
    }
    // …and the degraded night cleared NOTHING (prior lesson survives).
    expect(store?.archetypes?.veteran?.classes).toEqual(['low_results'])

    // The teach→learn loop is visibly closed: Sam's lesson is stamped consumed by Amy.
    const [stored] = await readMeshLessons(db, { topics: ['crawler_reliability'] })
    expect(stored.consumed_by.amy).toBeTruthy()
  })
})

// ── Anya's owner-report section ──────────────────────────────────────────────

describe("Anya's 'Agent mesh' report section", () => {
  it('summarizeAgentMesh is honest about consumption and null when silent', async () => {
    expect(summarizeAgentMesh(null)).toBeNull()
    expect(summarizeAgentMesh({ recent_messages: [], fresh_lessons: [] })).toBeNull()

    const db = makeDb()
    const lesson = await recordMeshLesson(db, { author: 'sam', topic: 'crawler_reliability', claim: 'search degraded' })
    await markMeshLessonConsumed(db, lesson.id, 'amy')
    await postMeshMessage(db, { from: 'sam', to: 'amy', kind: 'lesson', body: 'search degraded' })

    const overview = await readMeshOverview(db)
    const summary = summarizeAgentMesh(overview)
    expect(summary.headline).toContain('1 message(s) exchanged')
    expect(summary.headline).toContain('1 consumed by another agent')
    expect(summary.lessons[0]).toContain('[sam · crawler_reliability]')
    expect(summary.lessons[0]).toContain('consumed by amy')
    expect(summary.messages[0]).toBe('sam → amy: search degraded')
  })

  it('buildOwnerReport renders the section in text and HTML when the mesh has traffic', async () => {
    const db = makeDb()
    await recordMeshLesson(db, { author: 'amy', topic: 'coverage_gap', claim: 'gaps persist: cipn' })
    await postMeshMessage(db, { from: 'amy', to: 'sam', kind: 'lesson', body: 'gaps persist: cipn' })
    const agentMesh = await readMeshOverview(db)

    const report = buildOwnerReport({ id: 'run-1', findings: [], health_score: 100 }, { agentMesh })
    expect(report.text).toContain('AGENT MESH')
    expect(report.text).toContain('amy → sam: gaps persist: cipn')
    expect(report.html).toContain('Agent mesh')
    expect(report.html).toContain('gaps persist: cipn')

    // No mesh traffic → no section (never wallpaper).
    const silent = buildOwnerReport({ id: 'run-1', findings: [], health_score: 100 }, { agentMesh: null })
    expect(silent.text).not.toContain('AGENT MESH')
  })

  it('readMeshOverview returns null before the mesh is ever used', async () => {
    const db = makeDb()
    expect(await readMeshOverview(db)).toBeNull()
  })
})
