/**
 * An unrecognised filter is worse than a rejected one.
 *
 * `GET /api/opportunities` is served WITHOUT authentication, and it destructures
 * `search`. Express silently drops every query param a handler does not name, so
 * a caller that sent the most obvious spelling — `q` — received a 200, a
 * plausible payload, and the entire corpus, with nothing in the response to say
 * the filter had never run. Measured against production on 2026-09-01:
 * `?q=scholarship` → total 10,587; `?search=scholarship` → total 889.
 *
 * These tests pin the two halves of the fix: `q` and `query` now mean `search`,
 * and every response says what was actually searched.
 */

import request from "supertest"
import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from "./testServer.js"

// Issue #1501: the admin API creates fail-closed (hidden) direct rows until link
// proof exists, so the fixture asserts the proof it is entitled to assert.
const VERIFIED_PROOF = () => ({
  link_status: "ok",
  last_verified_at: new Date().toISOString(),
  verification_method: "head",
  verified_by: "search-alias-integration-test",
})

describe("the public opportunity search cannot silently do nothing", () => {
  let app
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
  }, 60_000)

  beforeEach(async () => {
    resetDb(db)
    const make = (id, title, host) => request(app)
      .post("/api/opportunities")
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({
        title,
        sponsor: "Example Foundation",
        source: "test",
        source_id: id,
        description: "A real-looking opportunity used by the public search integration test.",
        application_url: `https://${host}/apply`,
        source_url: `https://${host}/program`,
        ...VERIFIED_PROOF(),
        is_national: true,
        opportunity_type: "grant",
        requires_match: false,
      })
    expect((await make("s1", "Regional Transfer Scholarship Fund", "scholarship-fund.org")).status).toBe(201)
    expect((await make("g1", "Rural Water Infrastructure Grant", "water-grant.org")).status).toBe(201)
  })

  it("filters on `q` exactly as it filters on `search`", async () => {
    const bySearch = await request(app).get("/api/opportunities?search=Scholarship")
    const byQ = await request(app).get("/api/opportunities?q=Scholarship")
    expect(bySearch.status).toBe(200)
    expect(byQ.status).toBe(200)
    expect(byQ.body.total).toBe(bySearch.body.total)
    expect(byQ.body.data.map((r) => r.title)).toEqual(bySearch.body.data.map((r) => r.title))
  })

  it("does NOT hand back the whole corpus when the caller spells it `q`", async () => {
    const all = await request(app).get("/api/opportunities")
    const byQ = await request(app).get("/api/opportunities?q=Scholarship")
    expect(all.body.total).toBeGreaterThan(byQ.body.total)
    expect(byQ.body.data.every((r) => /scholarship/i.test(r.title))).toBe(true)
  })

  it("accepts `query` too", async () => {
    const r = await request(app).get("/api/opportunities?query=Scholarship")
    expect(r.status).toBe(200)
    expect(r.body.search_applied).toBe("Scholarship")
  })

  it("echoes what was actually searched, so a caller can tell", async () => {
    const filtered = await request(app).get("/api/opportunities?q=Scholarship")
    expect(filtered.body.search_applied).toBe("Scholarship")

    const unfiltered = await request(app).get("/api/opportunities")
    expect(unfiltered.body.search_applied).toBeNull()
  })

  it("treats a blank or whitespace-only search as no search, and says so", async () => {
    const r = await request(app).get("/api/opportunities?q=%20%20")
    expect(r.status).toBe(200)
    expect(r.body.search_applied).toBeNull()
  })

  it("lets an explicit `search` win over an alias", async () => {
    const r = await request(app).get("/api/opportunities?search=Scholarship&q=Grant")
    expect(r.body.search_applied).toBe("Scholarship")
  })
})
