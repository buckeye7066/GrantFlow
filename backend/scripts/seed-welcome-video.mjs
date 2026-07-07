#!/usr/bin/env node
/**
 * seed-welcome-video.mjs — reusable seeder for the one-time forced welcome video.
 *
 * Uploads a video file into media_assets (durable BYTEA blob) and creates an
 * UNCONSUMED forced_welcome_videos row that targets a user by email and/or a
 * linked profile id. On that user's next login the video plays full-screen,
 * ahead of every onboarding branch, exactly once.
 *
 * This is a REUSABLE mechanism — nothing about Anita is hardcoded here. To gate
 * the first target (Anita Mayes):
 *
 *   node backend/scripts/seed-welcome-video.mjs \
 *     --file ./welcome-anita.mp4 \
 *     --email nitaboatdrink@hotmail.com \
 *     --profile 1cb89324-de44-49de-889c-9cd61f8aa370 \
 *     --label "A welcome from your team" \
 *     --media-key welcome-anita-v1
 *
 * Args:
 *   --file <path>       (required) local media file to upload
 *   --email <email>     target user's primary_email  (email OR profile required)
 *   --profile <id>      target profile id (matches when profiles.user_id = user)
 *   --label <text>      optional heading shown above the video
 *   --media-key <key>   stable dedupe key (defaults to the file basename)
 *
 * Connects with `pg` using DATABASE_URL (run inside the Railway container, e.g.
 *   railway run node backend/scripts/seed-welcome-video.mjs ...).
 *
 * Idempotent:
 *   - media_assets are deduped by media_key (re-run updates bytes in place).
 *   - a forced_welcome_videos row is NOT duplicated when an UNCONSUMED row for
 *     the same asset + same target (email or profile) already exists.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--file') out.file = argv[++i]
    else if (a === '--email') out.email = argv[++i]
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--label') out.label = argv[++i]
    else if (a === '--media-key') out.mediaKey = argv[++i]
  }
  return out
}

function mimeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.mov':
      return 'video/quicktime'
    case '.ogg':
    case '.ogv':
      return 'video/ogg'
    default:
      return 'application/octet-stream'
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.file) {
    console.error('ERROR: --file <path> is required')
    process.exit(1)
  }
  if (!args.email && !args.profile) {
    console.error('ERROR: at least one of --email or --profile is required')
    process.exit(1)
  }
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set (run inside the Railway container).')
    process.exit(1)
  }

  const absFile = path.resolve(args.file)
  if (!fs.existsSync(absFile)) {
    console.error(`ERROR: file not found: ${absFile}`)
    process.exit(1)
  }

  const bytes = fs.readFileSync(absFile)
  const sizeBytes = bytes.length
  const mimeType = mimeForFile(absFile)
  const mediaKey = args.mediaKey || path.basename(absFile)
  const email = args.email ? String(args.email).trim().toLowerCase() : null
  const profileId = args.profile ? String(args.profile).trim() : null
  const label = args.label ?? null

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  try {
    // 1) Upsert the media asset (dedupe by media_key).
    const existingAsset = await client.query(
      'SELECT id FROM media_assets WHERE media_key = $1 LIMIT 1',
      [mediaKey],
    )

    let mediaAssetId
    if (existingAsset.rows[0]?.id) {
      mediaAssetId = existingAsset.rows[0].id
      await client.query(
        `UPDATE media_assets
            SET mime_type = $1, bytes = $2, size_bytes = $3
          WHERE id = $4`,
        [mimeType, bytes, sizeBytes, mediaAssetId],
      )
      console.log(`media_assets: updated existing row ${mediaAssetId} (media_key=${mediaKey})`)
    } else {
      mediaAssetId = crypto.randomUUID()
      await client.query(
        `INSERT INTO media_assets (id, media_key, mime_type, bytes, size_bytes)
         VALUES ($1, $2, $3, $4, $5)`,
        [mediaAssetId, mediaKey, mimeType, bytes, sizeBytes],
      )
      console.log(`media_assets: inserted ${mediaAssetId} (media_key=${mediaKey}, ${sizeBytes} bytes)`)
    }

    // 2) Reuse an UNCONSUMED forced row for the same asset + same target,
    //    else insert a fresh one.
    const existingForced = await client.query(
      `SELECT id FROM forced_welcome_videos
        WHERE consumed_at IS NULL
          AND media_asset_id = $1
          AND (
            ($2::text IS NOT NULL AND LOWER(TRIM(match_email)) = $2)
            OR ($3::text IS NOT NULL AND match_profile_id = $3)
          )
        ORDER BY created_at DESC
        LIMIT 1`,
      [mediaAssetId, email, profileId],
    )

    let forcedRowId
    if (existingForced.rows[0]?.id) {
      forcedRowId = existingForced.rows[0].id
      // Keep the target metadata fresh (label/email/profile) without duplicating.
      await client.query(
        `UPDATE forced_welcome_videos
            SET match_email = $1, match_profile_id = $2, label = $3
          WHERE id = $4`,
        [email, profileId, label, forcedRowId],
      )
      console.log(`forced_welcome_videos: reused existing unconsumed row ${forcedRowId}`)
    } else {
      forcedRowId = crypto.randomUUID()
      await client.query(
        `INSERT INTO forced_welcome_videos
           (id, media_asset_id, match_email, match_profile_id, label, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [forcedRowId, mediaAssetId, email, profileId, label, 'seed-welcome-video'],
      )
      console.log(`forced_welcome_videos: inserted ${forcedRowId}`)
    }

    console.log('')
    console.log('DONE')
    console.log(`  media_asset_id = ${mediaAssetId}`)
    console.log(`  forced_row_id  = ${forcedRowId}`)
    console.log(`  target_email   = ${email ?? '(none)'}`)
    console.log(`  target_profile = ${profileId ?? '(none)'}`)
    console.log(`  stream_url     = /api/media/${mediaAssetId}`)
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error('seed-welcome-video failed:', err?.message || err)
  process.exit(1)
})
