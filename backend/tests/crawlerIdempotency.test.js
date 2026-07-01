/**
 * Regression tests for GF-AUDIT-019: profile-to-crawl freshness.
 *
 * Verifies that the crawler idempotency key incorporates a digest of
 * material profile fields so that:
 *   - Identical profile + same params → same job (idempotent, no duplicate)
 *   - Materially changed profile + same params → new job (fresh crawl)
 *   - Non-material change only (notes) → same job (still idempotent)
 *   - Profile with no sections → no crash, graceful handling
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from "./testServer.js"
import {
  generateIdempotencyKey,
  createCrawlerJob,
} from "../services/crawlerJobCreation.js"
import {
  computeProfileDigest,
  getMaterialFields,
  hasMaterialProfileChange,
} from "../services/profileHelpers.js"

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function seedUser(db) {
  const id = "u-idem-" + Math.random().toString(36).slice(2, 10)
  db.prepare(`
    INSERT INTO users (id, primary_email, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, `${id}@test.local`)
  return id
}

function seedProfile(db, userId) {
  const id = "p-idem-" + Math.random().toString(36).slice(2, 10)
  db.prepare(`
    INSERT INTO profiles (id, user_id, display_name, primary_type, created_at, updated_at)
    VALUES (?, ?, 'Idempotency Test Profile', 'individual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, userId)
  return id
}

function upsertSection(db, profileId, sectionKey, data) {
  const existing = db
    .prepare("SELECT id FROM profile_sections WHERE profile_id = ? AND section_key = ? LIMIT 1")
    .get(profileId, sectionKey)
  if (existing) {
    db.prepare(`
      UPDATE profile_sections SET data = ?, updated_at = CURRENT_TIMESTAMP
      WHERE profile_id = ? AND section_key = ?
    `).run(JSON.stringify(data), profileId, sectionKey)
  } else {
    const id = "ps-" + Math.random().toString(36).slice(2, 10)
    db.prepare(`
      INSERT INTO profile_sections (id, profile_id, section_key, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, profileId, sectionKey, JSON.stringify(data))
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("crawlerIdempotency — profile content in idempotency key (GF-AUDIT-019)", () => {
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

  // -------------------------------------------------------------------------
  // Test 1: Same profile content + same params → idempotent (return existing)
  // -------------------------------------------------------------------------
  it("Test 1: identical profile content + same params → returns existing job (idempotent)", async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)

    upsertSection(db, profileId, "basic_information", {
      zip_code: "10001",
      state: "NY",
    })

    const type = "profile_enrichment"
    const parameters = { zip: "10001" }

    const digest = await computeProfileDigest(db, profileId)

    const result1 = await createCrawlerJob(db, {
      type,
      profileId,
      parameters,
      requestedBy: "test",
      buildSnapshot: false,
      profileContextDigest: digest,
    })

    const result2 = await createCrawlerJob(db, {
      type,
      profileId,
      parameters,
      requestedBy: "test",
      buildSnapshot: false,
      profileContextDigest: digest,
    })

    expect(result1.created).toBe(true)
    expect(result2.created).toBe(false)
    expect(result2.existing).toBe(true)
    expect(result2.jobId).toBe(result1.jobId)
  })

  // -------------------------------------------------------------------------
  // Test 2: Material change (zip_code edited) → new job created
  // -------------------------------------------------------------------------
  it("Test 2: material profile change (zip_code edited) → creates a NEW job", async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)

    // Original profile
    upsertSection(db, profileId, "basic_information", {
      zip_code: "10001",
      state: "NY",
    })
    const digestBefore = await computeProfileDigest(db, profileId)

    const result1 = await createCrawlerJob(db, {
      type: "profile_enrichment",
      profileId,
      parameters: {},
      requestedBy: "test",
      buildSnapshot: false,
      profileContextDigest: digestBefore,
    })
    expect(result1.created).toBe(true)

    // User edits their zip_code (material change)
    upsertSection(db, profileId, "basic_information", {
      zip_code: "90210",
      state: "CA",
    })
    const digestAfter = await computeProfileDigest(db, profileId)

    // The two digests must differ
    expect(digestBefore).not.toBe(digestAfter)

    const result2 = await createCrawlerJob(db, {
      type: "profile_enrichment",
      profileId,
      parameters: {},
      requestedBy: "test",
      buildSnapshot: false,
      profileContextDigest: digestAfter,
    })
    expect(result2.created).toBe(true)
    expect(result2.jobId).not.toBe(result1.jobId)
  })

  // -------------------------------------------------------------------------
  // Test 3: Non-material change only (notes field) → still idempotent
  // -------------------------------------------------------------------------
  it("Test 3: only non-material field changes (notes) → returns existing job (still idempotent)", async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)

    upsertSection(db, profileId, "basic_information", {
      zip_code: "10001",
      state: "NY",
      notes: "original notes",
    })
    const digestBefore = await computeProfileDigest(db, profileId)

    const result1 = await createCrawlerJob(db, {
      type: "profile_enrichment",
      profileId,
      parameters: {},
      requestedBy: "test",
      buildSnapshot: false,
      profileContextDigest: digestBefore,
    })
    expect(result1.created).toBe(true)

    // User changes only notes (non-material field — not in getMaterialFields)
    upsertSection(db, profileId, "basic_information", {
      zip_code: "10001",
      state: "NY",
      notes: "updated notes — cosmetic only",
    })
    const digestAfter = await computeProfileDigest(db, profileId)

    // Digests must be the same because notes is not a material field
    expect(digestBefore).toBe(digestAfter)

    const result2 = await createCrawlerJob(db, {
      type: "profile_enrichment",
      profileId,
      parameters: {},
      requestedBy: "test",
      buildSnapshot: false,
      profileContextDigest: digestAfter,
    })
    expect(result2.created).toBe(false)
    expect(result2.existing).toBe(true)
    expect(result2.jobId).toBe(result1.jobId)
  })

  // -------------------------------------------------------------------------
  // Test 4: Profile with no sections → no crash, returns a valid digest
  // -------------------------------------------------------------------------
  it("Test 4: profile with no sections → computeProfileDigest handles gracefully", async () => {
    const userId = seedUser(db)
    const profileId = seedProfile(db, userId)
    // Intentionally add NO sections

    const digest = await computeProfileDigest(db, profileId)

    // Must return a non-null, non-empty string
    expect(typeof digest).toBe("string")
    expect(digest.length).toBeGreaterThan(0)

    // And job creation must not throw
    const result = await createCrawlerJob(db, {
      type: "profile_enrichment",
      profileId,
      parameters: {},
      requestedBy: "test",
      buildSnapshot: false,
      profileContextDigest: digest,
    })
    expect(result.jobId).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // Unit tests for helper functions
  // -------------------------------------------------------------------------
  it("getMaterialFields() returns a non-empty map with expected sections", () => {
    const fields = getMaterialFields()
    expect(typeof fields).toBe("object")
    expect(Object.keys(fields).length).toBeGreaterThan(0)
    expect(fields.basic_information).toContain("zip_code")
    expect(fields.organization_details).toContain("mission")
    expect(fields.demographics).toContain("race")
    // Non-material fields should NOT be present
    const allValues = Object.values(fields).flat()
    expect(allValues).not.toContain("notes")
    expect(allValues).not.toContain("updated_by")
    expect(allValues).not.toContain("updated_at")
  })

  it("hasMaterialProfileChange() returns true for different digests", () => {
    expect(hasMaterialProfileChange("abc123", "xyz789")).toBe(true)
  })

  it("hasMaterialProfileChange() returns false for same digest", () => {
    expect(hasMaterialProfileChange("abc123", "abc123")).toBe(false)
  })

  it("hasMaterialProfileChange() returns false when either digest is falsy", () => {
    expect(hasMaterialProfileChange(null, "abc123")).toBe(false)
    expect(hasMaterialProfileChange("abc123", null)).toBe(false)
    expect(hasMaterialProfileChange(null, null)).toBe(false)
  })

  it("generateIdempotencyKey() produces different keys for different profile digests", () => {
    const key1 = generateIdempotencyKey("local", "p-123", { zip: "10001" }, "digest-a")
    const key2 = generateIdempotencyKey("local", "p-123", { zip: "10001" }, "digest-b")
    expect(key1).not.toBe(key2)
  })

  it("generateIdempotencyKey() produces same key when digest is absent (backward compat)", () => {
    const key1 = generateIdempotencyKey("local", "p-123", { zip: "10001" })
    const key2 = generateIdempotencyKey("local", "p-123", { zip: "10001" }, undefined)
    expect(key1).toBe(key2)
  })
})
