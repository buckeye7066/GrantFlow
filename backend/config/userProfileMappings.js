/**
 * User Profile Mappings
 *
 * Source-controlled defaults must never contain real client email addresses.
 * Production/staging mappings should be supplied through either:
 *   - USER_PROFILE_MAPPINGS_JSON='{"person@example.com":"profile-id"}'
 *   - USER_PROFILE_MAPPINGS_FILE=/absolute/path/to/userProfileMappings.local.json
 *
 * The local file path is ignored by git.
 */

import fs from 'fs'
import path from 'path'
import { ADMIN_EMAIL } from './constants.js'

const SOURCE_SAFE_PROFILE_MAPPINGS = {
  ...(ADMIN_EMAIL ? { [ADMIN_EMAIL]: null } : {}), // Admin has access to all profiles.
  'demo.senior-accessibility@example.invalid': 'profile-demo-senior-accessibility',
  'demo.wellness-business@example.invalid': 'profile-demo-wellness-business',
  'demo.veteran-community@example.invalid': 'profile-demo-veteran-community',
  'demo.caregiver-household@example.invalid': 'profile-demo-caregiver-household',
  'demo.healthcare-workforce@example.invalid': 'profile-demo-healthcare-workforce',
  'demo.workforce-training@example.invalid': 'profile-demo-workforce-training',
  'demo.education-support@example.invalid': 'profile-demo-education-support',
  'demo.general-support@example.invalid': 'profile-demo-general-support',
}

function normalizeMappings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [email, profileId] of Object.entries(value)) {
    const key = String(email || '').trim().toLowerCase()
    if (!key) continue
    out[key] = profileId === null ? null : String(profileId || '').trim()
  }
  return out
}

function parseMappingsJson(raw, source) {
  if (!raw) return {}
  try {
    return normalizeMappings(JSON.parse(String(raw)))
  } catch (error) {
    console.warn(`[userProfileMappings] Ignoring invalid ${source}:`, error?.message || error)
    return {}
  }
}

function loadMappingsFile(filePath) {
  if (!filePath) return {}
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
    if (!fs.existsSync(resolved)) return {}
    return parseMappingsJson(fs.readFileSync(resolved, 'utf8'), `mapping file ${resolved}`)
  } catch (error) {
    console.warn('[userProfileMappings] Failed to load mapping file:', error?.message || error)
    return {}
  }
}

export const USER_PROFILE_MAPPINGS = Object.freeze({
  ...SOURCE_SAFE_PROFILE_MAPPINGS,
  ...loadMappingsFile(process.env.USER_PROFILE_MAPPINGS_FILE),
  ...parseMappingsJson(process.env.USER_PROFILE_MAPPINGS_JSON, 'USER_PROFILE_MAPPINGS_JSON'),
})

/** Sentinel returned when the email is the admin account (all-profiles access, no single profile). */
export const ADMIN_PROFILE_SENTINEL = '__admin__'

/**
 * Get the designated profile ID for a given email address.
 * Returns ADMIN_PROFILE_SENTINEL for the admin account,
 * a profile-id string for mapped users, or null for unmapped users.
 * @param {string} email - User's email address (case-insensitive)
 * @returns {string|null}
 */
export function getDesignatedProfileForEmail(email) {
  if (!email || typeof email !== 'string') {
    return null
  }

  const normalizedEmail = email.trim().toLowerCase()
  const matchingKey = Object.keys(USER_PROFILE_MAPPINGS).find(
    key => key.toLowerCase() === normalizedEmail
  )

  if (!matchingKey) {
    return null
  }

  const profileId = USER_PROFILE_MAPPINGS[matchingKey]
  return profileId === null ? ADMIN_PROFILE_SENTINEL : profileId
}

/**
 * Check if a user email has a designated (non-admin) profile mapping.
 * Returns false for unmapped users AND for the admin account.
 * Use getDesignatedProfileForEmail() === ADMIN_PROFILE_SENTINEL to detect admin.
 * @param {string} email - User's email address
 * @returns {boolean}
 */
export function hasDesignatedProfile(email) {
  if (!email || typeof email !== 'string') {
    return false
  }

  const normalizedEmail = email.trim().toLowerCase()
  const matchingKey = Object.keys(USER_PROFILE_MAPPINGS).find(
    key => key.toLowerCase() === normalizedEmail
  )

  if (!matchingKey) {
    return false
  }

  return USER_PROFILE_MAPPINGS[matchingKey] !== null
}
