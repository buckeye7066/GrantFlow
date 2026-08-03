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
    // NOTE: titles must not match the placeholder pattern in the API's
    // response decorator and URLs must not be on the canonical placeholder
    // host list (example.org / example.com). The canonical trust layer in
    // backend/services/opportunityTrust.js rejects those hosts so display=0.
    // Use distinct .org hosts that are not on the placeholder list.
    const create1 = await request(app).post("/api/opportunities").set(TEST_ADMIN_AUTH_HEADER).send({
      title: "Community Emergency Assistance Grant A",
      sponsor: "Example Foundation",
      source: "test",
      source_id: "a",
      description: "A real-looking opportunity used by the opportunities API integration test.",
      application_url: "https://foundation-a.org/apply",
      source_url: "https://foundation-a.org/program",
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
      application_url: "https://foundation-b.org/apply",
      source_url: "https://foundation-b.org/program",
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

  describe("/similar resolution paths", () => {
    // Regression: production reported
    //   GET /api/opportunities/<grants.id>/similar 404 (Not Found)
    // because the route only looked up funding_opportunities.id, but the
    // GrantDetail SidebarSimilar component was passing grant.id (the
    // user's pipeline row id, not the catalog id). The fix is bi-modal:
    //   1) the route accepts EITHER id and resolves grants.id ->
    //      grants.funding_opportunity_id transparently;
    //   2) when neither resolves we return 200 + similar:[] instead of
    //      404, so the sidebar quietly hides instead of polluting the
    //      browser console with red errors on every GrantDetail load.
    it("returns similar opportunities when called with funding_opportunities.id", async () => {
      const seed = await request(app).post("/api/opportunities").set(TEST_ADMIN_AUTH_HEADER).send({
        title: "Veteran Family Stability Fund",
        sponsor: "Example Foundation",
        source: "test",
        source_id: "fo-base",
        description: "Source opportunity used as the lookup target for the /similar route.",
        application_url: "https://foundation-base.org/apply",
        source_url: "https://foundation-base.org/program",
        is_national: true,
        opportunity_type: "grant",
        requires_match: false,
        categories: ["veterans", "housing"],
      })
      expect(seed.status).toBe(201)
      const baseId = seed.body?.id ?? seed.body?.opportunity?.id ?? seed.body?.data?.id
      expect(baseId).toBeTruthy()

      const peer = await request(app).post("/api/opportunities").set(TEST_ADMIN_AUTH_HEADER).send({
        title: "Veteran Housing Assistance Grant",
        sponsor: "Example Foundation",
        source: "test",
        source_id: "fo-peer",
        description: "Peer opportunity that shares categories + sponsor with the base.",
        application_url: "https://foundation-peer.org/apply",
        source_url: "https://foundation-peer.org/program",
        is_national: true,
        opportunity_type: "grant",
        requires_match: false,
        categories: ["veterans"],
      })
      expect(peer.status).toBe(201)

      const res = await request(app).get(`/api/opportunities/${baseId}/similar`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.similar)).toBe(true)
      expect(res.body.similar.length).toBeGreaterThan(0)
      expect(res.body.similar[0]).toHaveProperty("title")
    })

    it("transparently resolves a grants.id to grants.funding_opportunity_id", async () => {
      const seed = await request(app).post("/api/opportunities").set(TEST_ADMIN_AUTH_HEADER).send({
        title: "Senior Independence Fund",
        sponsor: "Example Foundation",
        source: "test",
        source_id: "fo-grants-resolve",
        description: "Source FO that the grants row will reference.",
        application_url: "https://foundation-resolve.org/apply",
        source_url: "https://foundation-resolve.org/program",
        is_national: true,
        opportunity_type: "grant",
        requires_match: false,
        categories: ["seniors"],
      })
      expect(seed.status).toBe(201)
      const foId = seed.body?.id ?? seed.body?.opportunity?.id ?? seed.body?.data?.id
      expect(foId).toBeTruthy()

      // Insert a peer FO so similar[] has at least one candidate.
      const peer = await request(app).post("/api/opportunities").set(TEST_ADMIN_AUTH_HEADER).send({
        title: "Senior Care Stipend",
        sponsor: "Example Foundation",
        source: "test",
        source_id: "fo-grants-peer",
        description: "Peer FO that shares the senior category + sponsor.",
        application_url: "https://foundation-grants-peer.org/apply",
        source_url: "https://foundation-grants-peer.org/program",
        is_national: true,
        opportunity_type: "grant",
        requires_match: false,
        categories: ["seniors"],
      })
      expect(peer.status).toBe(201)

      // Insert a grants row whose id is what the frontend SidebarSimilar
      // component historically passed. The route must resolve this id to
      // funding_opportunity_id and still find similar peers.
      const grantId = "grant-resolve-1"
      await db
        .prepare(`INSERT INTO grants (id, title, funding_opportunity_id) VALUES (?, ?, ?)`)
        .run(grantId, "User Pipeline Row For Senior Independence Fund", foId)

      const res = await request(app).get(`/api/opportunities/${grantId}/similar`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.similar)).toBe(true)
      expect(res.body.resolved_from).toBe("grants_table")
      expect(res.body.similar.length).toBeGreaterThan(0)
    })

    it("returns 200 + empty similar[] (NOT 404) when neither lookup matches", async () => {
      // Mission rule: SimilarGrants is a recall feature; an unindexed
      // opportunity is a recoverable empty set, not a hard error. The
      // user-visible symptom of a 404 here is a red console error on
      // every GrantDetail page load — we explicitly avoid that.
      const res = await request(app).get(`/api/opportunities/this-id-does-not-exist/similar`)
      expect(res.status).toBe(200)
      expect(res.body.similar).toEqual([])
      expect(res.body.reason).toBe("opportunity_not_indexed")
    })

    it("rejects empty / whitespace ids with 400 (still returning similar:[] for the renderer)", async () => {
      const res = await request(app).get(`/api/opportunities/%20/similar`)
      expect(res.status).toBe(400)
      expect(res.body.similar).toEqual([])
    })
  })

  describe("GET /:id catalog id shapes", () => {
    // Regression: crawler-minted catalog rows use deterministicOpportunityId()
    // — a 64-char sha256 hex (backend/crawler-os/contract.js) — but the
    // in-handler id gate (requireUuidParam) only accepted UUIDs, so every
    // crawler-minted row 404'd on GET/PUT/DELETE /:id before the DB was even
    // queried. Production symptom: GrantDetail's Similar Opportunities cards
    // navigate with the catalog id and the page 404'd
    // (/api/grants/85e17656d771…, 2026-08-03). The GrantDetail catalog view
    // now reads this route with exactly those ids.
    const HASH_ID =
      "85e17656d7711ced1b3ea72bd0d73ca49e5fefc00e22c6e9545fcfa5551d9654"

    it("serves a crawler-minted 64-hex catalog id (FAILS on the UUID-only gate)", async () => {
      await db
        .prepare(
          `INSERT INTO funding_opportunities (id, title, sponsor, source, source_id, application_url, source_url, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          HASH_ID,
          "Paramedic Continuing Education Scholarship",
          "Example Foundation",
          "test",
          "hash-row",
          "https://foundation-hash.org/apply",
          "https://foundation-hash.org/program",
        )

      const res = await request(app).get(`/api/opportunities/${HASH_ID}`)
      expect(res.status).toBe(200)
      expect(res.body.id).toBe(HASH_ID)
      expect(res.body.title).toBe("Paramedic Continuing Education Scholarship")
    })

    it("still serves UUID ids and still 404s junk ids", async () => {
      const seed = await request(app).post("/api/opportunities").set(TEST_ADMIN_AUTH_HEADER).send({
        title: "Community Emergency Assistance Grant C",
        sponsor: "Example Foundation",
        source: "test",
        source_id: "uuid-row",
        description: "UUID-shaped row for the id-gate test.",
        application_url: "https://foundation-c.org/apply",
        source_url: "https://foundation-c.org/program",
        is_national: true,
        opportunity_type: "grant",
        requires_match: false,
      })
      expect(seed.status).toBe(201)
      const uuidId = seed.body?.id
      expect(uuidId).toBeTruthy()

      const okRes = await request(app).get(`/api/opportunities/${uuidId}`)
      expect(okRes.status).toBe(200)

      // Wrong alphabet at the right length, and hex one char short: both
      // must stay outside the gate.
      const junkAlphabet = await request(app).get(`/api/opportunities/${"z".repeat(64)}`)
      expect(junkAlphabet.status).toBe(404)
      const shortHex = await request(app).get(`/api/opportunities/${"a".repeat(63)}`)
      expect(shortHex.status).toBe(404)
    })
  })
})

