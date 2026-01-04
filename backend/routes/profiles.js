import express from 'express'
import OpenAI from 'openai'
import multer from 'multer'
import fs from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { buildProfileSectionPrompt, supportedSectionKeys } from '../prompts/profileSections.js'
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js'
import { ensureBillingAccount, mapAccountRow } from '../services/billingAccounts.js'
import { extractCompletionText } from '../utils/openai.js'

const router = express.Router()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const uploadDir = join(__dirname, '..', 'uploads')

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
    const extension = file.originalname.split('.').pop()
    cb(null, `${unique}.${extension}`)
  },
})

const imageFileFilter = (_req, file, cb) => {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('Only image uploads are allowed'))
  }
  cb(null, true)
}

const upload = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
})

const profileSelect = `
  SELECT 
    p.id,
    p.created_at,
    p.updated_at,
    p.created_by,
    p.organization_id,
    p.user_id,
    p.primary_type,
    p.display_name,
    p.status,
    p.tags,
    p.avatar_url,
    o.name AS organization_name
  FROM profiles p
  LEFT JOIN organizations o ON o.id = p.organization_id
`

function mapProfile(row) {
  if (!row) return null
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    organization_id: row.organization_id,
    organization_name: row.organization_name ?? null,
    user_id: row.user_id ?? null,
    primary_type: row.primary_type,
    display_name: row.display_name,
    status: row.status,
    tags: safeParseJSON(row.tags, []),
    avatar_url: row.avatar_url ?? null,
  }
}

function safeParseJSON(value, fallback) {
  if (value == null) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function enrichProfileWithSummary(db, profile) {
  // Get billing account info
  const billingAccount = ensureBillingAccount(db, profile.id)
  profile.billing = mapAccountRow(billingAccount)
  
  // Get section completion stats
  const sections = db
    .prepare('SELECT COUNT(*) as total FROM profile_sections WHERE profile_id = ?')
    .get(profile.id)
  profile.sections_complete = sections?.total ?? 0
  
  // Get pipeline funds total
  const pipelineFunds = db
    .prepare(`
      SELECT COALESCE(SUM(g.amount_requested), 0) as total
      FROM grants g
      WHERE g.organization_id = ?
      AND g.status IN ('interested', 'drafting', 'app_prep', 'revision', 'submitted', 'under_review')
    `)
    .get(profile.organization_id)
  profile.pipeline_funds_total = pipelineFunds?.total ?? 0
  
  // Get document count
  const docs = db
    .prepare('SELECT COUNT(*) as total FROM profile_documents WHERE profile_id = ?')
    .get(profile.id)
  profile.document_count = docs?.total ?? 0
  
  return profile
}

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is not set')
  }
  return new OpenAI({ apiKey })
}

router.get('/', (req, res) => {
  const auth = req.user ?? { role: 'guest' }
  const includeSummary = req.query.summary === 'true'

  console.log('[Profiles GET /] Auth:', auth, 'includeSummary:', includeSummary)

  if (auth.role !== 'admin') {
    // Non-admin users should see all profiles they have access to via user_id
    if (!auth.userId) {
      console.log('[Profiles GET /] Non-admin user with no userId, returning empty array')
      return res.json([])
    }

    // Get all profiles linked to this user
    const rows = req.db.prepare(`${profileSelect} WHERE p.user_id = ? ORDER BY p.created_at ASC`).all(auth.userId)
    
    if (rows.length === 0) {
      console.log('[Profiles GET /] No profiles found for userId:', auth.userId)
      return res.json([])
    }

    console.log('[Profiles GET /] Returning', rows.length, 'profiles for user')
    const profiles = rows.map(mapProfile)
    if (includeSummary) {
      profiles.forEach(profile => enrichProfileWithSummary(req.db, profile))
    }
    return res.json(profiles)
  }

  const stmt = req.db.prepare(`${profileSelect} ORDER BY p.created_at DESC`)
  const profiles = stmt.all().map(mapProfile)
  
  if (includeSummary) {
    profiles.forEach(profile => enrichProfileWithSummary(req.db, profile))
  }
  
  console.log('[Profiles GET /] Admin user, returning', profiles.length, 'profiles')
  res.json(profiles)
})

