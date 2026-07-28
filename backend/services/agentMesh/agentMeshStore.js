/**
 * agentMeshStore.js — the agents' shared MESSAGE inbox and LESSON board.
 *
 * COMMUNICATION + LEARNING/TEACHING (owner directive 2026-07-28): the fleet's
 * agents already write plenty of telemetry, but none of it is ADDRESSED — a
 * finding Sam proves at 05:00 has no way to reach Amy's 04:00 run tomorrow
 * except through the owner's inbox. This module gives the fleet two bounded,
 * persistent, system_kv-backed stores (dialect-agnostic, mirrors
 * amy/archetypeLearning.js persistence):
 *
 *   agent_mesh_messages — append / read-inbox / ack. A message is
 *     {id, from, to|'broadcast', kind, body, data?, created_at, ack:{agent:at}}.
 *     Ring-bounded (MESH_MESSAGES_MAX) so the store can never grow unbounded.
 *
 *   agent_mesh_lessons — the shared lesson board. A lesson is
 *     {id, author, topic, claim, evidence?, created_at, updated_at, times_seen,
 *      confirmations:[{agent,at}], refutations:[{agent,at}], consumed_by:{agent:at}}.
 *     Re-recording the same (author, topic, claim) REFRESHES the lesson
 *     (times_seen++, evidence replaced) instead of appending a duplicate, so a
 *     nightly repeat is a strengthening signal, not spam. Ring-bounded
 *     (MESH_LESSONS_MAX, oldest-updated dropped first).
 *
 * Rules of the mesh:
 *   - IDENTITY: every from/to/author/consumer id passes assertMeshAgent — an
 *     unregistered agent is refused loudly (agentMeshRegistry is the choke
 *     point; the totality test keeps the registry honest).
 *   - TOPICS are a closed list (MESH_LESSON_TOPICS) — extend deliberately,
 *     like SAM_CATEGORIES. A free-text topic vocabulary would make consumers
 *     impossible to write (the needsTaxonomy-vs-NEED_ALIAS_MAP lesson).
 *   - A lesson's author never confirms/refutes their own lesson — evidence of
 *     the teach-each-other loop must come from ANOTHER agent.
 *   - BEST-EFFORT AT THE CALL SITE: agents wrap mesh calls in try/catch; a
 *     mesh failure must never fail a run. The store itself throws on invalid
 *     input (loud refusal beats silent drop).
 *   - NO user PII in bodies/claims (bodies are owner-report-visible); bodies
 *     and claims are length-capped.
 *
 * Consumers: amyAgent (consume at run start, teach at run end), samAgent
 * (same), anyaDailyOwnerReport ("Agent mesh" section via readMeshOverview).
 */

import crypto from 'node:crypto'
import { assertMeshAgent, MESH_BROADCAST } from './agentMeshRegistry.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('services:agentMesh:store')

/** system_kv key: the bounded inter-agent message ring. */
export const MESH_MESSAGES_KV_KEY = 'agent_mesh_messages'

/** system_kv key: the bounded shared lesson board. */
export const MESH_LESSONS_KV_KEY = 'agent_mesh_lessons'

/** Retention bounds (rings — oldest dropped first, never unbounded growth). */
export const MESH_MESSAGES_MAX = 200
export const MESH_LESSONS_MAX = 100

/** Body/claim caps: mesh entries are summaries with evidence pointers, never dumps. */
export const MESH_BODY_MAX_CHARS = 2000

/**
 * The ONLY lesson topics the board accepts (closed list — extend deliberately).
 * Each topic names a domain at least one consumer understands.
 */
export const MESH_LESSON_TOPICS = Object.freeze([
  'crawler_reliability', // Sam→Amy: a discovery dependency (search backend, source host) is degraded
  'coverage_gap', // Amy→Sam: gap classes the flywheel proved persistent / structural
  'amount_coverage', // amount-answer census signals
  'pipeline_quality', // pipeline hygiene signals
  'lead_quality', // Yana/John lead + draft plausibility signals
  'application_flow', // Hamilton task-flow signals
])

