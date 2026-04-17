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
    // NOTE: titles must not match the placeholder pattern in
    // filterActionableOpportunities (/^(test|sample|example|...)/i) and must
    // supply an application_url, otherwise the response layer strips them.
    const create1 = await request(app).post("/api/opportunities").set(TEST_ADMIN_AUTH_HEADER).send({
      title: "Community Emergency Assistance Grant A",
      sponsor: "Example Foundation",
      source: "test",
      source_id: "a",
      description: "A real-looking opportunity used by the opportunities API integration test.",
      application_url: "https://example.org/apply-a",
      source_url: "https://example.org/program-a",
      is_national: true,
      opportunity_type: "grant",
      requires_match: false,
    })
    expect(create1.status).toBe(201)

    const create2 = await request(app).post("/api/opportunities").set(TEST_ADMIN_AUTH_HEADER).send({
      title: "Community Emergency Assistance Grant B",
      sponsor: "Example Foundation",
      source: "test",
      source_id: "b",
      description: "A second real-looking opportunity used by the opportunities API integration test.",
      application_url: "https://example.org/apply-b",
      source_url: "https://example.org/program-b",
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