router.post('/', (req, res) => {
  const auth = req.user ?? { role: 'guest' }
  if (auth.role !== 'admin') {
    return res.status(403).json({ error: 'Only admin can create profiles' })
  }
  const { display_name, primary_type, organization_id, created_by, status = 'active', tags = [] } = req.body ?? {}

  if (!display_name || typeof display_name !== 'string') {
    return res.status(400).json({ error: 'display_name is required' })
  }

  const insert = req.db.prepare(`
    INSERT INTO profiles (display_name, primary_type, organization_id, created_by, status, tags)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const info = insert.run(
    display_name,
    primary_type ?? null,
    organization_id ?? null,
    created_by ?? null,
    status ?? 'active',
    JSON.stringify(tags ?? []),
  )

  const row = req.db.prepare(`${profileSelect} WHERE p.rowid = ?`).get(info.lastInsertRowid)
  res.status(201).json(mapProfile(row))
})

router.get('/:id', (req, res) => {
  const { id } = req.params
  const auth = req.user ?? { role: 'guest' }
  const row = req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!row) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (auth.role !== 'admin') {
    const matchesProfileId = auth.profileId === id
    const matchesUserId = auth.userId && row.user_id && auth.userId === row.user_id
    if (!matchesProfileId && !matchesUserId) {
      return res.status(403).json({ error: 'Not authorized to access this profile' })
    }
  }

  const sections = req.db
    .prepare(
      `
      SELECT section_key, data, updated_at, updated_by
      FROM profile_sections
      WHERE profile_id = ?
      ORDER BY section_key
    `,
    )
    .all(id)
    .map((section) => ({
      section_key: section.section_key,
      data: safeParseJSON(section.data, {}),
      updated_at: section.updated_at,
      updated_by: section.updated_by,
    }))

  res.json({
    ...mapProfile(row),
    sections,
    billing: mapAccountRow(ensureBillingAccount(req.db, id)),
  })
})

router.put('/:id', (req, res) => {
  const { id } = req.params
  const { display_name, primary_type, organization_id, status, tags } = req.body ?? {}
  const auth = req.user ?? { role: 'guest' }

  if (auth.role !== 'admin' && auth.profileId !== id) {
    return res.status(403).json({ error: 'Not authorized to update this profile' })
  }

  const existing = req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!existing) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  const updates = []
  const values = []

  if (display_name !== undefined) {
    if (typeof display_name !== 'string' || display_name.trim() === '') {
      return res.status(400).json({ error: 'display_name must be a non-empty string' })
    }
    updates.push('display_name = ?')
    values.push(display_name)
  }

  if (primary_type !== undefined) {
    updates.push('primary_type = ?')
    values.push(primary_type || null)
  }

  if (organization_id !== undefined) {
    updates.push('organization_id = ?')
    values.push(organization_id || null)
  }

  if (status !== undefined) {
    updates.push('status = ?')
    values.push(status)
  }

  if (tags !== undefined) {
    updates.push('tags = ?')
    values.push(JSON.stringify(tags ?? []))
  }

  if (updates.length === 0) {
    return res.json(mapProfile(existing))
  }

  const stmt = req.db.prepare(`UPDATE profiles SET ${updates.join(', ')} WHERE id = ?`)
  stmt.run(...values, id)

  const updated = req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  res.json(mapProfile(updated))
})

router.post('/:id/avatar', upload.single('avatar'), (req, res, next) => {
  const { id } = req.params
  const auth = req.user ?? { role: 'guest' }

  if (auth.role !== 'admin' && auth.profileId !== id) {
    if (req.file) fs.unlink(join(uploadDir, req.file.filename), () => {})
    return res.status(403).json({ error: 'Not authorized to update this profile' })
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Avatar file is required' })
  }

  try {
    const profileRow = req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
    if (!profileRow) {
      fs.unlink(join(uploadDir, req.file.filename), () => {})
      return res.status(404).json({ error: 'Profile not found' })
    }

    const publicPath = `/uploads/${req.file.filename}`
    req.db
      .prepare('UPDATE profiles SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(publicPath, id)

    const previousAvatar = profileRow.avatar_url
    if (previousAvatar && previousAvatar.startsWith('/uploads/')) {
      const previousFilename = previousAvatar.replace('/uploads/', '')
      if (previousFilename && previousFilename !== req.file.filename) {
        const previousPath = join(uploadDir, previousFilename)
        fs.unlink(previousPath, () => {})
      }
    }

    const updated = req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
    res.json(mapProfile(updated))
  } catch (error) {
    if (req.file) fs.unlink(join(uploadDir, req.file.filename), () => {})
    next(error)
  }
})

router.post('/:id/avatar/ai', (req, res) => {
  const { id } = req.params
  const auth = req.user ?? { role: 'guest' }

  if (auth.role !== 'admin' && auth.profileId !== id) {
    return res.status(403).json({ error: 'Not authorized to update this profile' })
  }

  const profileRow = req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profileRow) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  const parameters = {
    display_name: profileRow.display_name,
    primary_type: profileRow.primary_type,
  }

  const stmt = req.db.prepare(`
    INSERT INTO crawler_jobs (
      type,
      status,
      profile_id,
      organization_id,
      parameters,
      requested_by
    ) VALUES ('avatar_lookup', 'queued', ?, ?, ?, ?)
  `)

  stmt.run(
    profileRow.id,
    profileRow.organization_id ?? null,
    JSON.stringify(parameters),
    auth.role === 'admin' ? 'admin' : profileRow.id,
  )

  const job = req.db
    .prepare('SELECT * FROM crawler_jobs WHERE rowid = last_insert_rowid()')
    .get()

  dispatchCrawlerJob({
    db: req.db,
    jobId: job.id,
    uploadDir,
    getOpenAI,
  })

  res.status(202).json({
    id: job.id,
    status: job.status,
    type: job.type,
    created_at: job.created_at,
  })
})

router.get('/:id/sections', (req, res) => {
  const { id } = req.params
  const auth = req.user ?? { role: 'guest' }

  if (auth.role !== 'admin' && auth.profileId !== id) {
    return res.status(403).json({ error: 'Not authorized to access this profile' })
  }

  const profile = req.db.prepare(`SELECT id FROM profiles WHERE id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  const sections = req.db
    .prepare(
      `
      SELECT section_key, data, updated_at, updated_by
      FROM profile_sections
      WHERE profile_id = ?
      ORDER BY section_key
    `,
    )
    .all(id)
    .map((section) => ({
      section_key: section.section_key,
      data: safeParseJSON(section.data, {}),
      updated_at: section.updated_at,
      updated_by: section.updated_by,
    }))

  res.json(sections)
})

router.get('/:id/sections/:sectionKey', (req, res) => {
  const { id, sectionKey } = req.params
  const auth = req.user ?? { role: 'guest' }

  if (auth.role !== 'admin' && auth.profileId !== id) {
    return res.status(403).json({ error: 'Not authorized to access this profile' })
  }

  const section = req.db
    .prepare(
      `
      SELECT section_key, data, updated_at, updated_by
      FROM profile_sections
      WHERE profile_id = ? AND section_key = ?
    `,
    )
    .get(id, sectionKey)

  if (!section) {
    return res.status(404).json({ error: 'Section not found' })
  }

  res.json({
    section_key: section.section_key,
    data: safeParseJSON(section.data, {}),
    updated_at: section.updated_at,
    updated_by: section.updated_by,
  })
})

router.put('/:id/sections/:sectionKey', (req, res) => {
  const { id, sectionKey } = req.params
  const { data, updated_by } = req.body ?? {}
  const auth = req.user ?? { role: 'guest' }

  if (auth.role !== 'admin' && auth.profileId !== id) {
    return res.status(403).json({ error: 'Not authorized to update this profile' })
  }

  const profile = req.db.prepare(`SELECT id FROM profiles WHERE id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (typeof data !== 'object' || data === null) {
    return res.status(400).json({ error: 'data payload must be an object' })
  }

  const upsert = req.db.prepare(
    `
    INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, section_key) DO UPDATE SET
      data = excluded.data,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `,
  )

  upsert.run(id, sectionKey, JSON.stringify(data), updated_by ?? null)

  const section = req.db
    .prepare(
      `
      SELECT section_key, data, updated_at, updated_by
      FROM profile_sections
      WHERE profile_id = ? AND section_key = ?
    `,
    )
    .get(id, sectionKey)

  res.json({
    section_key: section.section_key,
    data: safeParseJSON(section.data, {}),
    updated_at: section.updated_at,
    updated_by: section.updated_by,
  })
})

router.delete('/:id/sections/:sectionKey', (req, res) => {
  const { id, sectionKey } = req.params
  const auth = req.user ?? { role: 'guest' }

  if (auth.role !== 'admin' && auth.profileId !== id) {
    return res.status(403).json({ error: 'Not authorized to update this profile' })
  }

  const stmt = req.db.prepare(`DELETE FROM profile_sections WHERE profile_id = ? AND section_key = ?`)
  const result = stmt.run(id, sectionKey)
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Section not found' })
  }
  res.status(204).send()
})

router.post('/:id/sections/:sectionKey/ai', async (req, res) => {
  const { id, sectionKey } = req.params
  const auth = req.user ?? { role: 'guest' }

  if (auth.role !== 'admin' && auth.profileId !== id) {
    return res.status(403).json({ error: 'Not authorized to access this profile' })
  }

  try {
    if (!supportedSectionKeys.includes(sectionKey)) {
      return res.status(400).json({ error: `Section "${sectionKey}" is not yet AI-enabled.` })
    }

    const profileRow = req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const sectionRows = req.db
      .prepare(
        `
        SELECT section_key, data
        FROM profile_sections
        WHERE profile_id = ?
      `,
      )
      .all(id)

    const sections = Object.fromEntries(
      sectionRows.map((row) => [row.section_key, safeParseJSON(row.data, {})]),
    )

    const docs = req.db
      .prepare(
        `
        SELECT d.id, d.name, d.type, d.status, d.notes
        FROM documents d
        JOIN profile_documents pd ON pd.document_id = d.id
        WHERE pd.profile_id = ?
        ORDER BY d.created_at DESC
      `,
      )
      .all(id)

    const promptPayload = buildProfileSectionPrompt(sectionKey, {
      profile: mapProfile(profileRow),
      sections,
      documents: docs,
    })

    if (!promptPayload) {
      return res.status(400).json({ error: `No prompt mapping for section "${sectionKey}"` })
    }

    const openai = getOpenAI()
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: promptPayload.prompt }],
      temperature: 0.2,
      max_tokens: 1200,
    })

    const raw = extractCompletionText(completion)
    let suggestion = {}

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      suggestion = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError, raw)
      return res.status(502).json({
        error: 'AI response could not be parsed',
        raw_response: raw,
      })
    }

    res.json({
      section_key: sectionKey,
      suggestion,
      usage: completion.usage ?? null,
      raw_response: raw,
    })
  } catch (error) {
    console.error('Error generating profile section suggestion:', error)
    res.status(500).json({ error: error.message })
  }
})

// Send application email (for draft applications or completed profiles)
router.post('/send-application-email', async (req, res) => {
  try {
    const { toEmail = 'dr.johnwhite@axiombiolabs.org', applicationData } = req.body

    // Import email service
    const { sendApplicationEmail } = await import('../services/email.js')

    // Send the email
    const sent = await sendApplicationEmail(toEmail, applicationData)

    if (!sent) {
      return res.status(500).json({ 
        error: 'Email service not configured or failed to send',
        message: 'Please check email service configuration'
      })
    }

    res.json({ 
      success: true,
      message: `Application sent to ${toEmail}` 
    })
  } catch (error) {
    console.error('Error sending application email:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router
