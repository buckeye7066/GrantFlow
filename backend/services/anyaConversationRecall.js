/**
 * anyaConversationRecall.js — Anya's memory of PAST CONVERSATIONS.
 *
 * Every Anya exchange is already persisted (`anya_sessions` / `anya_messages`),
 * but the chat panel mints a FRESH session every time it opens
 * (`src/components/anya/anyaSession.js`) and the model only ever saw the
 * current session's last 20 messages. So when the owner asked "please give me
 * the script from our last conversation", Anya answered "I can't retrieve
 * past conversations" — false: the script was one row away. (Owner report
 * 2026-09-07.)
 *
 * This module is the ONE read path over prior conversations. Three shapes:
 *   - recent:  the caller's latest sessions with the last user ask and the
 *              last assistant answer, so "last time" is answerable at a glance
 *   - search:  a case-insensitive text search over the caller's messages
 *   - recall:  the messages of one session, bounded, most recent kept fullest
 * plus `buildRecentConversationsBlock`, which the context builder injects so
 * the model knows past conversations EXIST before the user has to insist.
 *
 * SCOPE IS THE CALLER'S. A non-admin sees sessions they opened or sessions on
 * a profile they can access; an admin sees everything (they already can via
 * `listSessions`). Nothing here widens access, it only reads what
 * `anyaOrchestrator.listSessions` would list.
 */

const RECALL_MAX_CHARS = 6000
const EXCERPT_RADIUS = 160

function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

