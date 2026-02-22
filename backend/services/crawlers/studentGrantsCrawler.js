/**
 * Student Grants Crawler
 * Profile-Driven Discovery for scholarships, grants, and financial aid.
 *
 * DESIGN PRINCIPLE: Uses ALL profile signals (academics, demographics, health,
 * family, military, interests, occupation) to find every applicable scholarship
 * and grant. A student with cancer, who is a veteran's child, who is first-generation,
 * low-income, and interested in engineering should get results for ALL of those angles.
 *
 * SOURCES:
 * - Federal student aid (Pell Grant, FSEOG, TEACH, etc.) - real programs with real URLs
 * - Profile-driven scholarship discovery using signal-based search strategies
 * - School-specific financial aid links (when schools are listed)
 *
 * CRITICAL: Uses 100% of profile data via signals for search queries and scoring.
 */
import { buildSearchKeywords, calculateMatchScore, filterByDeadline } from './crawlerHelpers.js'
import { getWithRetry } from './httpClient.js'

/**
   * Real federal student aid programs. These are always available and always real.
   */
const FEDERAL_STUDENT_AID = [
  {
        title: 'Federal Pell Grant',
        sponsor: 'U.S. Department of Education',
        description: 'Need-based federal grant for undergraduate students. Maximum award is $7,395 per year. Does not need to be repaid.',
        url: 'https://studentaid.gov/understand-aid/types/grants/pell',
        amount_min: 0,
        amount_max: 7395,
        deadline: null,
        deadline_type: 'rolling',
        eligibility: 'Must demonstrate financial need, be a U.S. citizen or eligible noncitizen, be enrolled in an eligible degree program',
        is_national: true,
        keywords: ['pell', 'federal', 'need-based', 'undergraduate', 'student aid'],
        _requires: { financial_need: true },
  },
  {
        title: 'Federal Supplemental Educational Opportunity Grant (FSEOG)',
        sponsor: 'U.S. Department of Education',
        description: 'Federal grant for undergraduates with exceptional financial need. Priority goes to Pell Grant recipients. Up to $4,000 per year.',
        url: 'https://studentaid.gov/understand-aid/types/grants/fseog',
        amount_min: 100,
        amount_max: 4000,
        deadline_type: 'rolling',
        eligibility: 'Must be eligible for Pell Grant and have exceptional financial need',
        is_national: true,
        keywords: ['fseog', 'federal', 'need-based', 'undergraduate', 'exceptional need'],
        _requires: { financial_need: true },
  },
  {
        title: 'TEACH Grant',
        sponsor: 'U.S. Department of Education',
        description: 'Up to $4,000/year for students who intend to teach in high-need fields in low-income schools. Requires service agreement.',
        url: 'https://studentaid.gov/understand-aid/types/grants/teach',
        amount_min: 0,
        amount_max: 4000,
        deadline_type: 'rolling',
        eligibility: 'Must be enrolled in a TEACH Grant-eligible program and agree to teach in a high-need field',
        is_national: true,
        keywords: ['teach', 'teacher', 'education', 'high-need', 'low-income schools'],
        _requires: { interest_match: ['education', 'teacher', 'teaching'] },
  },
  {
        title: 'Iraq and Afghanistan Service Grant',
        sponsor: 'U.S. Department of Education',
        description: 'For students whose parent or guardian died as a result of military service in Iraq or Afghanistan after 9/11.',
        url: 'https://studentaid.gov/understand-aid/types/grants/iraq-afghanistan-service',
        amount_min: 0,
        amount_max: 7395,
        deadline_type: 'rolling',
        eligibility: 'Parent/guardian died as result of military service in Iraq/Afghanistan after 9/11',
        is_national: true,
        keywords: ['military', 'service', 'iraq', 'afghanistan', 'gold star'],
        _requires: { military: true },
  },
  {
        title: 'Federal Work-Study Program',
        sponsor: 'U.S. Department of Education',
        description: 'Part-time employment program for students with financial need. Provides jobs related to course of study when possible.',
        url: 'https://studentaid.gov/understand-aid/types/work-study',
        amount_min: 0,
        amount_max: 0,
        amount_description: 'Varies by school and need level',
        deadline_type: 'rolling',
        eligibility: 'Must demonstrate financial need, be enrolled at participating school',
        is_national: true,
        keywords: ['work study', 'employment', 'financial need', 'part-time'],
        _requires: { financial_need: true },
  },
  ]

