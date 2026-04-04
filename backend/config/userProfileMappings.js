/**
 * User Profile Mappings
 * 
 * Maps specific user emails to their designated profile IDs.
 * When these users sign up or log in, they will be automatically
 * assigned to their designated profile instead of the first available one.
 * 
 * To add a new mapping:
 * 1. Find the profile ID from the profiles table or baseline-profiles.json
 * 2. Add the email and profile_id to the USER_PROFILE_MAPPINGS object
 * 3. The user will be automatically linked on their next login/signup
 */

import { ADMIN_EMAIL } from './constants.js'

export const USER_PROFILE_MAPPINGS = {
  // Format: 'user@email.com': 'profile-id-from-database'
  
  // Admin user
  [ADMIN_EMAIL]: null, // Admin has access to all profiles
  
  // Specific user mappings
  'holliet52@gmail.com': 'profile-hollie-knox',
  'isawstars08@yahoo.com': 'profile-brian-client',
  'allmonkey915@gmail.com': 'profile-avanell-leamon',
  'oliviabeltran@gmail.com': 'profile-olivia-beltran',
  'joshua.dasher@gmail.com': 'profile-josh-dasher',
  'rdashermiller@gmail.com': 'profile-rachel-miller',
  // Prefer stable IDs; if the DB already has a different ID, auth will match by email first.
  'angelikaps.rn@gmail.com': 'profile-angelika-ptak',
  'pjandcrdasher@att.net': 'profile-paul-jason-dasher',
  // Liubov
  'anyawhite@rocketmail.com': 'profile-luibov-samoylenko',
}

/**
 * Get the designated profile ID for a given email address
 * @param {string} email - User's email address (case-insensitive)
 * @returns {string|null} Profile ID if mapped, null otherwise
 */
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
    return null // truly unmapped
  }

  const profileId = USER_PROFILE_MAPPINGS[matchingKey]
  // Distinguish admin (null in map) from unmapped (key absent)
  return profileId === null ? ADMIN_PROFILE_SENTINEL : profileId
}

/**
 * Check if a user email has a designated profile mapping
 * @param {string} email - User's email address
 * @returns {boolean} True if the email has a designated profile
 */
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

  // Admin has a key but no real profile ID â not a 'designated profile' assignment
  return USER_PROFILE_MAPPINGS[matchingKey] !== null
}