// ── system_kv plumbing (dialect-agnostic; mirrors archetypeLearning.js) ─────

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

async function kvGet(db, key) {
  if (!db?.prepare) return null
  await ensureKv(db)
  const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(key)
  if (!row?.value) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

async function kvSet(db, key, obj, at) {
  await ensureKv(db)
  const json = JSON.stringify(obj)
  const ts = at || new Date().toISOString()
  await db.prepare(`
    INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, json, ts)
}

function nowIso(now) {
  return (now instanceof Date ? now : new Date()).toISOString()
}

function capText(value, field) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`agentMesh: ${field} is required`)
  return text.length > MESH_BODY_MAX_CHARS ? `${text.slice(0, MESH_BODY_MAX_CHARS - 1)}…` : text
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`
}

// ── Messages ─────────────────────────────────────────────────────────────────

async function loadMessages(db) {
  const store = await kvGet(db, MESH_MESSAGES_KV_KEY)
  const messages = Array.isArray(store?.messages) ? store.messages : []
  return { messages }
}

/**
 * Append one message. `to` is a registered agent id or 'broadcast'.
 * Returns the stored message.
 */
export async function postMeshMessage(db, { from, to = MESH_BROADCAST, kind = 'note', body, data = null, now = null } = {}) {
  const fromId = assertMeshAgent(from, 'from')
  const toId = String(to || MESH_BROADCAST).toLowerCase() === MESH_BROADCAST
    ? MESH_BROADCAST
    : assertMeshAgent(to, 'to')
  if (toId === fromId) throw new Error('agentMesh: an agent cannot message itself')
  const at = nowIso(now)
  const message = {
    id: newId('msg'),
    from: fromId,
    to: toId,
    kind: String(kind || 'note').toLowerCase(),
    body: capText(body, 'message body'),
    data: data && typeof data === 'object' ? data : null,
    created_at: at,
    ack: {},
  }
  const { messages } = await loadMessages(db)
  messages.push(message)
  // Ring bound: drop oldest beyond the cap.
  const bounded = messages.length > MESH_MESSAGES_MAX ? messages.slice(messages.length - MESH_MESSAGES_MAX) : messages
  await kvSet(db, MESH_MESSAGES_KV_KEY, { messages: bounded }, at)
  return message
}

/**
 * The agent's inbox: messages addressed to it (or broadcast by someone else),
 * unread-only by default (read = the agent has acked it).
 */
export async function readMeshInbox(db, agentId, { unreadOnly = true, limit = 50 } = {}) {
  const me = assertMeshAgent(agentId, 'agent')
  const { messages } = await loadMessages(db)
  const mine = messages.filter((m) => {
    if (m.from === me) return false
    if (m.to !== me && m.to !== MESH_BROADCAST) return false
    if (unreadOnly && m.ack && m.ack[me]) return false
    return true
  })
  return mine.slice(-Math.max(1, limit))
}

/** Ack (mark read) a set of message ids for one agent. Returns acked count. */
export async function ackMeshMessages(db, agentId, ids, { now = null } = {}) {
  const me = assertMeshAgent(agentId, 'agent')
  const idSet = new Set(Array.isArray(ids) ? ids : [ids])
  if (idSet.size === 0) return 0
  const at = nowIso(now)
  const { messages } = await loadMessages(db)
  let acked = 0
  for (const m of messages) {
    if (idSet.has(m.id) && !(m.ack && m.ack[me])) {
      m.ack = { ...(m.ack || {}), [me]: at }
      acked += 1
    }
  }
  if (acked > 0) await kvSet(db, MESH_MESSAGES_KV_KEY, { messages }, at)
  return acked
}

/** Run-loop convenience: read the unread inbox and ack it in one step. */
export async function consumeMeshInbox(db, agentId, { limit = 50, now = null } = {}) {
  const inbox = await readMeshInbox(db, agentId, { unreadOnly: true, limit })
  if (inbox.length > 0) await ackMeshMessages(db, agentId, inbox.map((m) => m.id), { now })
  return inbox
}

// ── Lessons ──────────────────────────────────────────────────────────────────

async function loadLessons(db) {
  const store = await kvGet(db, MESH_LESSONS_KV_KEY)
  const lessons = Array.isArray(store?.lessons) ? store.lessons : []
  return { lessons }
}

function lessonKey(author, topic, claim) {
  return `${author} ${topic} ${String(claim).trim().toLowerCase()}`
}

/**
 * Record (or refresh) a lesson. Dedupe identity is (author, topic, claim):
 * a repeat refreshes updated_at / evidence and increments times_seen.
 */
export async function recordMeshLesson(db, { author, topic, claim, evidence = null, now = null } = {}) {
  const authorId = assertMeshAgent(author, 'author')
  const topicKey = String(topic || '').toLowerCase()
  if (!MESH_LESSON_TOPICS.includes(topicKey)) {
    throw new Error(`agentMesh: unknown lesson topic "${topic}" — extend MESH_LESSON_TOPICS deliberately`)
  }
  const claimText = capText(claim, 'lesson claim')
  const at = nowIso(now)
  const { lessons } = await loadLessons(db)
  const key = lessonKey(authorId, topicKey, claimText)
  const existing = lessons.find((l) => lessonKey(l.author, l.topic, l.claim) === key)
  let lesson
  if (existing) {
    existing.updated_at = at
    existing.times_seen = (Number(existing.times_seen) || 1) + 1
    if (evidence && typeof evidence === 'object') existing.evidence = evidence
    lesson = existing
  } else {
    lesson = {
      id: newId('lsn'),
      author: authorId,
      topic: topicKey,
      claim: claimText,
      evidence: evidence && typeof evidence === 'object' ? evidence : null,
      created_at: at,
      updated_at: at,
      times_seen: 1,
      confirmations: [],
      refutations: [],
      consumed_by: {},
    }
    lessons.push(lesson)
  }
  // Ring bound: keep the most recently UPDATED lessons.
  let bounded = lessons
  if (lessons.length > MESH_LESSONS_MAX) {
    bounded = [...lessons]
      .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
      .slice(lessons.length - MESH_LESSONS_MAX)
  }
  await kvSet(db, MESH_LESSONS_KV_KEY, { lessons: bounded }, at)
  return lesson
}

/**
 * Read lessons for a consumer. Filters: topics[], excludeAuthor,
 * freshWithinHours (by updated_at), notConsumedBy (one-shot surfacing).
 * Newest-updated first.
 */
export async function readMeshLessons(db, {
  topics = null,
  excludeAuthor = null,
  freshWithinHours = null,
  notConsumedBy = null,
  limit = 20,
  now = null,
} = {}) {
  const { lessons } = await loadLessons(db)
  const topicSet = Array.isArray(topics) && topics.length > 0 ? new Set(topics.map((t) => String(t).toLowerCase())) : null
  const exclude = excludeAuthor ? String(excludeAuthor).toLowerCase() : null
  const notConsumer = notConsumedBy ? assertMeshAgent(notConsumedBy, 'notConsumedBy') : null
  // Strict finite check: Number(null) is 0 (finite!), which would silently
  // turn "no freshness filter" into "nothing is ever fresh".
  const cutoffMs = Number.isFinite(freshWithinHours)
    ? (now instanceof Date ? now.getTime() : Date.now()) - freshWithinHours * 3600_000
    : null
  return lessons
    .filter((l) => {
      if (topicSet && !topicSet.has(l.topic)) return false
      if (exclude && l.author === exclude) return false
      if (cutoffMs !== null && Date.parse(l.updated_at) < cutoffMs) return false
      if (notConsumer && l.consumed_by && l.consumed_by[notConsumer]) return false
      return true
    })
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, Math.max(1, limit))
}

/**
 * Stamp that a consumer actually FOLDED the lesson into its run (the
 * teach-each-other bar: taught means visibly consumed by another agent).
 * The author cannot mark their own lesson consumed.
 */
export async function markMeshLessonConsumed(db, lessonId, agentId, { now = null } = {}) {
  const me = assertMeshAgent(agentId, 'consumer')
  const at = nowIso(now)
  const { lessons } = await loadLessons(db)
  const lesson = lessons.find((l) => l.id === lessonId)
  if (!lesson) return false
  if (lesson.author === me) throw new Error('agentMesh: an author cannot consume their own lesson')
  lesson.consumed_by = { ...(lesson.consumed_by || {}), [me]: at }
  await kvSet(db, MESH_LESSONS_KV_KEY, { lessons }, at)
  return true
}

function stampVerdict(list, agentId, at) {
  const next = (Array.isArray(list) ? list : []).filter((c) => c.agent !== agentId)
  next.push({ agent: agentId, at })
  return next
}

/** Another agent's evidence AGREES with the lesson. Author self-votes refused. */
export async function confirmMeshLesson(db, lessonId, agentId, { now = null } = {}) {
  return voteMeshLesson(db, lessonId, agentId, 'confirmations', now)
}

/** Another agent's evidence CONTRADICTS the lesson. Author self-votes refused. */
export async function refuteMeshLesson(db, lessonId, agentId, { now = null } = {}) {
  return voteMeshLesson(db, lessonId, agentId, 'refutations', now)
}

async function voteMeshLesson(db, lessonId, agentId, field, now) {
  const me = assertMeshAgent(agentId, 'agent')
  const at = nowIso(now)
  const { lessons } = await loadLessons(db)
  const lesson = lessons.find((l) => l.id === lessonId)
  if (!lesson) return false
  if (lesson.author === me) throw new Error(`agentMesh: an author cannot ${field === 'confirmations' ? 'confirm' : 'refute'} their own lesson`)
  lesson[field] = stampVerdict(lesson[field], me, at)
  // A vote either way removes the opposite stamp from the same agent.
  const other = field === 'confirmations' ? 'refutations' : 'confirmations'
  lesson[other] = (Array.isArray(lesson[other]) ? lesson[other] : []).filter((c) => c.agent !== me)
  await kvSet(db, MESH_LESSONS_KV_KEY, { lessons }, at)
  return true
}

// ── Owner-report overview ────────────────────────────────────────────────────

/**
 * Compact overview for Anya's daily owner report: messages exchanged in the
 * window, fresh lessons (with who consumed/confirmed them). Best-effort shape;
 * returns null when the mesh has never been used.
 */
export async function readMeshOverview(db, { now = null, messageWindowHours = 24, lessonWindowHours = 7 * 24 } = {}) {
  try {
    const nowMs = now instanceof Date ? now.getTime() : Date.now()
    const { messages } = await loadMessages(db)
    const { lessons } = await loadLessons(db)
    if (messages.length === 0 && lessons.length === 0) return null
    const msgCutoff = nowMs - messageWindowHours * 3600_000
    const lsnCutoff = nowMs - lessonWindowHours * 3600_000
    const recentMessages = messages.filter((m) => Date.parse(m.created_at) >= msgCutoff)
    const freshLessons = lessons
      .filter((l) => Date.parse(l.updated_at) >= lsnCutoff)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    return {
      generated_at: nowIso(now),
      messages_total: messages.length,
      lessons_total: lessons.length,
      recent_messages: recentMessages.slice(-20),
      fresh_lessons: freshLessons.slice(0, 20),
    }
  } catch (err) {
    log.warn('readMeshOverview failed', { error: err?.message })
    return null
  }
}
