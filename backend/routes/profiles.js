import express from 'express'
import OpenAI from 'openai'
import multer from 'multer'
import fs from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { buildProfileSectionPrompt, supportedSectionKeys, SECTION_PROMPTS } from '../prompts/profileSections.js'
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js'
import { ensureBillingAccount, mapAccountRow } from '../services/billingAccounts.js'
import { extractCompletionText } from '../utils/openai.js'
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { validatePagination } from '../utils/validation.js'
import { formatError } from '../middleware/errorHandler.js'

const router = express.Router()

// Admin configuration
const ADMIN_EMAIL = 'buckeye7066@gmail.com'

/**
 * Check if user is admin
 * Checks both is_admin flag and primary_email match
 */
function isAdmin(user) {
  return Boolean(user?.is_admin) || 
         user?.primary_email === ADMIN_EMAIL || 
         user?.email === ADMIN_EMAIL || 
         user?.role === 'admin'
}

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
  if (!apiKey || apiKey === 'YOUR_OPENAI_API_KEY' || apiKey.includes('*')) {
    console.log('[OpenAI] No valid API key - will use fallback responses')
    // Return a mock object that throws errors gracefully
    return {
      chat: {
        completions: {
          create: async () => {
            throw new Error('OpenAI API key not configured')
          }
        }
      }
    }
  }
  return new OpenAI({ apiKey })
}

router.get('/', (req, res) => {
  const user = req.user
  const includeSummary = req.query.summary === 'true'
  
  // Validate pagination parameters.
  // For admins, default to the max page size unless a limit is explicitly provided.
  // This prevents "missing profiles" in the UI when admins expect to see everything.
  const paginationQuery = { ...req.query }
  const limitProvided = Object.prototype.hasOwnProperty.call(req.query ?? {}, 'limit')
  if (isAdmin(user) && !limitProvided) {
    paginationQuery.limit = 1000
    paginationQuery.offset = 0
  }
  const { limit, offset } = validatePagination(paginationQuery);

  // Check if user is admin
  if (!isAdmin(user)) {
    // Enduser: return only profiles where profiles.user_id = user.id
    if (!user || !user.id) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    // Get all profiles linked to this user (with pagination)
    const rows = req.db.prepare(
      `${profileSelect} WHERE p.user_id = ? ORDER BY p.created_at ASC LIMIT ? OFFSET ?`
    ).all(user.id, limit, offset)
    
    const profiles = rows.map(mapProfile)
    if (includeSummary) {
      profiles.forEach(profile => enrichProfileWithSummary(req.db, profile))
    }
    return res.json(profiles)
  }

  // Admin: return ALL profiles with pagination
  const stmt = req.db.prepare(`${profileSelect} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`)
  const profiles = stmt.all(limit, offset).map(mapProfile)
  
  if (includeSummary) {
    profiles.forEach(profile => enrichProfileWithSummary(req.db, profile))
  }
  
  res.json(profiles)
})

