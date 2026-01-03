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

export const USER_PROFILE_MAPPINGS = {
  // Format: 'user@email.com': 'profile-id-from-database'
  
  // Admin user
  'buckeye7066@gmail.com': null, // Admin has access to all profiles
  
  // Specific user mappings
  // TODO: Add Brian's email and profile ID
  // 'brian@example.com': 'profile-id-here',
  
  // TODO: Add Avanell's email and profile ID
  // 'avanell@example.com': 'profile-id-here',
  
  // TODO: Add Olivia's email and profile ID
  // 'olivia@example.com': 'profile-id-here',
  
  // TODO: Add Hollie's email and profile ID
  // 'hollie@example.com': 'profile-id-here',
}

/**
 * Get the designated profile ID for a given email address
 * @param {string} email - User's email address (case-insensitive)
 * @returns {string|null} Profile ID if mapped, null otherwise
 */
export function getDesignatedProfileForEmail(email) {
  if (!email || typeof email !== 'string') {
    return null
  }
  
  const normalizedEmail = email.trim().toLowerCase()
  return USER_PROFILE_MAPPINGS[normalizedEmail] ?? null
}

/**
 * Check if a user email has a designated profile mapping
 * @param {string} email - User's email address
 * @returns {boolean} True if the email has a designated profile
 */
export function hasDesignatedProfile(email) {
  if (!email || typeof email !== 'string') {
    return false
  }
  
  const normalizedEmail = email.trim().toLowerCase()
  return normalizedEmail in USER_PROFILE_MAPPINGS
}
