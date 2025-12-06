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
// Usage (React/Frontend - using base44 client):
//   import { base44 } from '@/api/base44Client';
//   const result = await pollForOrganization(base44, organizationId, options);
//   if (result.success) {
//     navigate(`/OrganizationProfile?id=${organizationId}`);
//   } else {
//     // Show user-friendly error message
//   }
//
// Usage (Deno/Backend - using SDK):
//   const result = await pollForOrganization(sdk, organizationId, options);
//
// The sdk/base44 parameter should have an `entities.Organization.filter()` method.
// ============================================================================

/**
 * Configuration for polling behavior
 */
export const POLL_INTERVAL_MS = 250;  // Poll every 250ms
export const MAX_POLL_DURATION_MS = 5000;  // Maximum 5 seconds of polling

/**
 * Simple sleep utility for async/await usage
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls the backend for an organization by ID until it becomes available or timeout.
 * 
 * This addresses the eventual consistency issue where a just-created organization
 * may not be immediately queryable due to RLS policies or replication delays.
 * 
 * @param {Object} apiClient - The Base44 client/SDK instance with `entities.Organization.filter()` method
 * @param {string} organizationId - The ID of the newly created organization
 * @param {Object} options - Optional configuration
 * @param {number} options.pollIntervalMs - Interval between polls (default: 250ms)
 * @param {number} options.maxDurationMs - Maximum time to poll (default: 5000ms)
 * @returns {Promise<{success: boolean, organization?: Object, error?: string, attempts?: number, elapsedMs?: number}>}
 */
export async function pollForOrganization(apiClient, organizationId, options = {}) {
  const pollIntervalMs = options.pollIntervalMs || POLL_INTERVAL_MS;
  const maxDurationMs = options.maxDurationMs || MAX_POLL_DURATION_MS;
  
  if (!organizationId) {
    return {
      success: false,
      error: 'Organization ID is required for polling'
    };
  }

  if (!apiClient || !apiClient.entities || !apiClient.entities.Organization) {
    return {
      success: false,
      error: 'Valid API client with entities.Organization is required'
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
      const results = await apiClient.entities.Organization.filter({ id: organizationId });
      
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
 * Creates an organization and polls until it's available.
 * This is a convenience wrapper that combines creation and polling.
 * 
 * @param {Object} apiClient - The Base44 client/SDK instance with entities.Organization methods
 * @param {Object} organizationData - The data for the new organization
 * @param {Object} options - Optional polling configuration
 * @returns {Promise<{success: boolean, organization?: Object, error?: string, createdId?: string}>}
 */
export async function createAndPollOrganization(apiClient, organizationData, options = {}) {
  try {
    // Step 1: Create the organization
    const createdOrg = await apiClient.entities.Organization.create(organizationData);
    
    if (!createdOrg || !createdOrg.id) {
      return {
        success: false,
        error: 'Failed to create organization - no ID returned'
      };
    }

    console.log(`[createAndPollOrganization] Organization created with ID: ${createdOrg.id}`);

    // Step 2: Poll until the organization is accessible
    const pollResult = await pollForOrganization(apiClient, createdOrg.id, options);

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
  POLL_INTERVAL_MS,
  MAX_POLL_DURATION_MS
};