/**
   * Real scholarship databases and search engines with profile-driven queries.
   * These are real websites where real scholarships are listed.
   */
const SCHOLARSHIP_SEARCH_SOURCES = [
  {
        name: 'Fastweb Scholarships',
        baseUrl: 'https://www.fastweb.com/college-scholarships',
        searchUrl: 'https://www.fastweb.com/college-scholarships/articles?page=1',
        type: 'scholarship_database',
  },
  {
        name: 'Scholarships.com',
        baseUrl: 'https://www.scholarships.com/financial-aid/college-scholarships/',
        type: 'scholarship_database',
  },
  {
        name: 'College Board Scholarship Search',
        baseUrl: 'https://bigfuture.collegeboard.org/scholarships',
        type: 'scholarship_database',
  },
  {
        name: 'Peterson\'s Scholarships',
        baseUrl: 'https://www.petersons.com/scholarship-search.aspx',
        type: 'scholarship_database',
  },
  {
        name: 'Cappex Scholarships',
        baseUrl: 'https://www.cappex.com/scholarships',
        type: 'scholarship_database',
  },
  ]

/**
   * Signal-specific scholarship sources. These are real organizations that offer
   * scholarships for specific demographics/situations.
   */
const SIGNAL_SPECIFIC_SCHOLARSHIPS = {
    first_generation: [
      {
              title: 'QuestBridge National College Match',
              sponsor: 'QuestBridge',
              description: 'Full four-year scholarships to top colleges for outstanding low-income high school seniors.',
              url: 'https://www.questbridge.org/high-school-students/national-college-match',
              keywords: ['first generation', 'low income', 'full scholarship'],
      },
      {
              title: 'Dell Scholars Program',
              sponsor: 'Michael & Susan Dell Foundation',
              description: 'Scholarships for underprivileged students who demonstrate a drive to succeed and a need for financial assistance.',
              url: 'https://www.dellscholars.org/',
              keywords: ['first generation', 'low income', 'scholarship'],
      },
        ],
    military: [
      {
              title: 'Pat Tillman Foundation Scholarship',
              sponsor: 'Pat Tillman Foundation',
              description: 'Scholarships for military service members, veterans, and their spouses pursuing higher education.',
              url: 'https://pattillmanfoundation.org/apply/',
              keywords: ['military', 'veteran', 'spouse', 'scholarship'],
      },
      {
              title: 'Folds of Honor Scholarship',
              sponsor: 'Folds of Honor',
              description: 'Educational scholarships for spouses and children of America\'s fallen and disabled service members.',
              url: 'https://www.foldsofhonor.org/scholarships/',
              keywords: ['military', 'veteran', 'fallen', 'disabled', 'family'],
      },
        ],
    disability: [
      {
              title: 'Google Lime Scholarship',
              sponsor: 'Google / Lime Connect',
              description: 'Scholarships for students with disabilities pursuing computer science or related degrees.',
              url: 'https://www.limeconnect.com/programs/page/google-lime-scholarship',
              keywords: ['disability', 'computer science', 'technology', 'scholarship'],
      },
      {
              title: 'National Federation of the Blind Scholarships',
              sponsor: 'National Federation of the Blind',
              description: 'Multiple scholarship programs for legally blind students across all fields of study.',
              url: 'https://nfb.org/programs-services/scholarships-and-awards',
              keywords: ['blind', 'visual impairment', 'disability', 'scholarship'],
      },
        ],
    african_american: [
      {
              title: 'United Negro College Fund (UNCF)',
              sponsor: 'UNCF',
              description: 'Scholarships and support for African American students and students attending HBCUs.',
              url: 'https://uncf.org/scholarships',
              keywords: ['african american', 'black', 'hbcu', 'scholarship'],
      },
      {
              title: 'Thurgood Marshall College Fund',
              sponsor: 'Thurgood Marshall College Fund',
              description: 'Scholarships and career readiness support for students at HBCUs and PBIs.',
              url: 'https://www.tmcf.org/our-scholarships/',
              keywords: ['african american', 'hbcu', 'scholarship'],
      },
        ],
    hispanic_latino: [
      {
              title: 'Hispanic Scholarship Fund',
              sponsor: 'Hispanic Scholarship Fund',
              description: 'Scholarships for Hispanic American students of all majors and grade levels.',
              url: 'https://www.hsf.net/scholarship',
              keywords: ['hispanic', 'latino', 'latina', 'scholarship'],
      },
        ],
    native_american: [
      {
              title: 'American Indian College Fund',
              sponsor: 'American Indian College Fund',
              description: 'Scholarships for Native American and Alaska Native students attending tribal colleges and mainstream institutions.',
              url: 'https://collegefund.org/students/scholarships/',
              keywords: ['native american', 'indigenous', 'tribal', 'scholarship'],
      },
        ],
    lgbtq: [
      {
              title: 'Point Foundation Scholarship',
              sponsor: 'Point Foundation',
              description: 'Scholarships, mentoring, and leadership training for LGBTQ+ students.',
              url: 'https://pointfoundation.org/point-apply/',
              keywords: ['lgbtq', 'queer', 'transgender', 'scholarship'],
      },
        ],
    cancer: [
      {
              title: 'Cancer for College Scholarship',
              sponsor: 'Cancer for College',
              description: 'Scholarships for current and former cancer patients and cancer survivors.',
              url: 'https://www.cancerforcollege.org/',
              keywords: ['cancer', 'survivor', 'scholarship'],
      },
        ],
    foster_youth: [
      {
              title: 'Foster Care to Success Scholarships',
              sponsor: 'Foster Care to Success',
              description: 'Scholarships and support for current and former foster youth pursuing education.',
              url: 'https://www.fc2success.org/',
              keywords: ['foster youth', 'foster care', 'scholarship'],
      },
        ],
    single_parent: [
      {
              title: 'Raise the Nation Scholarship',
              sponsor: 'Raise the Nation',
              description: 'Scholarships for single parents pursuing higher education.',
              url: 'https://www.raisethenation.org/',
              keywords: ['single parent', 'scholarship', 'education'],
      },
        ],
    women: [
      {
              title: 'Jeannette Rankin Women\'s Scholarship Fund',
              sponsor: 'Jeannette Rankin Foundation',
              description: 'Scholarships for women 35 and older pursuing technical/vocational training or undergraduate education.',
              url: 'https://rankinfoundation.org/',
              keywords: ['women', 'female', 'nontraditional', 'scholarship'],
      },
        ],
}

