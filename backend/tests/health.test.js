import request from "supertest"
import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { getAppAndDb, resetDb } from "./testServer.js"

describe("health", () => {
  let app
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
  })

  beforeEach(() => {
    resetDb(db)
  })

  it("GET /api/health returns ok payload", async () => {
    const res = await request(app).get("/api/health")
    expect(res.status).toBe(200)
    expect(typeof res.body.status).toBe("string")
    expect(typeof res.body.timestamp).toBe("string")
  })
})

