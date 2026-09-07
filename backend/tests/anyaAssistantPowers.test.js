/**
 * Anya's assistant powers (owner order 2026-09-07).
 *
 * The owner's transcript: "please give me the script from our last
 * conversation" → "I can't retrieve past conversations"; "I cannot see
 * <a profile> in My Profiles even though I am admin ... fix it" → "this would
 * require adjustments to the admin interface". Every exchange was stored and
 * the restore route existed. These tests pin the three closures:
 *   1. past conversations are readable — scoped to the caller;
 *   2. an admin can list / restore / reactivate / suspend / ban / unban from chat;
 *   3. the profile list can show active / suspended / deleted / banned buckets;
 * plus the prompt contract (memory, scope, admin lifecycle) the model reads.
 */
import request from 'supertest'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getAppAndDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'
import {
  listRecentConversations, searchConversations, recallConversation, buildRecentConversationsBlock,
} from '../services/anyaConversationRecall.js'
import {
  listProfilesByStatus, restoreDeletedProfile, parseStatusFilter, statusFilterSql,
} from '../services/profileLifecycle.js'
import { invokeTool, listToolMetadata } from '../services/anyaToolRegistry.js'
import { CHAT_TOOL_WHITELIST, buildAnyaSystemPrompt } from '../services/anyaOrchestrator.js'

const USER_A = { userId: 'user-a', id: 'user-a', isAdmin: false, accessibleProfileIds: new Set(['prof-a']), activeProfileId: 'prof-a' }
const USER_B = { userId: 'user-b', id: 'user-b', isAdmin: false, accessibleProfileIds: new Set(['prof-b']), activeProfileId: 'prof-b' }
const ADMIN = { userId: 'admin-1', id: 'admin-1', isAdmin: true, email: 'admin@example.com' }

