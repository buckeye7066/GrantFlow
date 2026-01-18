import fs from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { summarizeOpenAIError } from '../utils/openaiClient.js'

export async function processAvatarLookupJob({ profileContext, uploadDir, getOpenAI }) {
  const profile = profileContext?.profile
  if (!profile) {
    throw new Error('Avatar lookup requires a profile context')
  }
  const openai = getOpenAI()
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
    const summary = summarizeOpenAIError(error)
    if (summary.isAuth) {
      throw new Error(
        'OpenAI authentication failed for avatar lookup. Verify OPENAI_API_KEY (server-side) and ensure the key has access to image generation.',
      )
    }
    throw new Error(`Avatar lookup failed: ${summary.message}`)
  }

  const base64 = response?.data?.[0]?.b64_json
  if (!base64) {
    throw new Error('Image generation returned no content')
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
