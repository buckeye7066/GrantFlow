import request from "supertest"
import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import {
  getAppAndDb,
  resetDb,
  waitForCrawlerJob,
  TEST_ADMIN_AUTH_HEADER,
} from "./testServer.js"

describe("crawlers", () => {
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

  it.skip("runs comprehensive crawler and persists opportunities" /* CUTOVER: legacy comprehensive crawler superseded by Crawler OS */, async () => {
    const enqueue = await request(app)
      .post("/api/crawlers/jobs")
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({
        type: "comprehensive",
        // Use a permissive threshold so the fixture dataset always yields results.
        // NOTE: match_threshold=0 is falsy and would be treated as "unset" by the crawler.
        parameters: { zip_list: ["10001"], match_threshold: 1, max_results: 3 },
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
      .get("verified_real").count

    expect(insertedCount).toBeGreaterThanOrEqual(1)

    const meta = finalRow.result_meta ? JSON.parse(finalRow.result_meta) : null
    expect(meta).toBeTruthy()
    expect(meta).toHaveProperty("total_scored")
    expect(meta.total_scored).toBeGreaterThanOrEqual(1)
    expect(finalRow.result_count).toBeGreaterThanOrEqual(1)
  })
})

