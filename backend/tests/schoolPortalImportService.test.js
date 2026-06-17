import request from "supertest"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { normalizeProviderScholarshipRecords } from "../services/schoolPortalImportService.js"
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from "./testServer.js"

describe("school portal imports", () => {
  let app
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
  }, 120_000)

  beforeEach(() => {
    resetDb(db)
  })

  it("normalizes TSAC pilot awards into the canonical GrantFlow shape", () => {
    const awards = normalizeProviderScholarshipRecords(
      "tsac",
      [
        {
          award_name: "Tennessee HOPE Scholarship",
          amount: "$3,500",
          status: "offered",
          academic_year: "2026-2027",
          program_code: "hope-tn",
        },
      ],
      {
        portalUrl: "https://www.tn.gov/collegepays.html",
        schoolName: "MTSU",
        connectionId: "connection-1",
      },
    )

    expect(awards).toHaveLength(1)
    expect(awards[0]).toMatchObject({
      title: "Tennessee HOPE Scholarship",
      amount: 3500,
      amount_display: "$3,500",
      provider_id: "tsac",
      import_mode: "pilot_manual_import",
      school_name: "MTSU",
      connection_id: "connection-1",
    })
  })

  it("creates, merges, deduplicates, and removes imported portal awards through the profile routes", async () => {
    const profileId = "00000000-0000-0000-0000-000000005340"
    const applicationId = "app-tsac-1"
    db.prepare(`
      INSERT INTO profiles (id, display_name, primary_type, status, tags)
      VALUES (?, 'Portal Student', 'high_school_student', 'active', '[]')
    `).run(profileId)
    db.prepare(`
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, 'university_applications', ?, 'test')
    `).run(
      profileId,
      JSON.stringify({
        applications: [
          {
            id: applicationId,
            name: "Middle Tennessee State University",
            status: "planning",
            financial_aid_pipeline: [],
          },
        ],
      }),
    )

    const connect = await request(app)
      .post(`/api/profiles/${profileId}/school-portals/connections`)
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({
        provider_id: "tsac",
        application_id: applicationId,
        school_name: "Middle Tennessee State University",
        connection_label: "TSAC portal",
        awards_payload: JSON.stringify([
          {
            title: "Tennessee HOPE Scholarship",
            amount: 3500,
            status: "offered",
            academic_year: "2026-2027",
          },
          {
            title: "TSAA Need-Based Grant",
            amount: 2000,
            status: "pending review",
            academic_year: "2026-2027",
          },
        ]),
      })

    expect(connect.status).toBe(201)
    expect(connect.body.connections).toHaveLength(1)
    expect(connect.body.connections[0].available_awards).toHaveLength(2)

    const connectionId = connect.body.connection.id
    const awardId = connect.body.connection.available_awards[0].id

    const merge = await request(app)
      .post(`/api/profiles/${profileId}/school-portals/merge`)
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({
        connection_id: connectionId,
        application_id: applicationId,
        award_ids: [awardId],
      })

    expect(merge.status).toBe(200)
    expect(merge.body.merged_count).toBe(1)
    expect(merge.body.merged_awards).toHaveLength(1)
    expect(merge.body.merged_awards[0]).toMatchObject({
      id: awardId,
      provider_id: "tsac",
      application_id: applicationId,
    })

    const mergedSectionRow = db
      .prepare("SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'university_applications'")
      .get(profileId)
    const mergedSection = JSON.parse(mergedSectionRow.data)
    expect(mergedSection.applications[0].imported_portal_awards).toHaveLength(1)
    expect(mergedSection.applications[0].financial_aid_pipeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `portal_${awardId}`.slice(0, 64),
          label: expect.stringContaining("Imported Portal Award"),
        }),
      ]),
    )

    const mergeAgain = await request(app)
      .post(`/api/profiles/${profileId}/school-portals/merge`)
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({
        connection_id: connectionId,
        application_id: applicationId,
        award_ids: [awardId],
      })

    expect(mergeAgain.status).toBe(200)
    const dedupedSection = JSON.parse(
      db
        .prepare("SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'university_applications'")
        .get(profileId).data,
    )
    expect(dedupedSection.applications[0].imported_portal_awards).toHaveLength(1)

    const remove = await request(app)
      .delete(`/api/profiles/${profileId}/school-portals/awards/${awardId}`)
      .set(TEST_ADMIN_AUTH_HEADER)

    expect(remove.status).toBe(200)

    const finalSection = JSON.parse(
      db
        .prepare("SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'university_applications'")
        .get(profileId).data,
    )
    expect(finalSection.applications[0].imported_portal_awards ?? []).toHaveLength(0)
    expect(finalSection.applications[0].financial_aid_pipeline ?? []).toHaveLength(0)
  })
})
