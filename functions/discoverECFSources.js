import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import { discoverAndSaveSources } from './_shared/crawlerFramework.js';

/**
 * Discover funding sources for Exceptional Children and Families (ECF)
 * Focuses on disability-related grants, special needs funding, and family support
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

    // Check if profile has ECF-related needs
    const hasDisability = (profile.disabilities && profile.disabilities.length > 0) ||
                         (profile.health_conditions && profile.health_conditions.length > 0) ||
                         (profile.icd10_codes && profile.icd10_codes.length > 0);

    if (!hasDisability) {
      return Response.json({
        ok: true,
        message: 'Profile does not indicate ECF needs',
        discovered: 0,
        saved: 0
      });
    }

    // Create ECF-focused profile for searching
    const ecfProfile = {
      ...profile,
      focus_areas: [
        ...(profile.focus_areas || []),
        'disability support',
        'special needs',
        'exceptional children',
        'family assistance'
      ],
      keywords: [
        ...(profile.keywords || []),
        'disability grants',
        'special education',
        'therapeutic services',
        'adaptive equipment',
        'respite care'
      ]
    };

    // Discover and save ECF sources
    const result = await discoverAndSaveSources(sdk, {
      profile: ecfProfile,
      profileId,
      organizationId,
      crawlerName: 'discoverECFSources',
      options: {
        maxQueries: 4,
        maxResultsPerQuery: 5
      }
    });

    // Also add known ECF sources
    const knownECFSources = [
      {
        url: 'https://www.exceptionallives.org',
        title: 'Exceptional Lives - Disability Resources Directory',
        description: 'Comprehensive directory of services and support for families of children with disabilities',
        categories: ['disability', 'special_needs', 'family_support'],
        source_type: 'directory'
      },
      {
        url: 'https://www.understood.org/en/school-learning/evaluations/evaluation-basics/evaluation-guide-for-learning-and-attention-issues',
        title: 'Understood.org - Learning & Attention Resources',
        description: 'Resources and guidance for families of children with learning and attention issues',
        categories: ['learning_disabilities', 'education', 'special_needs'],
        source_type: 'directory'
      }
    ];

    const { saveFundingSource } = await import('./_shared/saveFundingSource.js');
    for (const source of knownECFSources) {
      try {
        await saveFundingSource(sdk, {
          ...source,
          discovered_by: 'discoverECFSources',
          organization_id: organizationId,
          profile_id: profileId
        });
        result.saved++;
      } catch (err) {
        console.warn('[discoverECFSources] Failed to save known source:', err?.message);
      }
    }

    return Response.json({
      ok: true,
      ...result,
      message: `Discovered ${result.discovered} ECF sources, saved ${result.saved}`
    });

  } catch (error) {
    console.error('[discoverECFSources] Error:', error);
    return Response.json({ 
      ok: false, 
      error: error?.message ?? 'Discovery failed' 
    }, { status: 500 });
  }
});
