import client from '@/api/client';
import { createLogger } from "@/utils/logger";

/**
 * Verify that a newly created organization is accessible by the current user
 * @param {string} organizationId - The ID of the organization to verify
 * @param {number} maxAttempts - Maximum number of verification attempts (default: 5)
 * @returns {Promise<boolean>} - True if access is verified, false otherwise
 */
export async function verifyOrganizationAccess(organizationId, maxAttempts = 5) {
  const log = createLogger('verifyOrganizationAccess')
  log.debug('starting verification', { organizationId })
  
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    attempts++;
    log.debug(`attempt ${attempts}/${maxAttempts}`)
    
    // Wait progressively longer between attempts (300ms, 600ms, 900ms, 1.2s, 1.5s)
    const waitTime = 300 * attempts;
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    try {
      const testFetch = await client.entities.Organization.get(organizationId);
      if (testFetch && testFetch.id === organizationId) {
        log.debug('access verified')
        return true;
      }
    } catch (err) {
      console.warn(`[verifyOrganizationAccess] Attempt ${attempts} failed:`, err.message);
    }
  }
  
  console.error('[verifyOrganizationAccess] ❌ Access verification failed after', maxAttempts, 'attempts');
  return false;
}