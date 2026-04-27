import request from "supertest"
import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from "./testServer.js"

describe("profile section AI fallback", () => {
  let app
  let db

  beforeAll(async () => {
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
  }, 120_000)

  beforeEach(() => {
    resetDb(db)
  })

  it("does not 500 when no AI provider is available", async () => {
    const profileId = "00000000-0000-0000-0000-00000000a500"
    db.prepare(`
      INSERT INTO profiles (id, display_name, primary_type, status, tags)
      VALUES (?, 'AI Fallback Profile', 'high_school_student', 'active', '[]')
    `).run(profileId)

    const res = await request(app)
      .post(`/api/profiles/${profileId}/sections/basic_information/ai`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      section_key: "basic_information",
      suggestion: {},
      rejected: [],
      ai_provider: "fallback",
    })
  })
})