router.post('/', (req, res) => {
  const user = req.user
  const { display_name, primary_type, organization_id, user_id, created_by, status = 'active', tags = [] } = req.body ?? {}

  if (!display_name || typeof display_name !== 'string') {
    return res.status(400).json({ error: 'display_name is required' })
  }

  // Check permissions
  if (!isAdmin(user)) {
    // Enduser can only create profiles for themselves
    if (!user || !user.id) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    
    if (user_id && user_id !== user.id) {
      return res.status(403).json({ 
        error: 'Endusers can only create profiles for themselves' 
      })
    }
  } else {
    // Admin can create for anyone
    if (user_id && !req.db.prepare('SELECT id FROM users WHERE id = ?').get(user_id)) {
      return res.status(400).json({ error: 'Invalid user_id: user does not exist' })
    }
  }

  // Validate organization_id if provided
  if (organization_id) {
    const org = req.db.prepare('SELECT id FROM organizations WHERE id = ?').get(organization_id)
    if (!org) {
      return res.status(400).json({ error: 'Invalid organization_id: organization does not exist' })
    }
  }

  // Determine user_id for the new profile
  const profileUserId = isAdmin(user) ? (user_id || user?.id) : user.id

  const insert = req.db.prepare(`
    INSERT INTO profiles (display_name, primary_type, organization_id, user_id, created_by, status, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const info = insert.run(
    display_name,
    primary_type ?? null,
    organization_id ?? null,
    profileUserId ?? null,
    created_by ?? user?.id ?? null,
    status,
    JSON.stringify(tags)
  )

  const row = req.db.prepare(`${profileSelect} WHERE p.rowid = ?`).get(info.lastInsertRowid)
  if (row?.id) {
    linkProfileToAdmin(req.db, row.id)
    
    // Auto-create profile sections for every canonical section_key
    const sectionStmt = req.db.prepare(`
      INSERT INTO profile_sections (profile_id, section_key, data) 
      VALUES (?, ?, ?)
    `)
    supportedSectionKeys.forEach(key => {
      sectionStmt.run(row.id, key, JSON.stringify({}))
    })
  }
  const refreshed = req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(row.id)
  res.status(201).json(mapProfile(refreshed))
})

/**
 * Get profile completeness stats
 * GET /api/profiles/:id/completeness
 */
router.get('/:id/completeness', (req, res) => {
  const { id } = req.params
  const user = req.user

  // Check access permissions
  const profileRow = req.db.prepare('SELECT id, user_id FROM profiles WHERE id = ?').get(id)
  if (!profileRow) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!isAdmin(user) && profileRow.user_id !== user.id) {
    return res.status(403).json({ error: 'Access denied' })
  }

  // Get canonical sections and keys from profileSections.js
  const { SECTION_PROMPTS } = req.db.supportedSectionConfigs || {} 
  // Wait, I can't access it like that. I'll import SECTION_PROMPTS or just use supportedSectionKeys.
  // Actually, I'll need to know which keys are in which sections.
  
  // Let's import SECTION_PROMPTS in profiles.js
  // (I'll do that in a separate search_replace)
  
  const existingSections = req.db.prepare(`
    SELECT section_key, data FROM profile_sections WHERE profile_id = ?
  `).all(id)

  const sectionsMap = Object.fromEntries(existingSections.map(s => [s.section_key, safeParseJSON(s.data, {})]))
  
  const missing_sections = []
  const missing_keys = {}
  let totalKeys = 0
  let filledKeys = 0

  Object.entries(SECTION_PROMPTS).forEach(([sectionKey, config]) => {
    const sectionData = sectionsMap[sectionKey]
    if (!sectionData) {
      missing_sections.push(sectionKey)
      missing_keys[sectionKey] = config.keys
      totalKeys += config.keys.length
    } else {
      missing_keys[sectionKey] = []
      config.keys.forEach((key) => {
        totalKeys++
        const val = sectionData[key]
        if (
          val !== undefined &&
          val !== null &&
          val !== '' &&
          val !== false &&
          (Array.isArray(val) ? val.length > 0 : true)
        ) {
          filledKeys++
        } else {
          missing_keys[sectionKey].push(key)
        }
      })
    }
  })

  const percent_complete = totalKeys > 0 ? Math.round((filledKeys / totalKeys) * 100) : 0

  res.json({
    profile_id: id,
    missing_sections,
    missing_keys,
    percent_complete,
    total_keys: totalKeys,
    filled_keys: filledKeys,
  })
})

/**
 * Repair a profile by adding missing sections
 * POST /api/profiles/:id/repair
 */
router.post('/:id/repair', (req, res) => {
  const { id } = req.params
  const user = req.user

  const profileRow = req.db.prepare('SELECT id, user_id FROM profiles WHERE id = ?').get(id)
  if (!profileRow) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!isAdmin(user) && profileRow.user_id !== user.id) {
    return res.status(403).json({ error: 'Access denied' })
  }

  const existingSections = req.db.prepare('SELECT section_key FROM profile_sections WHERE profile_id = ?').all(id).map(s => s.section_key)
  const insert = req.db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
  
  let repairedCount = 0
  supportedSectionKeys.forEach(key => {
    if (!existingSections.includes(key)) {
      insert.run(id, key, JSON.stringify({}))
      repairedCount++
    }
  })

  res.json({
    success: true,
    repaired_count: repairedCount,
    message: `Repaired ${repairedCount} missing sections.`
  })
})

/**
 * Repair all profiles (Admin only)
 * POST /api/admin/repair-all-profiles
 */
router.post('/admin/repair-all-profiles', (req, res) => {
  const user = req.user
  if (!isAdmin(user)) {
    return res.status(403).json({ error: 'Admin privileges required' })
  }

  const profiles = req.db.prepare('SELECT id FROM profiles').all()
  let totalRepaired = 0
  let affectedProfiles = 0

  req.db.transaction(() => {
    const insert = req.db.prepare('INSERT OR IGNORE INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    profiles.forEach(p => {
      let count = 0
      supportedSectionKeys.forEach(key => {
        const result = insert.run(p.id, key, JSON.stringify({}))
        if (result.changes > 0) count++
      })
      if (count > 0) {
        totalRepaired += count
        affectedProfiles++
      }
    })
  })()

  res.json({
    success: true,
    total_repaired_sections: totalRepaired,
    affected_profiles: affectedProfiles,
    message: `Repaired ${totalRepaired} sections across ${affectedProfiles} profiles.`
  })
})

/**
 * Export profile as JSON
 * GET /api/profiles/:id/export
 */
router.get('/:id/export', (req, res) => {
  const { id } = req.params
  const user = req.user

  const profileRow = req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profileRow) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!isAdmin(user) && profileRow.user_id !== user.id) {
    return res.status(403).json({ error: 'Access denied' })
  }

  const sections = req.db.prepare(`
    SELECT section_key, data FROM profile_sections WHERE profile_id = ?
  `).all(id)

  const exportData = {
    ...mapProfile(profileRow),
    sections: sections.map(s => ({
      section_key: s.section_key,
      data: safeParseJSON(s.data, {})
    }))
  }

  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Disposition', `attachment; filename=profile-${id}.json`)
  res.json(exportData)
})

/**
 * Import profile from JSON
 * POST /api/profiles/:id/import
 */
router.post('/:id/import', (req, res) => {
  const { id } = req.params
  const user = req.user
  const { sections: importedSections } = req.body ?? {}

  if (!Array.isArray(importedSections)) {
    return res.status(400).json({ error: 'Invalid import data: sections array required' })
  }

  const profileRow = req.db.prepare('SELECT id, user_id FROM profiles WHERE id = ?').get(id)
  if (!profileRow) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!isAdmin(user) && profileRow.user_id !== user.id) {
    return res.status(403).json({ error: 'Access denied' })
  }

  req.db.transaction(() => {
    const upsert = req.db.prepare(`
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `)

    importedSections.forEach(section => {
      if (supportedSectionKeys.includes(section.section_key)) {
        upsert.run(id, section.section_key, JSON.stringify(section.data || {}), user.id)
      }
    })
  })()

  res.json({ success: true, message: 'Profile imported successfully' })
})

router.get('/:id', (req, res) => {
  const { id } = req.params
  const user = req.user
  const row = req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!row) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  // Check access permissions
  if (!isAdmin(user)) {
    // Enduser: can only access profiles where user_id matches
    if (!user || !user.id || row.user_id !== user.id) {
      return res.status(403).json({ error: 'Access denied' })
    }
  }

  // Return profile with sections
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
    // Validate organization_id if provided and not null
    if (organization_id) {
      const org = req.db.prepare('SELECT id FROM organizations WHERE id = ?').get(organization_id)
      if (!org) {
        return res.status(400).json({ error: 'Invalid organization_id: organization does not exist' })
      }
    }
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

router.delete('/:id', (req, res) => {
  const { id } = req.params
  const auth = req.user ?? { role: 'guest' }

  // Check authorization - user must be admin or the profile must belong to them
  const existing = req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!existing) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (auth.role !== 'admin') {
    const matchesProfileId = auth.profileId === id
    const matchesUserId = auth.userId && existing.user_id && auth.userId === existing.user_id
    if (!matchesProfileId && !matchesUserId) {
      return res.status(403).json({ error: 'Not authorized to delete this profile' })
    }
  }

  // Delete the profile (CASCADE will handle related records)
  const stmt = req.db.prepare('DELETE FROM profiles WHERE id = ?')
  stmt.run(id)

  // Clean up avatar file if it exists
  if (existing.avatar_url && existing.avatar_url.startsWith('/uploads/')) {
    const filename = existing.avatar_url.replace('/uploads/', '')
    if (filename) {
      const avatarPath = join(uploadDir, filename)
      fs.unlink(avatarPath, (err) => {
        if (err) console.warn('Failed to delete avatar file:', err)
      })
    }
  }

  res.status(204).send()
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
    res.status(500).json(formatError(error))
  }
})

// Generate AI suggestion for individual profile field
router.post('/:id/fields/ai', async (req, res) => {
  const { id } = req.params
  const { fieldName, fieldLabel, currentValue, fieldDescription, sectionKey, profileData } = req.body
  const auth = req.user ?? { role: 'guest' }

  if (auth.role !== 'admin' && auth.profileId !== id) {
    return res.status(403).json({ error: 'Not authorized to access this profile' })
  }

  try {
    // Get profile for context
    const profile = req.db.prepare(`
      SELECT display_name, primary_type, organization_id 
      FROM profiles WHERE id = ?
    `).get(id)
    
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // Create focused prompt for the specific field
    const prompt = `You are assisting with filling out a grant application field.

Field Name: ${fieldLabel}
${fieldDescription ? `Field Description: ${fieldDescription}` : ''}
Current Value: ${currentValue || '(empty)'}
Section: ${sectionKey || 'general'}

Profile Information:
- Name: ${profile.display_name}
- Type: ${profile.primary_type}
${profileData ? `- Context: ${JSON.stringify(profileData, null, 2).substring(0, 500)}` : ''}

Please provide appropriate content for the "${fieldLabel}" field.
Requirements:
- Be specific and professional
- Use language suitable for grant applications
- For text fields: Provide 2-3 clear, concise sentences
- For numbers: Provide only the numeric value
- For descriptions: Be detailed but concise

Return ONLY the field value content, no JSON wrapper or explanations.`

    const openai = getOpenAI()
    let suggestion
    
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 400,
      })
      suggestion = extractCompletionText(completion).trim()
    } catch (error) {
      // Use mock response if OpenAI fails
      console.log('[Field AI] Using mock response due to:', error.message)
      const mockResponses = {
        mission: 'To empower underserved communities through comprehensive support services.',
        funding_amount_needed: '$50,000 for program expansion and operational support',
        timeline: '12-month implementation period with quarterly milestones',
        default: `Sample content for ${fieldLabel}. This would be customized based on your profile.`
      }
      suggestion = mockResponses[fieldName] || mockResponses.default
    }
    
    res.json({
      field: fieldName,
      suggestion,
      usage: null // No usage data for mock responses
    })
  } catch (error) {
    console.error('Field AI suggestion error:', error)
    res.status(500).json({ error: error.message || 'Failed to generate AI suggestion for field' })
  }
})

// Send application email (for draft applications or completed profiles)
router.post('/send-application-email', async (req, res) => {
  try {
    // Use environment variable with fallback, or require toEmail in request
    const defaultEmail = process.env.APPLICATION_EMAIL || null
    const { toEmail = defaultEmail, applicationData } = req.body

    if (!toEmail) {
      return res.status(400).json({ 
        error: 'Recipient email required',
        message: 'Please provide a toEmail in the request body or set APPLICATION_EMAIL environment variable'
      })
    }

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
    res.status(500).json(formatError(error))
  }
})

export default router
