import request from "supertest"
import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from "./testServer.js"

describe("documents ingest creates profile", () => {
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

  it("POST /api/documents/ingest without profile_id returns profile_id and succeeds twice", async () => {
    const doIngest = async (name) => {
      return request(app)
        .post("/api/documents/ingest")
        .set(TEST_ADMIN_AUTH_HEADER)
        .field("display_name", name)
        .attach("document", Buffer.from("hello world"), {
          filename: `${name}.txt`,
          contentType: "text/plain",
        })
    }

    const r1 = await doIngest("Upload Profile 1")
    expect(r1.status).toBe(202)
    expect(r1.body).toBeTruthy()
    expect(r1.body.success).toBe(true)
    expect(typeof r1.body.profile_id).toBe("string")
    expect(r1.body.profile_id.length).toBeGreaterThan(10)

    const r2 = await doIngest("Upload Profile 2")
    expect(r2.status).toBe(202)
    expect(r2.body).toBeTruthy()
    expect(r2.body.success).toBe(true)
    expect(typeof r2.body.profile_id).toBe("string")
    expect(r2.body.profile_id.length).toBeGreaterThan(10)

    // Ensure they are distinct profiles.
    expect(r2.body.profile_id).not.toBe(r1.body.profile_id)
  })
})