function trunc(text, n) {
  const s = str(text).replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function accessibleIds(user) {
  const set = user?.accessibleProfileIds
  if (set instanceof Set) return [...set].map(String)
  if (Array.isArray(set)) return set.map(String)
  return null
}

/** WHERE clause (on alias `s`) restricting sessions to what the caller may read. */
export function sessionScopeSql(user, alias = 's') {
  if (user?.isAdmin) return { where: '1 = 1', params: [] }
  const userId = user?.userId ?? user?.id ?? null
  const ids = accessibleIds(user) ?? []
  const active = user?.activeProfileId ?? user?.profile_id ?? null
  const profileIds = [...new Set([...ids, ...(active ? [String(active)] : [])])]
  const clauses = []
  const params = []
  if (userId) { clauses.push(`${alias}.user_id = ?`); params.push(String(userId)) }
  if (profileIds.length > 0) {
    clauses.push(`${alias}.profile_id IN (${profileIds.map(() => '?').join(', ')})`)
    params.push(...profileIds)
  }
  if (clauses.length === 0) return { where: '1 = 0', params: [] }
  return { where: `(${clauses.join(' OR ')})`, params }
}

/**
 * The caller's most recent conversations, newest first.
 * @returns {Promise<Array<{session_id, title, profile_id, started_at, updated_at, message_count, last_user_message, last_assistant_message}>>}
 */
export async function listRecentConversations(db, user, { profileId = null, limit = 5, excludeSessionId = null } = {}) {
  if (!db) return []
  const scope = sessionScopeSql(user, 's')
  const max = Math.max(1, Math.min(Number(limit) || 5, 20))
  const extra = []
  const params = [...scope.params]
  if (profileId) { extra.push('s.profile_id = ?'); params.push(String(profileId)) }
  if (excludeSessionId) { extra.push('s.id <> ?'); params.push(String(excludeSessionId)) }
  const rows = await db.prepare(
    `SELECT s.id AS session_id, s.title, s.profile_id, s.created_at AS started_at, s.updated_at,
            (SELECT COUNT(*) FROM anya_messages m WHERE m.session_id = s.id) AS message_count,
            (SELECT m.content FROM anya_messages m WHERE m.session_id = s.id AND m.role = 'user'
               ORDER BY m.created_at DESC LIMIT 1) AS last_user_message,
            (SELECT m.content FROM anya_messages m WHERE m.session_id = s.id AND m.role = 'assistant'
               ORDER BY m.created_at DESC LIMIT 1) AS last_assistant_message
       FROM anya_sessions s
      WHERE ${scope.where}${extra.length ? ` AND ${extra.join(' AND ')}` : ''}
        AND EXISTS (SELECT 1 FROM anya_messages m WHERE m.session_id = s.id)
      ORDER BY s.updated_at DESC
      LIMIT ?`,
  ).all(...params, max)
  return (rows || []).map((r) => ({
    session_id: r.session_id,
    title: r.title ?? null,
    profile_id: r.profile_id ?? null,
    started_at: r.started_at ?? null,
    updated_at: r.updated_at ?? null,
    message_count: Number(r.message_count) || 0,
    last_user_message: trunc(r.last_user_message, 400),
    last_assistant_message: trunc(r.last_assistant_message, 600),
  }))
}

/** Case-insensitive search over the caller's own messages; excerpts around each hit. */
export async function searchConversations(db, user, { query, limit = 8, profileId = null } = {}) {
  const q = str(query).trim()
  if (!db || !q) return []
  const scope = sessionScopeSql(user, 's')
  const max = Math.max(1, Math.min(Number(limit) || 8, 25))
  const params = [...scope.params]
  const extra = []
  if (profileId) { extra.push('s.profile_id = ?'); params.push(String(profileId)) }
  const rows = await db.prepare(
    `SELECT m.session_id, m.role, m.content, m.created_at, s.title, s.profile_id
       FROM anya_messages m
       JOIN anya_sessions s ON s.id = m.session_id
      WHERE ${scope.where}${extra.length ? ` AND ${extra.join(' AND ')}` : ''}
        AND LOWER(m.content) LIKE ?
      ORDER BY m.created_at DESC
      LIMIT ?`,
  ).all(...params, `%${q.toLowerCase()}%`, max)
  return (rows || []).map((r) => {
    const content = str(r.content)
    const at = content.toLowerCase().indexOf(q.toLowerCase())
    const start = Math.max(0, at - EXCERPT_RADIUS)
    const end = Math.min(content.length, at + q.length + EXCERPT_RADIUS)
    return {
      session_id: r.session_id,
      title: r.title ?? null,
      profile_id: r.profile_id ?? null,
      role: r.role,
      created_at: r.created_at ?? null,
      excerpt: `${start > 0 ? '…' : ''}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${end < content.length ? '…' : ''}`,
    }
  })
}

/**
 * One session's messages, oldest first, bounded to `maxChars` with the LATEST
 * messages kept fullest — "the script from our last conversation" is usually
 * the last assistant message, so that one is never the one that gets cut.
 */
export async function recallConversation(db, user, { sessionId, limit = 40, maxChars = RECALL_MAX_CHARS } = {}) {
  const sid = str(sessionId).trim()
  if (!db || !sid) return { ok: false, error: 'session_id_required' }
  const scope = sessionScopeSql(user, 's')
  const session = await db.prepare(
    `SELECT s.id, s.title, s.profile_id, s.created_at, s.updated_at FROM anya_sessions s WHERE s.id = ? AND ${scope.where} LIMIT 1`,
  ).get(sid, ...scope.params)
  if (!session) return { ok: false, error: 'session_not_found_or_not_accessible' }
  const max = Math.max(1, Math.min(Number(limit) || 40, 200))
  const rows = await db.prepare(
    `SELECT m.role, m.content, m.created_at, m.tool_name
       FROM anya_messages m WHERE m.session_id = ? ORDER BY m.created_at DESC LIMIT ?`,
  ).all(sid, max)
  const newestFirst = (rows || []).map((r) => ({ role: r.role, content: str(r.content), created_at: r.created_at ?? null, tool_name: r.tool_name ?? null }))
  // Spend the character budget from the newest message backwards.
  let budget = Math.max(500, Number(maxChars) || RECALL_MAX_CHARS)
  const kept = []
  let truncated = false
  for (const m of newestFirst) {
    if (budget <= 0) { truncated = true; break }
    const take = Math.min(m.content.length, budget)
    kept.push({ ...m, content: take < m.content.length ? `${m.content.slice(0, take)}…` : m.content, truncated: take < m.content.length })
    budget -= take
  }
  return {
    ok: true,
    session: { id: session.id, title: session.title ?? null, profile_id: session.profile_id ?? null, started_at: session.created_at ?? null, updated_at: session.updated_at ?? null },
    messages: kept.reverse(),
    truncated,
  }
}

/** Context block: the caller's last few conversations, so the model knows they exist. */
export async function buildRecentConversationsBlock(db, user, { profileId = null, excludeSessionId = null, limit = 3 } = {}) {
  let recent = []
  try {
    recent = await listRecentConversations(db, user, { profileId, excludeSessionId, limit })
    // A profile-scoped panel with no prior talk about THIS profile still has the
    // user's own history; fall back to it so "last time" is never a blank.
    if (recent.length === 0 && profileId) recent = await listRecentConversations(db, user, { excludeSessionId, limit })
  } catch {
    return null
  }
  if (recent.length === 0) return null
  const lines = ['### Recent conversations with this user (recall any of them in full with conversation.recall using the session id)']
  for (const r of recent) {
    const when = str(r.updated_at || r.started_at).slice(0, 16).replace('T', ' ')
    lines.push(`- ${when} [session ${r.session_id}]${r.title ? ` "${trunc(r.title, 60)}"` : ''}: they asked "${trunc(r.last_user_message, 160)}" — I answered "${trunc(r.last_assistant_message, 200)}"`)
  }
  return lines.join('\n')
}

export default {
  sessionScopeSql,
  listRecentConversations,
  searchConversations,
  recallConversation,
  buildRecentConversationsBlock,
}
