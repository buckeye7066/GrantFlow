/**
 * Unified utility for saving newly discovered funding sources
 * 
 * This utility creates or updates Source entities when crawlers discover new funding sources.
 * It ensures consistent metadata tracking across all crawlers.
 */

/**
 * Save a newly discovered funding source to the database
 * 
 * @param {Object} sdk - Base44 SDK instance
 * @param {Object} sourceData - Source information
 * @param {string} sourceData.url - Source URL
 * @param {string} sourceData.title - Source title/name
 * @param {string} [sourceData.description] - Source description
 * @param {string[]} [sourceData.categories] - Relevant categories (e.g., ['education', 'stem'])
 * @param {string} [sourceData.source_type] - Type of source (e.g., 'government', 'foundation', 'directory')
 * @param {string} [sourceData.discovered_by] - Name of crawler that discovered this source
 * @param {string} [sourceData.organization_id] - Related organization ID if applicable
 * @param {string} [sourceData.profile_id] - Related profile ID if applicable
 * @param {Object} [sourceData.metadata] - Additional metadata to store
 * @returns {Promise<Object>} Created or updated Source entity
 */
export async function saveFundingSource(sdk, sourceData) {
  if (!sdk || !sourceData) {
    throw new Error('SDK and sourceData are required');
  }

  if (!sourceData.url) {
    throw new Error('Source URL is required');
  }

  if (!sourceData.title) {
    throw new Error('Source title is required');
  }

  try {
    // Check if source already exists by URL
    const existingSources = await sdk.entities.Source.filter({ url: sourceData.url });
    
    const sourceRecord = {
      url: sourceData.url,
      title: sourceData.title,
      description: sourceData.description || '',
      categories: sourceData.categories || [],
      source_type: sourceData.source_type || 'unknown',
      discovered_by: sourceData.discovered_by || 'unknown_crawler',
      organization_id: sourceData.organization_id || null,
      profile_id: sourceData.profile_id || null,
      metadata: sourceData.metadata || {},
      last_updated: new Date().toISOString(),
      discovered_at: sourceData.discovered_at || new Date().toISOString()
    };

    let savedSource;
    if (existingSources && existingSources.length > 0) {
      // Update existing source
      const existingSource = existingSources[0];
      
      // Merge categories if new ones are provided
      if (sourceData.categories && sourceData.categories.length > 0) {
        const mergedCategories = [...new Set([
          ...(existingSource.categories || []),
          ...sourceData.categories
        ])];
        sourceRecord.categories = mergedCategories;
      }

      // Merge metadata if provided
      if (sourceData.metadata && Object.keys(sourceData.metadata).length > 0) {
        sourceRecord.metadata = {
          ...(existingSource.metadata || {}),
          ...sourceData.metadata
        };
      }

      savedSource = await sdk.entities.Source.update(existingSource.id, sourceRecord);
      console.log(`[saveFundingSource] Updated existing source: ${sourceData.title} (${sourceData.url})`);
    } else {
      // Create new source
      savedSource = await sdk.entities.Source.create(sourceRecord);
      console.log(`[saveFundingSource] Created new source: ${sourceData.title} (${sourceData.url})`);
    }

    return savedSource;
  } catch (error) {
    console.error(`[saveFundingSource] Failed to save source ${sourceData.url}:`, error?.message || error);
    throw error;
  }
}

/**
 * Save multiple funding sources in batch
 * 
 * @param {Object} sdk - Base44 SDK instance
 * @param {Object[]} sources - Array of source data objects
 * @returns {Promise<Object>} Results with saved sources and errors
 */
export async function saveFundingSources(sdk, sources) {
  if (!sdk || !sources || !Array.isArray(sources)) {
    throw new Error('SDK and sources array are required');
  }

  const results = {
    saved: [],
    errors: []
  };

  for (const sourceData of sources) {
    try {
      const saved = await saveFundingSource(sdk, sourceData);
      results.saved.push(saved);
    } catch (error) {
      results.errors.push({
        source: sourceData,
        error: error?.message || String(error)
      });
    }
  }

  console.log(`[saveFundingSources] Saved ${results.saved.length} sources, ${results.errors.length} errors`);
  return results;
}
