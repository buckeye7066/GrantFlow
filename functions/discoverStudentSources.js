import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { createSafeServer } from './_shared/safeHandler.js';
import { discoverAndSaveSources } from './_shared/crawlerFramework.js';

/**
 * Discover student-specific funding sources
 * Focuses on scholarships, student grants, and educational funding
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

    // Check if profile is for a student
    const applicantType = profile.applicant_type || '';
    const isStudent = applicantType.includes('student');

    if (!isStudent) {
      return Response.json({
        ok: true,
        message: 'Profile is not for a student',
        discovered: 0,
        saved: 0
      });
    }

    // Create student-focused profile for searching
    const studentProfile = {
      ...profile,
      focus_areas: [
        ...(profile.focus_areas || []),
        'scholarships',
        'student aid',
        'educational grants'
      ],
      keywords: [
        ...(profile.keywords || []),
        applicantType,
        'scholarship',
        'student grants',
        profile.intended_major || '',
        profile.first_generation ? 'first generation' : '',
        'college funding'
      ].filter(k => k)
    };

    // Discover and save student sources
    const result = await discoverAndSaveSources(sdk, {
      profile: studentProfile,
      profileId,
      organizationId,
      crawlerName: 'discoverStudentSources',
      options: {
        maxQueries: 5,
        maxResultsPerQuery: 5
      }
    });

    // Add known student funding sources
    const knownStudentSources = [
      {
        url: 'https://www.scholarships.com',
        title: 'Scholarships.com - Student Scholarship Database',
        description: 'Large database of scholarships, grants, and financial aid for students',
        categories: ['scholarships', 'student_aid', 'education'],
        source_type: 'directory'
      },
      {
        url: 'https://www.fastweb.com',
        title: 'Fastweb - Scholarship Search',
        description: 'Personalized scholarship matching and college search',
        categories: ['scholarships', 'student_aid', 'college'],
        source_type: 'directory'
      },
      {
        url: 'https://studentaid.gov',
        title: 'Federal Student Aid',
        description: 'Official U.S. government source for federal student aid information',
        categories: ['federal', 'student_aid', 'government'],
        source_type: 'government'
      }
    ];

    // Add college-specific sources if target colleges are specified
    if (profile.target_colleges && Array.isArray(profile.target_colleges)) {
      for (const college of profile.target_colleges.slice(0, 3)) {
        const collegeName = college.toLowerCase().replace(/\s+/g, '-');
        knownStudentSources.push({
          url: `https://www.${collegeName}.edu/financial-aid`,
          title: `${college} - Financial Aid & Scholarships`,
          description: `Scholarship and financial aid opportunities at ${college}`,
          categories: ['scholarships', 'college', 'institutional_aid'],
          source_type: 'university',
          metadata: { college_name: college, url_generated: true }
        });
      }
    }

    const { saveFundingSource } = await import('./_shared/saveFundingSource.js');
    for (const source of knownStudentSources) {
      try {
        await saveFundingSource(sdk, {
          ...source,
          discovered_by: 'discoverStudentSources',
          organization_id: organizationId,
          profile_id: profileId
        });
        result.saved++;
      } catch (err) {
        console.warn('[discoverStudentSources] Failed to save known source:', err?.message);
      }
    }

    return Response.json({
      ok: true,
      ...result,
      message: `Discovered ${result.discovered} student sources, saved ${result.saved}`
    });

  } catch (error) {
    console.error('[discoverStudentSources] Error:', error);
    return Response.json({ 
      ok: false, 
      error: error?.message ?? 'Discovery failed' 
    }, { status: 500 });
  }
});
