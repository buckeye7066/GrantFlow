import fs from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { summarizeOpenAIError } from '../utils/openaiClient.js'

export async function processAvatarLookupJob({ profileContext, uploadDir, getOpenAI }) {
  const profile = profileContext?.profile
  if (!profile) {
    // Never fail the job: avatar lookup is a cosmetic enhancement.
    return {
      inserted: 0,
      result_count: 0,
      result_meta: {
        ok: false,
        reason: 'missing_profile_context',
        message: 'Avatar generation skipped (missing profile context).',
      },
    }
  }
  let openai = null
  try {
    openai = typeof getOpenAI === 'function' ? getOpenAI() : null
  } catch (error) {
    openai = null
  }
  if (!openai) {
    // Fallback: do not fail the job. The UI already has a default avatar.
    return {
      inserted: 0,
      result_count: 0,
      result_meta: {
        ok: false,
        reason: 'openai_unavailable',
        message: 'Avatar generation unavailable (OpenAI not configured). Using default avatar.',
      },
    }
  }
  const prompt = buildAvatarPrompt(profile)
  let response = null
  try {
    response = await openai.images.generate({
      model: 'gpt-image-1',
      prompt,
      size: '512x512',
      response_format: 'b64_json',
    })
  } catch (error) {
    let summary = { isAuth: false, message: 'Unknown OpenAI error' }
    try {
      summary = summarizeOpenAIError(error)
    } catch {
      // ignore summarizer failures; we'll fall back to a safe message
      const message = error instanceof Error ? error.message : String(error)
      summary = { isAuth: /incorrect api key|invalid api key|unauthorized|401/i.test(message), message }
    }

    const message = error instanceof Error ? error.message : String(error)
    const isAuth =
      Boolean(summary?.isAuth) || /incorrect api key|invalid api key|unauthorized|401/i.test(message)

    if (isAuth) {
      return {
        inserted: 0,
        result_count: 0,
        result_meta: {
          ok: false,
          reason: 'openai_auth_failed',
          message:
            'Avatar generation unavailable (OpenAI authentication failed). Verify OPENAI_API_KEY and image model access.',
        },
      }
    }
    return {
      inserted: 0,
      result_count: 0,
      result_meta: {
        ok: false,
        reason: 'openai_error',
        message: `Avatar generation failed: ${summary?.message || message}`,
      },
    }
  }

  const base64 = response?.data?.[0]?.b64_json
  if (!base64) {
    // Never fail the job: keep crawler pipeline moving.
    return {
      inserted: 0,
      result_count: 0,
      result_meta: {
        ok: false,
        reason: 'openai_no_content',
        message: 'Avatar generation returned no image content. Using default avatar.',
      },
    }
  }

  const filename = `${Date.now()}-${randomUUID()}.png`
  const filePath = join(uploadDir, filename)
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))

  return {
    inserted: 1,
    avatarFilename: filename,
    avatarUrl: `/uploads/${filename}`,
  }
}

function buildAvatarPrompt(profile) {
  const parts = []
  parts.push(`Professional headshot portrait photograph of ${profile.display_name}`)
  if (profile.primary_type) {
    parts.push(`Profile type: ${profile.primary_type.replace(/_/g, ' ')}`)
  }
  parts.push('Facing camera, soft lighting, neutral background, high-resolution, realistic photo style')
  return parts.join('. ')
}
