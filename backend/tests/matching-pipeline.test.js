import request from "supertest"
import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from "./testServer.js"

/**
 * Integration tests for the matching pipeline — the core flow that
 * connects profiles to funding opportunities.
 *
 * These tests verify the entire chain:
 *   profile → loadProfileContext → buildProfileSignals → calculateMatchScore → response
 *
 * Goal: users always see real funding sources that match their profile.
 */

let currentProfileId = null

function ensureCrawlerOsMatchTable(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS profile_opportunity_matches (
      id TEXT,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      match_decision TEXT,
      match_explanation TEXT,
      match_reasons TEXT DEFAULT '[]',
      match_explain_json TEXT,
      matcher_version TEXT NOT NULL DEFAULT 'crawler-os',
      computed_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (profile_id, opportunity_id, matcher_version)
    )
  `).run()
}

function seedUser(db) {
  const userId = "u-test-" + Math.random().toString(36).slice(2, 10)
  db.prepare(`
    INSERT INTO users (id, primary_email, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(userId, `${userId}@test.local`)
  return userId
}

function seedOrg(db, name = "Test Org") {
  const orgId = "org-test-" + Math.random().toString(36).slice(2, 10)
  db.prepare(`
    INSERT INTO organizations (id, name, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(orgId, name)
  return orgId
}

function seedProfile(db, userId, orgId, overrides = {}) {
  const profileId = "p-test-" + Math.random().toString(36).slice(2, 10)
  // Stamp last_discovery_at so these integration profiles represent the
  // "discovery has already run" state. The matching endpoint now gates the
  // catalog behind a per-profile discovery_pending signal (NULL → empty +
  // discovery_pending); these tests assert the post-discovery matching
  // behavior, so they must look like discovery has run.
  db.prepare(`
    INSERT INTO profiles (id, user_id, organization_id, display_name, primary_type, last_discovery_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    profileId,
    userId,
    orgId,
    overrides.display_name || "Test Profile",
    overrides.primary_type || "individual",
  )
  if (overrides.state) {
    seedSection(db, profileId, "basic_information", { state: overrides.state })
  }
  currentProfileId = profileId
  return profileId
}

function seedSection(db, profileId, sectionKey, data) {
  const existing = db.prepare(
    "SELECT id, data FROM profile_sections WHERE profile_id = ? AND section_key = ?"
  ).get(profileId, sectionKey)
  if (existing) {
    const merged = { ...(JSON.parse(existing.data || "{}")), ...data }
    db.prepare("UPDATE profile_sections SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(JSON.stringify(merged), existing.id)
  } else {
    const id = "ps-" + Math.random().toString(36).slice(2, 10)
    db.prepare(`
      INSERT INTO profile_sections (id, profile_id, section_key, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, profileId, sectionKey, JSON.stringify(data))
  }
}

function seedOpportunity(db, overrides = {}) {
  const id = overrides.id || crypto.randomUUID()
  db.prepare(`
    INSERT INTO funding_opportunities (
      id, title, description, source, record_origin, state,
      is_active, is_national, source_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id,
    overrides.title || "Test Grant",
    overrides.description || "A funding opportunity.",
    overrides.source || "manual",
    overrides.record_origin || "curated_verified",
    overrides.state || "TN",
    overrides.is_national ? 1 : 0,
    overrides.source_url || "https://example-real.org/grant",
  )
  if (overrides.os_match !== false) {
    seedCrawlerOsMatch(db, overrides.profileId || currentProfileId, id, {
      score: overrides.match_score ?? 72,
      decision: overrides.match_decision || "review",
      reasons: overrides.match_reasons || ["profile_need_match"],
      explanation: overrides.match_explanation || "Crawler OS matched this opportunity for the profile.",
    })
  }
  return id
}

function seedCrawlerOsMatch(db, profileId, opportunityId, {
  score = 72,
  decision = "review",
  reasons = ["profile_need_match"],
  explanation = "Crawler OS matched this opportunity for the profile.",
} = {}) {
  if (!profileId || !opportunityId) return
  db.prepare(`
    INSERT OR REPLACE INTO profile_opportunity_matches
      (id, profile_id, opportunity_id, match_score, match_decision, match_explanation, match_reasons, matcher_version, computed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(crypto.randomUUID(), profileId, opportunityId, score, decision, explanation, JSON.stringify(reasons))
}

describe("Matching Pipeline", () => {
  let app, db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
  }, 60_000)

  beforeEach(() => {
    resetDb(db)
    ensureCrawlerOsMatchTable(db)
    currentProfileId = null
  })

  // ─── CORE: profile with real data always gets results ────────────────
  it("returns non-zero matches for a veteran profile in TN", async () => {
    const userId = seedUser(db)
    const orgId = seedOrg(db)
    const profileId = seedProfile(db, userId, orgId, { state: "TN" })

    seedSection(db, profileId, "military_service", { veteran: true, military_branch: "Army" })
    seedSection(db, profileId, "basic_information", { gender: "male", age: 45 })

    seedOpportunity(db, {
      title: "Veterans Emergency Assistance",
      description: "Financial assistance for veterans in Tennessee",
      state: "TN",
      record_origin: "curated_verified",
    })
    seedOpportunity(db, {
      title: "National Veteran Support Fund",
      description: "Nationwide grants for military veterans",
      is_national: true,
      record_origin: "live_crawl",
    })

    const res = await request(app)
      .get(`/api/matching/profile/${profileId}/opportunities?min_score=0&skip_readiness_check=1`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    expect(res.body.returned).toBeGreaterThan(0)
    expect(res.body.opportunities.length).toBeGreaterThan(0)

    const titles = res.body.opportunities.map((o) => o.title)
    expect(titles).toContain("Veterans Emergency Assistance")
  })

  // ─── SPARSE PROFILE: still surfaces profile-owned OS matches ─────────
  it("returns results for a sparse profile when Crawler OS has a qualified match", async () => {
    const userId = seedUser(db)
    const orgId = seedOrg(db)
    const profileId = seedProfile(db, userId, orgId, { state: "TN" })

    seedOpportunity(db, {
      title: "General Community Fund",
      description: "Open to all residents for emergency assistance",
      state: "TN",
      record_origin: "curated_verified",
      match_score: 78,
    })

    // Sparse profile fields are neutral, but results still have to be tied to a
    // profile-owned Crawler OS match. The route no longer backfills generic
    // catalog rows when OS matching has not produced coverage.
    const res = await request(app)
      .get(`/api/matching/profile/${profileId}/opportunities?skip_readiness_check=1`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    expect(res.body.returned).toBeGreaterThan(0)
  })

  // ─── TRUST FILTERS: synthetic/untrusted opps are excluded ────────────
  it("excludes synthetic and untrusted record_origins", async () => {
    const userId = seedUser(db)
    const orgId = seedOrg(db)
    const profileId = seedProfile(db, userId, orgId, { state: "TN" })

    seedOpportunity(db, {
      title: "Real Grant",
      record_origin: "curated_verified",
      state: "TN",
    })
    seedOpportunity(db, {
      title: "Synthetic Junk",
      record_origin: "synthetic",
      state: "TN",
      os_match: false,
    })

    const res = await request(app)
      .get(`/api/matching/profile/${profileId}/opportunities?min_score=0&skip_readiness_check=1`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    const titles = res.body.opportunities.map((o) => o.title)
    expect(titles).toContain("Real Grant")
    expect(titles).not.toContain("Synthetic Junk")
  })

  // ─── INACTIVE: inactive opps never shown ─────────────────────────────
  it("excludes inactive opportunities", async () => {
    const userId = seedUser(db)
    const orgId = seedOrg(db)
    const profileId = seedProfile(db, userId, orgId, { state: "TN" })

    const activeId = seedOpportunity(db, { title: "Active Grant", state: "TN" })
    const inactiveId = seedOpportunity(db, { title: "Dead Grant", state: "TN" })
    db.prepare("UPDATE funding_opportunities SET is_active = 0 WHERE id = ?").run(inactiveId)

    const res = await request(app)
      .get(`/api/matching/profile/${profileId}/opportunities?min_score=0&skip_readiness_check=1`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    const titles = res.body.opportunities.map((o) => o.title)
    expect(titles).toContain("Active Grant")
    expect(titles).not.toContain("Dead Grant")
  })

  // ─── KEYWORD MATCHING: profile keywords boost score ──────────────────
  it("scores higher for keyword-matching opportunities", async () => {
    const userId = seedUser(db)
    const orgId = seedOrg(db)
    const profileId = seedProfile(db, userId, orgId, { state: "TN" })
    seedSection(db, profileId, "health_medical", { chronic_illness: true, chronic_illness_type: "diabetes" })

    seedOpportunity(db, {
      title: "Diabetes Patient Assistance Program",
      description: "Financial help for patients with diabetes and chronic illness",
      state: "TN",
      match_score: 86,
    })
    seedOpportunity(db, {
      title: "Generic Fund",
      description: "A general community resource",
      state: "TN",
      match_score: 52,
    })

    const res = await request(app)
      .get(`/api/matching/profile/${profileId}/opportunities?min_score=0&skip_readiness_check=1`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    const opps = res.body.opportunities
    const diabetesOpp = opps.find((o) => o.title.includes("Diabetes"))
    const genericOpp = opps.find((o) => o.title.includes("Generic"))
    expect(diabetesOpp).toBeDefined()
    expect(genericOpp).toBeDefined()
    expect(diabetesOpp.match_score).toBeGreaterThan(genericOpp.match_score)
  })

  // ─── GEO: state match beats national ─────────────────────────────────
  it("scores state-matched opps higher than national ones", async () => {
    const userId = seedUser(db)
    const orgId = seedOrg(db)
    const profileId = seedProfile(db, userId, orgId, { state: "TN" })

    seedOpportunity(db, {
      title: "Tennessee Emergency Fund",
      description: "State emergency assistance for Tennessee residents",
      state: "TN",
      match_score: 82,
    })
    seedOpportunity(db, {
      title: "National Emergency Fund",
      description: "National emergency assistance program",
      is_national: true,
      state: null,
      match_score: 68,
    })

    const res = await request(app)
      .get(`/api/matching/profile/${profileId}/opportunities?min_score=0&skip_readiness_check=1`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    const stateOpp = res.body.opportunities.find((o) => o.title.includes("Tennessee"))
    const natOpp = res.body.opportunities.find((o) => o.title.includes("National"))
    expect(stateOpp).toBeDefined()
    expect(natOpp).toBeDefined()
    expect(stateOpp.match_score).toBeGreaterThanOrEqual(natOpp.match_score)
  })

  // ─── JUNK FILTER: informational pages excluded ───────────────────────
  it("filters out informational health pages", async () => {
    const userId = seedUser(db)
    const orgId = seedOrg(db)
    const profileId = seedProfile(db, userId, orgId, { state: "TN" })

    seedOpportunity(db, { title: "Real Grant", state: "TN" })
    seedOpportunity(db, {
      title: "MedlinePlus Health Topics - Diabetes",
      description: "Health information about diabetes conditions",
      state: "TN",
      source_url: "https://medlineplus.gov/diabetes.html",
      os_match: false,
    })

    const res = await request(app)
      .get(`/api/matching/profile/${profileId}/opportunities?min_score=0&skip_readiness_check=1`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    const titles = res.body.opportunities.map((o) => o.title)
    expect(titles).toContain("Real Grant")
    expect(titles).not.toContain("MedlinePlus Health Topics - Diabetes")
  })

  // ─── PROFILE SIGNALS: education fields are extracted ─────────────────
  it("extracts education signals for scoring", async () => {
    const userId = seedUser(db)
    const orgId = seedOrg(db)
    const profileId = seedProfile(db, userId, orgId, { state: "TN", primary_type: "student" })
    seedSection(db, profileId, "education", {
      highest_level: "high school",
      first_generation: true,
      field_of_study: "Computer Science",
      gpa: 3.8,
    })

    seedOpportunity(db, {
      title: "First Generation STEM Scholarship",
      description: "Scholarship for first generation college students in STEM fields and computer science",
      is_national: true,
      match_score: 84,
    })

    const res = await request(app)
      .get(`/api/matching/profile/${profileId}/opportunities?min_score=0&skip_readiness_check=1`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    const opp = res.body.opportunities.find((o) => o.title.includes("STEM"))
    expect(opp).toBeDefined()
    expect(opp.match_score).toBeGreaterThan(10)
  })

  // ─── PROFILE SIGNALS: small business certifications ──────────────────
  it("extracts small business certification signals", async () => {
    const userId = seedUser(db)
    const orgId = seedOrg(db)
    const profileId = seedProfile(db, userId, orgId, { state: "TN", primary_type: "small_business" })
    seedSection(db, profileId, "small_business_details", {
      business_name: "Test LLC",
      naics_code: "722330",
      certifications: ["WOSB", "HUBZone"],
      years_in_business: 1,
    })

    seedOpportunity(db, {
      title: "Women-Owned Small Business Grant",
      description: "Federal grants for WOSB certified women-owned small businesses and HUBZone enterprises",
      is_national: true,
      match_score: 84,
    })

    const res = await request(app)
      .get(`/api/matching/profile/${profileId}/opportunities?min_score=0&skip_readiness_check=1`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(res.status).toBe(200)
    const opp = res.body.opportunities.find((o) => o.title.includes("Women-Owned"))
    expect(opp).toBeDefined()
    expect(opp.match_score).toBeGreaterThan(10)
  })
})

describe("Profile Signals Unit", () => {
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    db = loaded.db
  }, 60_000)

  beforeEach(() => {
    resetDb(db)
    ensureCrawlerOsMatchTable(db)
    currentProfileId = null
  })

  it("loadProfileSignals returns unified signals with needs and intents", async () => {
    const { loadProfileSignals } = await import("../services/profileSignals/index.js")

    const userId = seedUser(db)
    const orgId = seedOrg(db)
    const profileId = seedProfile(db, userId, orgId, { state: "TN" })
    seedSection(db, profileId, "military_service", { veteran: true })
    seedSection(db, profileId, "health_medical", { chronic_illness: true })

    const result = await loadProfileSignals(db, profileId)

    expect(result.signals).toBeDefined()
    expect(result.intents).toBeInstanceOf(Set)
    expect(result.assistancePrograms).toBeInstanceOf(Array)

    expect(result.signals.military).toBeInstanceOf(Set)
    expect(result.signals.military.has("veteran")).toBe(true)

    expect(result.signals.health).toBeInstanceOf(Set)
    expect(result.signals.health.size).toBeGreaterThan(0)

    expect(result.signals.needs).toBeInstanceOf(Set)
    expect(result.signals.needs.has("healthcare")).toBe(true)

    expect(result.intents.has("military")).toBe(true)
    expect(result.intents.has("healthcare")).toBe(true)
  })
})
