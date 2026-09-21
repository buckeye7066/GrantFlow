import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { getAppAndDb, resetDb } from './testServer.js'

let app, db
beforeAll(async () => { ({ app, db } = await getAppAndDb()) })
beforeEach(() => {
  resetDb(db)
  db.prepare("INSERT INTO users (id, primary_email, is_admin) VALUES ('profile-switch-user', 'switch@example.com', 0)").run()
  for (const id of ['switch-original', 'switch-selected']) {
    db.prepare("INSERT INTO profiles (id, user_id, display_name, primary_type, status) VALUES (?, 'profile-switch-user', ?, 'individual', 'active')").run(id, id)
  }
  db.prepare("INSERT INTO profiles (id, display_name, primary_type, status) VALUES ('switch-stranger', 'Private', 'individual', 'active')").run()
})

function auth() {
  return { Authorization: `Bearer ${jwt.sign({ sub: 'profile-switch-user', profile_id: 'switch-original', roles: ['user'] }, 'grantflow-dev-secret', { expiresIn: 3600 })}` }
}

describe('Anya conversations after selecting another authorized profile', () => {
  for (const admin of [false, true]) {
    it(`creates and reopens the selected profile conversation (admin=${admin})`, async () => {
      if (admin) db.prepare("UPDATE users SET is_admin = 1 WHERE id = 'profile-switch-user'").run()
      const headers = { ...auth(), 'X-Profile-Id': 'switch-selected' }
      const created = await request(app).post('/api/anya/sessions').set(headers)
        .send({ profile_id: 'switch-selected', title: 'Selected profile acceptance' })
      expect(created.status).toBe(201)
      expect(created.body.profile_id).toBe('switch-selected')
      const opened = await request(app).get(`/api/anya/sessions/${created.body.id}`).set(headers)
      expect(opened.status).toBe(200)
      expect(opened.body.profile_id).toBe('switch-selected')
      const messages = await request(app).get(`/api/anya/sessions/${created.body.id}/messages`).set(headers)
      expect(messages.status).toBe(200)
      expect(messages.body.messages).toEqual([])
      // The previous selection must not read this profile's conversation.
      const other = await request(app).get(`/api/anya/sessions/${created.body.id}`)
        .set({ ...auth(), 'X-Profile-Id': 'switch-original' })
      expect(other.status).toBe(404)
    })
  }

  it('refuses a selected profile outside the DB-backed access set', async () => {
    const result = await request(app).get('/api/anya/sessions')
      .set({ ...auth(), 'X-Profile-Id': 'switch-stranger' })
    expect(result.status).toBe(403)
  })

  it('keeps the authenticated default when no selection header is sent', async () => {
    const result = await request(app).post('/api/anya/sessions').set(auth()).send({ title: 'Default profile' })
    expect(result.status).toBe(201)
    expect(result.body.profile_id).toBe('switch-original')
  })

  it('keeps account recovery available with a stale selected profile', async () => {
    const result = await request(app).get('/api/auth/me')
      .set({ ...auth(), 'X-Profile-Id': 'switch-stranger' })
    expect(result.status).toBe(200)
    expect(result.body.user.id).toBe('profile-switch-user')
  })

  it('does not authenticate a guest through a profile selection', async () => {
    const result = await request(app).get('/api/anya/sessions').set('X-Profile-Id', 'switch-selected')
    expect(result.status).toBe(401)
  })
})
