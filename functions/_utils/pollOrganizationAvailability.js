// ============================================================================
// POLL ORGANIZATION AVAILABILITY UTILITY
// ============================================================================
// 
// This utility handles the eventual consistency issue that occurs after creating
// a new organization profile. Due to backend row-level security (RLS) and/or
// replication delays, a newly created organization may not be immediately
// accessible via standard queries.
//
// This module provides a polling mechanism that repeatedly queries the backend
// for the new organization until it becomes available, or until a timeout occurs.
//
// Usage:
//   const result = await pollForOrganization(sdk, organizationId, options);
//   if (result.success) {
//     // Navigate to /OrganizationProfile?id={organizationId}
//   } else {
//     // Show user-friendly error message
//   }
// ============================================================================

/**
 * Configuration for polling behavior
 */
const DEFAULT_POLL_INTERVAL_MS = 250;  // Poll every 250ms
const DEFAULT_MAX_POLL_DURATION_MS = 5000;  // Maximum 5 seconds of polling

/**
 * Polls the backend for an organization by ID until it becomes available or timeout.
 * 
 * This addresses the eventual consistency issue where a just-created organization
 * may not be immediately queryable due to RLS policies or replication delays.
 * 
 * @param {Object} sdk - The Base44 SDK instance (typically base44.asServiceRole or base44.entities)
 * @param {string} organizationId - The ID of the newly created organization
 * @param {Object} options - Optional configuration
 * @param {number} options.pollIntervalMs - Interval between polls (default: 250ms)
 * @param {number} options.maxDurationMs - Maximum time to poll (default: 5000ms)
 * @returns {Promise<{success: boolean, organization?: Object, error?: string}>}
 */
export async function pollForOrganization(sdk, organizationId, options = {}) {
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const maxDurationMs = options.maxDurationMs || DEFAULT_MAX_POLL_DURATION_MS;
  
  if (!organizationId) {
    return {
      success: false,
      error: 'Organization ID is required for polling'
    };
  }

  const startTime = Date.now();
  let attempts = 0;
  let lastError = null;

  // Polling loop: repeatedly query for the organization until found or timeout
  while (Date.now() - startTime < maxDurationMs) {
    attempts++;
    
    try {
      // Attempt to fetch the organization by ID
      // Using filter with id to match the pattern used elsewhere in the codebase
      const results = await sdk.entities.Organization.filter({ id: organizationId });
      
      if (results && results.length > 0) {
        // Organization found - return success
        console.log(
          `[pollForOrganization] Organization ${organizationId} found after ${attempts} attempts (${Date.now() - startTime}ms)`
        );
        return {
          success: true,
          organization: results[0],
          attempts,
          elapsedMs: Date.now() - startTime
        };
      }
    } catch (err) {
      // Store the error but continue polling - the organization may become available
      lastError = err;
      console.warn(
        `[pollForOrganization] Attempt ${attempts} failed for ${organizationId}: ${err.message}`
      );
    }

    // Wait before next poll attempt
    await sleep(pollIntervalMs);
  }

  // Timeout reached - organization not found within the allowed time
  const elapsedMs = Date.now() - startTime;
  console.error(
    `[pollForOrganization] Timeout after ${attempts} attempts (${elapsedMs}ms) for organization ${organizationId}`
  );
  
  return {
    success: false,
    error: lastError 
      ? `Organization not accessible after ${elapsedMs}ms: ${lastError.message}`
      : `Organization not accessible after ${elapsedMs}ms - the profile may still be processing`,
    attempts,
    elapsedMs
  };
}

/**
 * Simple sleep utility for async/await usage
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates an organization and polls until it's available.
 * This is a convenience wrapper that combines creation and polling.
 * 
 * @param {Object} sdk - The Base44 SDK instance
 * @param {Object} organizationData - The data for the new organization
 * @param {Object} options - Optional polling configuration
 * @returns {Promise<{success: boolean, organization?: Object, error?: string}>}
 */
export async function createAndPollOrganization(sdk, organizationData, options = {}) {
  try {
    // Step 1: Create the organization
    const createdOrg = await sdk.entities.Organization.create(organizationData);
    
    if (!createdOrg || !createdOrg.id) {
      return {
        success: false,
        error: 'Failed to create organization - no ID returned'
      };
    }

    console.log(`[createAndPollOrganization] Organization created with ID: ${createdOrg.id}`);

    // Step 2: Poll until the organization is accessible
    // Note: We pass the SDK that will be used for fetching (may be different from creation SDK)
    const pollResult = await pollForOrganization(sdk, createdOrg.id, options);

    if (pollResult.success) {
      return {
        success: true,
        organization: pollResult.organization,
        createdId: createdOrg.id,
        pollAttempts: pollResult.attempts,
        pollElapsedMs: pollResult.elapsedMs
      };
    } else {
      return {
        success: false,
        error: pollResult.error,
        createdId: createdOrg.id,  // Include the ID so it can be retried later
        pollAttempts: pollResult.attempts,
        pollElapsedMs: pollResult.elapsedMs
      };
    }
  } catch (err) {
    console.error(`[createAndPollOrganization] Creation failed: ${err.message}`);
    return {
      success: false,
      error: `Failed to create organization: ${err.message}`
    };
  }
}

export default {
  pollForOrganization,
  createAndPollOrganization,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_MAX_POLL_DURATION_MS
};