describe('Anya assistant powers', () => {
  let app
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
  }, 60_000)

  beforeEach(() => {
    for (const sql of [
      'DELETE FROM anya_messages', 'DELETE FROM anya_sessions', 'DELETE FROM owner_blocklist',
      "DELETE FROM profiles WHERE id LIKE 'prof-%' OR id LIKE 'life-%'", "DELETE FROM users WHERE id IN ('user-a','user-b','admin-1','user-banned')",
    ]) { try { db.prepare(sql).run() } catch { /* table variance */ } }
    for (const [id, email] of [['user-a', 'a@example.com'], ['user-b', 'b@example.com'], ['admin-1', 'admin@example.com'], ['user-banned', 'banned@example.com']]) {
      try { db.prepare('INSERT INTO users (id, primary_email) VALUES (?, ?)').run(id, email) } catch { /* schema variance */ }
    }
    for (const [id, name, status, userId] of [
      ['prof-a', 'Profile A', 'active', 'user-a'], ['prof-b', 'Profile B', 'active', 'user-b'],
      ['life-active', 'Lively Person', 'active', null], ['life-suspended', 'Paused Person', 'suspended', null],
      ['life-deleted', 'Gone Person', 'deleted', null], ['life-banned', 'Blocked Person', 'suspended', 'user-banned'],
    ]) {
      db.prepare("INSERT INTO profiles (id, display_name, primary_type, status, user_id) VALUES (?, ?, 'individual', ?, ?)").run(id, name, status, userId)
    }
  })

  function seedSession(id, userId, profileId, turns) {
    db.prepare('INSERT INTO anya_sessions (id, user_id, profile_id, title, status) VALUES (?, ?, ?, ?, ?)').run(id, userId, profileId, `Session ${id}`, 'open')
    let t = 0
    for (const [role, content] of turns) {
      t += 1
      db.prepare("INSERT INTO anya_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))")
        .run(`${id}-m${t}`, id, role, content, `+${t} seconds`)
    }
  }

  describe('past conversations', () => {
    it('recent / search / recall read the caller\'s own stored conversations, and a stranger cannot', async () => {
      seedSession('s-a1', 'user-a', 'prof-a', [['user', 'write me a script to email the food bank'], ['assistant', 'Here is the script: SCRIPT-ALPHA line one. line two.']])
      seedSession('s-a2', 'user-a', 'prof-a', [['user', 'thanks'], ['assistant', 'Any time.']])
      seedSession('s-b1', 'user-b', 'prof-b', [['user', 'my secret question'], ['assistant', 'my secret answer']])

      const recent = await listRecentConversations(db, USER_A, { limit: 5 })
      expect(recent.map((r) => r.session_id).sort()).toEqual(['s-a1', 's-a2'])
      expect(recent.find((r) => r.session_id === 's-a1').last_assistant_message).toMatch(/SCRIPT-ALPHA/)

      const hits = await searchConversations(db, USER_A, { query: 'script' })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.every((h) => h.session_id.startsWith('s-a'))).toBe(true)
      expect(await searchConversations(db, USER_A, { query: 'secret' })).toEqual([])

      const recalled = await recallConversation(db, USER_A, { sessionId: 's-a1' })
      expect(recalled.ok).toBe(true)
      expect(recalled.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(recalled.messages[1].content).toMatch(/SCRIPT-ALPHA line one/)

      const denied = await recallConversation(db, USER_A, { sessionId: 's-b1' })
      expect(denied.ok).toBe(false)
      const adminSees = await recallConversation(db, ADMIN, { sessionId: 's-b1' })
      expect(adminSees.ok).toBe(true)

      const block = await buildRecentConversationsBlock(db, USER_A, { profileId: 'prof-a', excludeSessionId: 's-a2' })
      expect(block).toMatch(/Recent conversations/)
      expect(block).toMatch(/s-a1/)
      expect(block).not.toMatch(/s-a2/)
      expect(block).not.toMatch(/secret/)
    })

    it('recall keeps the NEWEST message fullest when the budget is tight', async () => {
      seedSession('s-long', 'user-a', 'prof-a', [['user', 'x'.repeat(3000)], ['assistant', 'THE-SCRIPT ' + 'y'.repeat(400)]])
      const r = await recallConversation(db, USER_A, { sessionId: 's-long', maxChars: 600 })
      expect(r.ok).toBe(true)
      const last = r.messages[r.messages.length - 1]
      expect(last.role).toBe('assistant')
      expect(last.content).toMatch(/^THE-SCRIPT/)
      expect(last.truncated).toBe(false)
      expect(r.messages[0].truncated).toBe(true)
    })

    it('the chat tools are whitelisted and scoped: a user can recall, only the owner of the session', async () => {
      seedSession('s-tool', 'user-a', 'prof-a', [['user', 'hello'], ['assistant', 'the LIST: 1, 2, 3']])
      for (const name of ['conversation.recent', 'conversation.search', 'conversation.recall', 'profile.runDiscovery', 'admin.profile.listByStatus', 'admin.profile.restore', 'admin.profile.setStatus']) {
        expect(CHAT_TOOL_WHITELIST, name).toContain(name)
      }
      const res = (await invokeTool('conversation.search', { query: 'LIST' }, { db, ctx: USER_A, user: USER_A })).output
      expect(res.count).toBe(1)
      const none = (await invokeTool('conversation.search', { query: 'LIST' }, { db, ctx: USER_B, user: USER_B })).output
      expect(none.count).toBe(0)
    })
  })

  describe('profile lifecycle', () => {
    beforeEach(() => {
      db.prepare("INSERT INTO owner_blocklist (id, match_type, match_value, enforcement) VALUES ('bl-1', 'email', 'banned@example.com', 'block')").run()
    })

    it('listProfilesByStatus buckets active / suspended / deleted / banned and counts them', async () => {
      const all = await listProfilesByStatus(db, {})
      const byId = Object.fromEntries(all.profiles.map((p) => [p.id, p.lifecycle]))
      expect(byId['life-active']).toBe('active')
      expect(byId['life-suspended']).toBe('suspended')
      expect(byId['life-deleted']).toBe('deleted')
      expect(byId['life-banned']).toBe('banned')
      expect(all.counts.deleted).toBeGreaterThanOrEqual(1)
      expect(all.counts.banned).toBe(1)
      const onlyDeleted = await listProfilesByStatus(db, { statuses: ['deleted'] })
      expect(onlyDeleted.profiles.map((p) => p.id)).toEqual(['life-deleted'])
      const named = await listProfilesByStatus(db, { statuses: ['active', 'suspended'], query: 'person' })
      expect(named.profiles.map((p) => p.id).sort()).toEqual(['life-active', 'life-suspended'])
    })

    it('parseStatusFilter drops junk; statusFilterSql defaults to active only', () => {
      expect(parseStatusFilter('deleted, BANNED, nonsense,active')).toEqual(['deleted', 'banned', 'active'])
      expect(statusFilterSql([])).toMatch(/status IS NULL OR p\.status = 'active'/)
      expect(statusFilterSql(['deleted'])).not.toMatch(/'active'/)
    })

    it('GET /api/profiles?status=… returns only the requested buckets (admin)', async () => {
      const deleted = await request(app).get('/api/profiles?status=deleted').set(TEST_ADMIN_AUTH_HEADER)
      expect(deleted.status).toBe(200)
      const ids = deleted.body.map((p) => p.id)
      expect(ids).toContain('life-deleted')
      expect(ids).not.toContain('life-active')
      expect(ids).not.toContain('life-suspended')
      const dflt = await request(app).get('/api/profiles').set(TEST_ADMIN_AUTH_HEADER)
      const dIds = dflt.body.map((p) => p.id)
      expect(dIds).toContain('life-active')
      expect(dIds).not.toContain('life-deleted')
      expect(dIds).not.toContain('life-suspended')
      expect(dIds).not.toContain('life-banned')
      const banned = await request(app).get('/api/profiles?status=banned,suspended').set(TEST_ADMIN_AUTH_HEADER)
      const bIds = banned.body.map((p) => p.id).sort()
      expect(bIds).toEqual(['life-banned', 'life-suspended'])
      const legacy = await request(app).get('/api/profiles?includeDeleted=true').set(TEST_ADMIN_AUTH_HEADER)
      expect(legacy.body.map((p) => p.id)).toEqual(expect.arrayContaining(['life-active', 'life-deleted']))
    })

    it('restoreDeletedProfile restores exactly a deleted profile and is idempotent', async () => {
      const r1 = await restoreDeletedProfile(db, { profileId: 'life-deleted', actor: 'admin-1' })
      expect(r1).toMatchObject({ ok: true, changed: true, status_before: 'deleted', status_after: 'active' })
      expect(db.prepare('SELECT status FROM profiles WHERE id = ?').get('life-deleted').status).toBe('active')
      const r2 = await restoreDeletedProfile(db, { profileId: 'life-deleted' })
      expect(r2).toMatchObject({ ok: true, changed: false })
      const r3 = await restoreDeletedProfile(db, { profileId: 'life-suspended' })
      expect(r3).toMatchObject({ ok: true, changed: false })
      expect(db.prepare('SELECT status FROM profiles WHERE id = ?').get('life-suspended').status).toBe('suspended')
    })

    it('admin tools: gated to admins, confirmation-gated, and they actually change status', async () => {
      await expect(invokeTool('admin.profile.restore', { profileId: 'life-deleted', confirmed: true }, { db, ctx: USER_A, user: USER_A }))
        .rejects.toThrow()
      const preview = (await invokeTool('admin.profile.restore', { profileId: 'life-deleted' }, { db, ctx: ADMIN, user: ADMIN })).output
      expect(preview.confirmation_required).toBe(true)
      expect(db.prepare('SELECT status FROM profiles WHERE id = ?').get('life-deleted').status).toBe('deleted')
      const done = (await invokeTool('admin.profile.restore', { profileId: 'life-deleted', confirmed: true }, { db, ctx: ADMIN, user: ADMIN })).output
      expect(done).toMatchObject({ ok: true, changed: true })
      expect(db.prepare('SELECT status FROM profiles WHERE id = ?').get('life-deleted').status).toBe('active')

      const list = (await invokeTool('admin.profile.listByStatus', { statuses: ['suspended'] }, { db, ctx: ADMIN, user: ADMIN })).output
      expect(list.profiles.map((p) => p.id).sort()).toEqual(['life-suspended']) // banned profiles live in their own bucket

      const re = (await invokeTool('admin.profile.setStatus', { profileId: 'life-suspended', action: 'reactivate', confirmed: true }, { db, ctx: ADMIN, user: ADMIN })).output
      expect(re.ok).toBe(true)
      expect(db.prepare('SELECT status FROM profiles WHERE id = ?').get('life-suspended').status).toBe('active')
      const sus = (await invokeTool('admin.profile.setStatus', { profileId: 'life-active', action: 'suspend', confirmed: true }, { db, ctx: ADMIN, user: ADMIN })).output
      expect(sus.ok).toBe(true)
      expect(db.prepare('SELECT status FROM profiles WHERE id = ?').get('life-active').status).toBe('suspended')
      expect(listToolMetadata(USER_A).map((t) => t.name)).not.toContain('admin.profile.setStatus')
    })

    it('profile.runDiscovery is access-scoped and confirmation-gated', async () => {
      await expect(invokeTool('profile.runDiscovery', { profileId: 'prof-b', confirmed: true }, { db, ctx: USER_A, user: USER_A })).rejects.toThrow(/Not authorized/)
      const preview = (await invokeTool('profile.runDiscovery', { profileId: 'prof-a' }, { db, ctx: USER_A, user: USER_A })).output
      expect(preview.confirmation_required).toBe(true)
    })
  })

  describe('prompt contract', () => {
    it('the user prompt carries the memory rule, the profile-action tools, and the scope rule; the admin prompt carries lifecycle', () => {
      const user = buildAnyaSystemPrompt(false, ['conversation.recent', 'conversation.recall', 'profile.runDiscovery', 'profile.find'])
      expect(user).toMatch(/NEVER say you cannot retrieve past conversations/)
      expect(user).toMatch(/profile\.runDiscovery/)
      expect(user).toMatch(/SCOPE \(owner rule/)
      expect(user).toMatch(/locked for their plan tier/)
      expect(user).not.toMatch(/cross-session memory run through GrantFlow/)
      const admin = buildAnyaSystemPrompt(true, ['admin.profile.restore', 'admin.profile.listByStatus'])
      expect(admin).toMatch(/Profile lifecycle — you CAN do this directly/)
      expect(admin).toMatch(/admin\.profile\.restore/)
      expect(admin).toMatch(/checkboxes for Active \/ Suspended \/ Deleted \/ Banned/)
    })
  })
})
