import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import { discoverAndSaveSources } from './_shared/crawlerFramework.js';

/**
 * Discover local and state-specific funding sources
 * Focuses on geographic-specific grants and community programs
 */

createSafeServer(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const sdk = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    
    const profile = body.profile || null;
    const profileId = body.profile_id || profile?.id || null;
    const organizationId = body.organization_id || profile?.organization_id || null;

    if (!profile || !profileId) {
      return Response.json({ 
        ok: false, 
        error: 'Profile and profile_id are required' 
      }, { status: 400 });
    }

    const state = profile.state || profile.location?.state;
    const city = profile.city || profile.location?.city;

    if (!state) {
      return Response.json({
        ok: true,
        message: 'No state information in profile for local source discovery',
        discovered: 0,
        saved: 0
      });
    }

    // Create location-focused profile for searching
    const localProfile = {
      ...profile,
      focus_areas: [
        ...(profile.focus_areas || []),
        `${state} programs`,
        'local grants',
        'community funding'
      ],
      keywords: [
        ...(profile.keywords || []),
        `${state} grants`,
        city ? `${city} funding` : '',
        'state programs',
        'local assistance'
      ].filter(k => k)
    };

    // Discover and save local sources
    const result = await discoverAndSaveSources(sdk, {
      profile: localProfile,
      profileId,
      organizationId,
      crawlerName: 'discoverLocalSources',
      options: {
        maxQueries: 3,
        maxResultsPerQuery: 5
      }
    });

    // Add known state-level sources
    const { saveFundingSource } = await import('./_shared/saveFundingSource.js');
    
    // Try to add state government grant page
    try {
      const stateCode = state.toLowerCase().replace(/\s+/g, '');
      await saveFundingSource(sdk, {
        url: `https://www.${stateCode}.gov/grants`,
        title: `${state} State Government Grants`,
        description: `Official state government grants and funding opportunities for ${state} residents`,
        categories: ['state', 'government', 'local'],
        source_type: 'government',
        discovered_by: 'discoverLocalSources',
        organization_id: organizationId,
        profile_id: profileId,
        metadata: { state, automated: true }
      });
      result.saved++;
    } catch (err) {
      console.warn('[discoverLocalSources] Could not save state gov source:', err?.message);
    }

    return Response.json({
      ok: true,
      ...result,
      message: `Discovered ${result.discovered} local sources for ${state}, saved ${result.saved}`
    });

  } catch (error) {
    console.error('[discoverLocalSources] Error:', error);
    return Response.json({ 
      ok: false, 
      error: error?.message ?? 'Discovery failed' 
    }, { status: 500 });
  }
});