export async function crawlStudentGrants(profile, options = {}) {
    const results = []
        const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 60

  const signals = profile?.signals
    if (!signals) {
          console.error('[StudentGrantsCrawler] No signals in profile - cannot search')
          return results
    }

  // Check if this is a student profile
  if (!isStudentProfile(profile)) {
        console.log('[StudentGrantsCrawler] Not a student profile, skipping')
        return results
  }

  const searchKeywords = buildSearchKeywords(profile, 25)

  console.log(`[StudentGrantsCrawler] Student profile detected`)
    console.log(`[StudentGrantsCrawler] Academics: GPA=${signals.academics?.gpa}, SAT=${signals.academics?.sat}, ACT=${signals.academics?.act}`)
    console.log(`[StudentGrantsCrawler] Interests: ${Array.from(signals.interests || []).slice(0, 5).join(', ')}`)
    console.log(`[StudentGrantsCrawler] Demographics: ${Array.from(signals.demographics || []).join(', ')}`)
    console.log(`[StudentGrantsCrawler] Health: ${Array.from(signals.health || []).join(', ')}`)
    console.log(`[StudentGrantsCrawler] Family: ${Array.from(signals.family || []).join(', ')}`)
    console.log(`[StudentGrantsCrawler] Military: ${Array.from(signals.military || []).join(', ')}`)
    console.log(`[StudentGrantsCrawler] Using ${searchKeywords.length} keywords from profile signals`)

  const seenUrls = new Set()

  // === 1. FEDERAL STUDENT AID (always real, always available) ===
  for (const aid of FEDERAL_STUDENT_AID) {
        // Check requirements
      if (aid._requires?.financial_need) {
              const hasNeed = signals.assistance?.has('low_income') ||
                        signals.financial?.needLevel === 'High' ||
                        signals.financial?.needLevel === 'Critical' ||
                        signals.financial?.needLevel === 'Extreme' ||
                        signals.assistance?.has('high_financial_need')
              if (!hasNeed) continue
      }
        if (aid._requires?.military) {
                if (!signals.military?.size) continue
        }
        if (aid._requires?.interest_match) {
                const interests = Array.from(signals.interests || []).map(i => i.toLowerCase())
                const keywords = Array.from(signals.keywordSet || []).map(k => k.toLowerCase())
                const all = [...interests, ...keywords]
                const matches = aid._requires.interest_match.some(req => all.some(i => i.includes(req)))
                if (!matches) continue
        }

      if (seenUrls.has(aid.url)) continue
        seenUrls.add(aid.url)

      const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(aid, profile)

      // Federal aid bonus - these are real, substantial programs
      const adjustedScore = Math.min(100, matchScore + 10)
        if (adjustedScore >= minMatchScore) {
                results.push({
                          ...aid,
                          match_score: adjustedScore,
                          match_reasons: [...reasons, 'Federal student aid program'],
                          matched_signals: matchedSignals,
                          crawler_type: 'student_grants',
                          source: 'Federal Student Aid',
                })
        }
  }

  // === 2. SIGNAL-SPECIFIC SCHOLARSHIPS ===
  // For every applicable signal, include matching scholarships
  const demographicSignals = Array.from(signals.demographics || [])
    const healthSignals = Array.from(signals.health || [])
    const familySignals = Array.from(signals.family || [])
    const genderSignals = Array.from(signals.genders || [])

  // Map signal values to scholarship categories
  const signalCategoryMap = {
        first_generation: demographicSignals.includes('first_generation'),
        military: (signals.military?.size || 0) > 0,
        disability: healthSignals.some(h => h.includes('disability') || h.includes('wheelchair') || h.includes('impair') || h.includes('blind') || h.includes('deaf')),
        african_american: demographicSignals.includes('african_american'),
        hispanic_latino: demographicSignals.includes('hispanic_latino'),
        native_american: demographicSignals.includes('native_american'),
        lgbtq: demographicSignals.includes('lgbtq'),
        cancer: healthSignals.some(h => h.includes('cancer')),
        foster_youth: familySignals.includes('foster_youth'),
        single_parent: familySignals.includes('single_parent'),
        women: genderSignals.includes('female'),
  }

  for (const [category, isApplicable] of Object.entries(signalCategoryMap)) {
        if (!isApplicable) continue

      const scholarships = SIGNAL_SPECIFIC_SCHOLARSHIPS[category] || []
            for (const scholarship of scholarships) {
                    if (seenUrls.has(scholarship.url)) continue
                    seenUrls.add(scholarship.url)

          const opp = {
                    ...scholarship,
                    amount_min: 0,
                    amount_max: 0,
                    amount_description: 'See source for award details',
                    deadline: null,
                    deadline_type: 'rolling',
                    eligibility: `See ${scholarship.sponsor} website for full eligibility criteria`,
                    is_national: true,
                    categories: ['scholarship', category],
                    opportunity_type: 'scholarship',
          }

          const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profile)

          // Signal-specific bonus: we know this matches the student's profile
          const adjustedScore = Math.min(100, matchScore + 15)
                    if (adjustedScore >= minMatchScore) {
                              results.push({
                                          ...opp,
                                          match_score: adjustedScore,
                                          match_reasons: [...reasons, `Signal-specific scholarship: ${category.replace(/_/g, ' ')}`],
                                          matched_signals: matchedSignals,
                                          crawler_type: 'student_grants',
                                          source: scholarship.sponsor,
                              })
                    }
            }
  }

  // === 3. SCHOLARSHIP DATABASE LINKS ===
  // Provide links to major scholarship search engines with profile context
  for (const source of SCHOLARSHIP_SEARCH_SOURCES) {
        if (seenUrls.has(source.baseUrl)) continue
        seenUrls.add(source.baseUrl)

      const opp = {
              title: `${source.name} — Search scholarships matching your profile`,
              sponsor: source.name,
              description: `Search ${source.name} for scholarships matching your academic profile, demographics, interests, and financial need.`,
              url: source.baseUrl,
              application_url: source.baseUrl,
              source_url: source.baseUrl,
              amount_min: 0,
              amount_max: 0,
              deadline: null,
              deadline_type: 'rolling',
              eligibility: 'Varies by scholarship',
              is_national: true,
              categories: ['scholarship_database'],
              keywords: ['scholarship', 'search', 'database', ...searchKeywords.slice(0, 5)],
              opportunity_type: 'directory',
      }

      const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profile)

      results.push({
              ...opp,
              match_score: Math.max(minMatchScore, matchScore),
              match_reasons: [...reasons, 'Scholarship search engine'],
              matched_signals: matchedSignals,
              crawler_type: 'student_grants',
              source: source.name,
              is_directory_resource: true,
              record_origin: 'directory:student_grants',
      })
  }

  // === 4. SCHOOL-SPECIFIC FINANCIAL AID ===
  const sections = profile?.sections || signals.rawSections || {}
      const universityApps = sections?.university_applications?.applications || []
          const interestedSchools = universityApps.map(app => app.name).filter(Boolean)

  for (const school of interestedSchools) {
        const schoolUrl = getSchoolFinAidUrl(school)
        if (!schoolUrl || seenUrls.has(schoolUrl)) continue
        seenUrls.add(schoolUrl)

      const opp = {
              title: `${school} — Financial Aid & Scholarships`,
              sponsor: school,
              description: `Financial aid and scholarship information for ${school}. Check for school-specific scholarships, grants, and aid packages.`,
              url: schoolUrl,
              application_url: schoolUrl,
              source_url: schoolUrl,
              amount_min: 0,
              amount_max: 0,
              deadline: null,
              deadline_type: 'rolling',
              eligibility: 'Varies by program',
              is_national: true,
              categories: ['school_specific', 'financial_aid'],
              keywords: ['financial aid', 'scholarship', school.toLowerCase()],
              opportunity_type: 'program',
      }

      const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profile)

      // School-specific bonus
      const adjustedScore = Math.min(100, matchScore + 10)
        if (adjustedScore >= minMatchScore) {
                results.push({
                          ...opp,
                          match_score: adjustedScore,
                          match_reasons: [...reasons, `School-specific: ${school}`],
                          matched_signals: matchedSignals,
                          crawler_type: 'student_grants',
                          source: `${school} Financial Aid`,
                          school_specific: true,
                })
        }
  }

  // Sort by match score
  results.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

  console.log(`[StudentGrantsCrawler] Found ${results.length} student opportunities with ${minMatchScore}%+ match`)
    return results
}

