import request from "supertest"
import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from "./testServer.js"

describe("opportunities", () => {
  let app
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
  }, 60_000)

  beforeEach(() => {
    resetDb(db)
  })

  it("lists opportunities with a total that matches storage", async () => {
    const create1 = await request(app).post("/api/opportunities").set(TEST_ADMIN_AUTH_HEADER).send({
      title: "Test Opportunity A",
      sponsor: "Example Foundation",
      source: "test",
      source_id: "a",
      description: "A test opportunity.",
      is_national: true,
      opportunity_type: "grant",
      requires_match: false,
    })
    expect(create1.status).toBe(201)

    const create2 = await request(app).post("/api/opportunities").set(TEST_ADMIN_AUTH_HEADER).send({
      title: "Test Opportunity B",
      sponsor: "Example Foundation",
      source: "test",
      source_id: "b",
      description: "Another test opportunity.",
      is_national: false,
      state: "OH",
      opportunity_type: "grant",
      requires_match: false,
    })
    expect(create2.status).toBe(201)

    const res = await request(app).get("/api/opportunities").query({ limit: 1, offset: 0 })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.limit).toBe(1)
    expect(res.body.offset).toBe(0)
    expect(res.body.total).toBe(2)
    expect(res.body.data.length).toBe(1)

    const first = res.body.data[0]
    expect(first).toHaveProperty("compliance_status")
    expect(first).toHaveProperty("compliance_reasons")
  })
})

