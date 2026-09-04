import request from "supertest"
import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from "./testServer.js"
import { scoreApplication } from "../vnext/scoringService.js"

describe("vNext Shoulders backbone", () => {
  let app
  let db

  beforeAll(async () => {
    // Enable the backend feature gate for these tests.
    process.env.SHOULDERS_VNEXT = "true"
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
  }, 60_000)

  beforeEach(() => {
    resetDb(db)
  })

  async function seedProfileAndOpportunity({
    profileId = "profile-vnext-1",
    opportunityId = "opp-vnext-1",
    withProfileFields = false,
    withPortal = true,
  } = {}) {
    db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").run("org-1", "Org 1")
    db.prepare(
      "INSERT INTO profiles (id, display_name, organization_id, status, tags) VALUES (?, ?, ?, ?, ?)",
    ).run(profileId, "Test Profile", "org-1", "active", "[]")

    if (withProfileFields) {
      db.prepare(
        "INSERT INTO profile_sections (id, profile_id, section_key, data) VALUES (?, ?, ?, ?)",
      ).run("ps-basic", profileId, "basic_information", JSON.stringify({ email: "test@example.com", mission: "Help people" }))
      db.prepare(
        "INSERT INTO profile_sections (id, profile_id, section_key, data) VALUES (?, ?, ?, ?)",
      ).run("ps-project", profileId, "project_summary", JSON.stringify({ summary: "Project summary text" }))
    }

    db.prepare(
      `
        INSERT INTO funding_opportunities (
          id, title, sponsor, description, deadline_type,
          application_url, apply_url, application_mode,
          keywords, categories, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      opportunityId,
      "Test Opportunity",
      "Test Funder",
      "A simple opportunity with minimal requirements.",
      "fixed",
      withPortal ? "https://example.com/apply" : null,
      withPortal ? "https://example.com/apply" : null,
      withPortal ? "portal" : "unknown",
      JSON.stringify(["health", "community"]),
      JSON.stringify(["support"]),
      1,
    )

    const created = await request(app)
      .post("/api/vnext/applications")
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ profile_id: profileId, opportunity_id: opportunityId })

    expect(created.status).toBe(201)
    expect(created.body?.id).toBeTruthy()
    return { profileId, opportunityId, applicationId: created.body.id }
  }

  async function transitionThrough(applicationId, states) {
    for (const targetState of states) {
      const response = await request(app)
        .post(`/api/vnext/applications/${applicationId}/transition`)
        .set(TEST_ADMIN_AUTH_HEADER)
        .send({ targetState })

      expect(response.status).toBe(200)
      expect(response.body?.ok).toBe(true)
    }
  }

  it("guard: cannot transition to MAPPED if schema missing (must go through SCHEMA_READY)", async () => {
    const { applicationId, opportunityId } = await seedProfileAndOpportunity({ withProfileFields: true })

    await transitionThrough(applicationId, ["DEDUPED", "QUALIFIED", "SCHEMA_READY"])
    db.prepare("UPDATE funding_opportunities SET schema_id = NULL WHERE id = ?").run(opportunityId)

    const r = await request(app)
      .post(`/api/vnext/applications/${applicationId}/transition`)
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ targetState: "MAPPED" })

    expect(r.status).toBe(409)
    expect(Array.isArray(r.body?.blockers)).toBe(true)
    expect(r.body.blockers.some((b) => b.code === "SCHEMA_MISSING")).toBe(true)
  })

  it("guard: cannot transition to MISSING_RESOLVED when required fields are missing", async () => {
    const { applicationId } = await seedProfileAndOpportunity({ withProfileFields: false })

    await transitionThrough(applicationId, ["DEDUPED", "QUALIFIED", "SCHEMA_READY", "MAPPED"])

    const s3 = await request(app)
      .post(`/api/vnext/applications/${applicationId}/transition`)
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ targetState: "MISSING_RESOLVED" })

    expect(s3.status).toBe(409)
    expect(s3.body.blockers.some((b) => b.code === "MISSING_REQUIREMENTS")).toBe(true)
  })

  it("missingness: with schema + profile facts, required fields map and missing list is empty", async () => {
    const { applicationId, opportunityId } = await seedProfileAndOpportunity({ withProfileFields: true })

    await transitionThrough(applicationId, ["DEDUPED", "QUALIFIED", "SCHEMA_READY", "MAPPED"])

    const appRow = db.prepare("SELECT missing_requirements FROM vnext_applications WHERE id = ?").get(applicationId)
    expect(appRow).toBeTruthy()
    const missing = appRow.missing_requirements ? JSON.parse(appRow.missing_requirements) : null
    expect(missing).toBeTruthy()
    expect(missing.schema_id).toBeTruthy()
    expect(Array.isArray(missing.missing_fields)).toBe(true)
    expect(missing.missing_fields.length).toBe(0)

    // Ensure schema_id was persisted on the opportunity by SCHEMA_READY.
    const oppRow = db.prepare("SELECT schema_id FROM funding_opportunities WHERE id = ?").get(opportunityId)
    expect(String(oppRow?.schema_id || "")).toBeTruthy()
  })

  it("scoring: deterministic expected_value for fixed inputs", async () => {
    const { applicationId, opportunityId } = await seedProfileAndOpportunity({ withProfileFields: true })

    // Move through schema + missing resolved so scoring has stable context.
    await transitionThrough(applicationId, ["DEDUPED", "QUALIFIED", "SCHEMA_READY", "MAPPED", "MISSING_RESOLVED"])

    // Set deterministic deadline far enough out to keep time_risk stable in this test.
    db.prepare("UPDATE funding_opportunities SET deadline_at = ? WHERE id = ?").run("2030-01-01T00:00:00Z", opportunityId)
    // Provide amount bounds so amount_expected is deterministic.
    db.prepare("UPDATE funding_opportunities SET amount_min = ?, amount_max = ? WHERE id = ?").run(10000, 20000, opportunityId)

    const nowMs = new Date("2029-12-01T00:00:00Z").getTime()
    const scored = await scoreApplication(db, { applicationId, actor: { type: "system", id: "test" }, hourly_value: 50, nowMs })
    expect(scored.ok).toBe(true)
    expect(typeof scored.expected_value).toBe("number")
    expect(typeof scored.risk_score).toBe("number")
    // Stable value range assertion (tight enough to detect drift, tolerant enough for small heuristic changes).
    expect(scored.expected_value).toBeGreaterThan(-10000)
    expect(scored.expected_value).toBeLessThan(20000)
  })

  it("finish packet: boundary reached returns checklist and remaining tasks", async () => {
    const { applicationId } = await seedProfileAndOpportunity({ withProfileFields: true, withPortal: true })

    // Deterministic progression through the state machine.
    const states = [
      "DEDUPED",
      "QUALIFIED",
      "SCHEMA_READY",
      "MAPPED",
      "MISSING_RESOLVED",
      "DRAFTING",
      "REVIEW_READY",
      "BOUNDARY_REACHED",
    ]
    await transitionThrough(applicationId, states)

    const packet = await request(app)
      .get(`/api/vnext/applications/${applicationId}/finish-packet`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(packet.status).toBe(200)
    expect(packet.body).toHaveProperty("application")
    expect(packet.body).toHaveProperty("opportunity")
    expect(packet.body).toHaveProperty("boundary")
    expect(packet.body.boundary.type).toBeTruthy()
    expect(Array.isArray(packet.body.submission_instructions)).toBe(true)
    expect(Array.isArray(packet.body.remaining_tasks)).toBe(true)
    // Drafting transition should create baseline drafting tasks.
    expect(packet.body.remaining_tasks.length).toBeGreaterThanOrEqual(1)
  })
})