function isStudentProfile(profile) {
    const signals = profile?.signals
    const applicantTypes = signals?.applicantTypes ? Array.from(signals.applicantTypes) : []

        const studentTypes = ['student', 'high_school_student', 'college_student', 'graduate_student']
    if (applicantTypes.some(t => studentTypes.includes(t))) return true
    if (studentTypes.includes(profile.primary_type)) return true
    if (signals?.academics?.gpa || signals?.academics?.sat || signals?.academics?.act) return true

  return profile.profile_type === 'student' ||
        profile.is_student === true ||
        profile.student_info !== undefined
}

function getSchoolFinAidUrl(schoolName) {
    const schoolUrls = {
          'Ohio State University': 'https://sfa.osu.edu',
          'University of Cincinnati': 'https://financialaid.uc.edu',
          'Case Western Reserve University': 'https://case.edu/financialaid',
          'University of Tennessee': 'https://onestop.utk.edu/financial-aid/',
          'Vanderbilt University': 'https://www.vanderbilt.edu/financialaid/',
          'University of Michigan': 'https://finaid.umich.edu/',
          'MIT': 'https://sfs.mit.edu/',
          'Stanford University': 'https://financialaid.stanford.edu/',
          'Harvard University': 'https://college.harvard.edu/financial-aid',
    }

  // Direct lookup
  if (schoolUrls[schoolName]) return schoolUrls[schoolName]

  // Partial match
  const lower = schoolName.toLowerCase()
    for (const [name, url] of Object.entries(schoolUrls)) {
          if (lower.includes(name.toLowerCase()) || name.toLowerCase().includes(lower)) {
                  return url
          }
    }

  return null
}

function isStudentLoan(opportunity) {
    const loanKeywords = [
          'loan', 'repay', 'interest', 'apr', 'subsidized', 'unsubsidized',
          'plus loan', 'private loan', 'student loan', 'borrow'
        ]
    const text = `${opportunity.title} ${opportunity.description} ${opportunity.eligibility}`.toLowerCase()
    return loanKeywords.some(keyword => text.includes(keyword))
}

export default { crawlStudentGrants }
