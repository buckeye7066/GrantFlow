import request from "supertest"
import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import {
  getAppAndDb,
  resetDb,
  waitForCrawlerJob,
  pickAnyZipFromSeed,
  TEST_ADMIN_AUTH_HEADER,
} from "./testServer.js"

describe("crawlers", () => {
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

  it("runs comprehensive crawler and persists opportunities", async () => {
    const zip = pickAnyZipFromSeed()

    const enqueue = await request(app)
      .post("/api/crawlers/jobs")
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({
        type: "comprehensive",
        parameters: { zip_list: [zip], limit_per_zip: 2 },
      })

    expect(enqueue.status).toBe(201)
    expect(enqueue.body).toHaveProperty("id")
    expect(enqueue.body.type).toBe("comprehensive")

    const finalRow = await waitForCrawlerJob(db, enqueue.body.id)
    if (finalRow.status !== "completed") {
      throw new Error(
        `crawler job did not complete: status=${finalRow.status} error=${finalRow.error ?? "n/a"} meta=${
          finalRow.result_meta ?? "n/a"
        }`,
      )
    }

    const insertedCount = db
      .prepare("SELECT COUNT(*) AS count FROM funding_opportunities WHERE source = ?")
      .get("comprehensive_crawler").count

    expect(insertedCount).toBeGreaterThanOrEqual(1)

    const meta = finalRow.result_meta ? JSON.parse(finalRow.result_meta) : null
    expect(meta).toBeTruthy()
    expect(meta).toHaveProperty("inserted")
    expect(meta).toHaveProperty("evaluated")
  })
})

