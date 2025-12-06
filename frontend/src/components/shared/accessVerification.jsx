import { base44 } from "@/api/base44Client";

/**
 * Verify that a newly created organization is accessible by the current user
 * @param {string} organizationId - The ID of the organization to verify
 * @param {number} maxAttempts - Maximum number of verification attempts (default: 3)
 * @returns {Promise<boolean>} - True if access is verified, false otherwise
 */
export async function verifyOrganizationAccess(organizationId, maxAttempts = 3) {
  console.log('[verifyOrganizationAccess] Starting verification for:', organizationId);
  
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    attempts++;
    console.log(`[verifyOrganizationAccess] Attempt ${attempts}/${maxAttempts}`);
    
    // Wait progressively longer between attempts (200ms, 500ms, 1000ms)
    const waitTime = 200 * Math.pow(2, attempts - 1);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    try {
      const testFetch = await base44.entities.Organization.get(organizationId);
      if (testFetch && testFetch.id === organizationId) {
        console.log('[verifyOrganizationAccess] ✅ Access verified');
        return true;
      }
    } catch (err) {
      console.warn(`[verifyOrganizationAccess] Attempt ${attempts} failed:`, err.message);
    }
  }
  
  console.error('[verifyOrganizationAccess] ❌ Access verification failed after', maxAttempts, 'attempts');
  return false;
}