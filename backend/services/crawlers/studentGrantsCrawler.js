/**
 * Student Grants Crawler
 * Searches for student grants, endowments, FAFSA, CommonApp, and school financial aid
 * Based on test scores, background, interests, accomplishments
 * Excludes loans and matching funds
 * 
 * CRITICAL: Uses 100% of profile data via signals for search queries and scoring.
 */

import axios from 'axios'
import * as cheerio from 'cheerio'
import { buildSearchKeywords, calculateMatchScore, filterByDeadline } from './crawlerHelpers.js'
import { extractStudentCampusZip } from '../profileHelpers.js'

const STUDENT_FUNDING_SOURCES = [
  {
    name: 'FAFSA',
    baseUrl: 'https://studentaid.gov/h/apply-for-aid/fafsa',
    type: 'federal_aid'
  },
  {
    name: 'College Board Scholarship Search',
    baseUrl: 'https://bigfuture.collegeboard.org/scholarships/scholarship-search',
    type: 'scholarship_database'
  },
  {
    name: 'Fastweb',
    baseUrl: 'https://www.fastweb.com/college-scholarships',
    type: 'scholarship_database'
  },
  {
    name: 'Scholarships.com',
    baseUrl: 'https://www.scholarships.com',
    type: 'scholarship_database'
  },
  {
    name: 'CommonApp',
    baseUrl: 'https://www.commonapp.org',
    type: 'application_portal'
  }
]

export async function crawlStudentGrants(profile, options = {}) {
  const results = []
  const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 50
  
  // CRITICAL: Use signals for all profile data
  const signals = profile?.signals
  if (!signals) {
    console.error('[StudentGrantsCrawler] No signals in profile - cannot search with 100% precision')
    return results
  }
  
  // Check if this is a student profile using signals
  if (!isStudentProfile(profile)) {
    console.log('[StudentGrantsCrawler] Not a student profile (based on signals), skipping')
    return results
  }
  
  // Build search keywords from ALL profile signals
  const searchKeywords = buildSearchKeywords(profile, 25)
  
  // Extract student info from signals
  const studentInfo = extractStudentInfo(profile)
  
  console.log(`[StudentGrantsCrawler] Searching for student: ${studentInfo.name || 'Unknown'}`)
  console.log(`[StudentGrantsCrawler] Academic signals: GPA=${signals.academics?.gpa}, SAT=${signals.academics?.sat}, ACT=${signals.academics?.act}`)
  console.log(`[StudentGrantsCrawler] Interests: ${Array.from(signals.interests || []).slice(0, 5).join(', ')}`)
  console.log(`[StudentGrantsCrawler] Demographics: ${Array.from(signals.demographics || []).join(', ')}`)
  console.log(`[StudentGrantsCrawler] Using ${searchKeywords.length} keywords from profile signals`)
  
  // Search general scholarship databases
  for (const source of STUDENT_FUNDING_SOURCES) {
    try {
      const opportunities = await searchStudentSource(source, studentInfo, profile, searchKeywords)
      
      // Filter out expired deadlines
      const activeOpps = filterByDeadline(opportunities)
      
      for (const opp of activeOpps) {
        // Skip loans
        if (isStudentLoan(opp)) continue
        
        // Use comprehensive scoring with 100% of profile signals
        const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profile)
        
        // Add GPA/test score bonuses from signals.academics
        let adjustedScore = matchScore
        if (signals.academics?.gpa && signals.academics.gpa >= 3.5) {
          adjustedScore += 5
          reasons.push(`High GPA: ${signals.academics.gpa}`)
        }
        if (signals.academics?.sat && signals.academics.sat >= 1200) {
          adjustedScore += 5
          reasons.push(`Strong SAT: ${signals.academics.sat}`)
        }
        if (signals.academics?.act && signals.academics.act >= 25) {
          adjustedScore += 5
          reasons.push(`Strong ACT: ${signals.academics.act}`)
        }
        
        if (adjustedScore >= minMatchScore) {
          results.push({
            ...opp,
            match_score: Math.min(100, adjustedScore),
            match_reasons: reasons,
            matched_signals: matchedSignals,
            crawler_type: 'student_grants',
            source: source.name
          })
        }
      }
    } catch (error) {
      console.error(`[StudentGrantsCrawler] Error searching ${source.name}:`, error.message)
    }
  }
  
  // Search specific school financial aid if schools are listed
  if (studentInfo.interested_schools && studentInfo.interested_schools.length > 0) {
    for (const school of studentInfo.interested_schools) {
      try {
        const schoolAid = await searchSchoolFinancialAid(school, studentInfo, profile)
        const activeAid = filterByDeadline(schoolAid)
        
        for (const opp of activeAid) {
          if (isStudentLoan(opp)) continue
          
          const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profile)
          
          // School-specific bonus
          const adjustedScore = matchScore + 10
          
          if (adjustedScore >= minMatchScore) {
            results.push({
              ...opp,
              match_score: Math.min(100, adjustedScore),
              match_reasons: [...reasons, `School-specific: ${school}`],
              matched_signals: matchedSignals,
              crawler_type: 'student_grants',
              source: `${school} Financial Aid`,
              school_specific: true
            })
          }
        }
      } catch (error) {
        console.error(`[StudentGrantsCrawler] Error searching ${school} aid:`, error.message)
      }
    }
  }
  
  console.log(`[StudentGrantsCrawler] Found ${results.length} student opportunities with ${minMatchScore}%+ match`)
  return results
}

function isStudentProfile(profile) {
  const signals = profile?.signals
  const applicantTypes = signals?.applicantTypes ? Array.from(signals.applicantTypes) : []
  
  // Check applicant types from signals
  const studentTypes = ['student', 'high_school_student', 'college_student', 'graduate_student']
  if (applicantTypes.some(t => studentTypes.includes(t))) {
    return true
  }
  
  // Check profile primary_type
  if (studentTypes.includes(profile.primary_type)) {
    return true
  }
  
  // Check for academic signals
  if (signals?.academics?.gpa || signals?.academics?.sat || signals?.academics?.act) {
    return true
  }
  
  // Legacy checks
  return profile.profile_type === 'student' ||
         profile.is_student === true ||
         profile.student_info !== undefined
}

function extractStudentInfo(profile) {
  const signals = profile?.signals
  const sections = profile?.sections || signals?.rawSections || {}
  const education = sections?.education || {}
  const universityApps = sections?.university_applications?.applications || []
  
  // Extract interests from signals
  const interests = signals?.interests ? Array.from(signals.interests) : []
  
  // Extract schools from university_applications section
  const interested_schools = universityApps.map(app => app.name).filter(Boolean)
  
  // Extract major from university_applications or education
  const major = universityApps.find(app => app.intended_major)?.intended_major || 
                education.field_of_study || 
                education.intended_major
  
  const info = {
    name: profile.name || profile.display_name,
    age: profile.age,
    // Use academic signals (extracted from all profile sections)
    gpa: signals?.academics?.gpa || profile.student_info?.gpa || profile.gpa,
    sat: signals?.academics?.sat || profile.student_info?.sat_score || profile.sat,
    act: signals?.academics?.act || profile.student_info?.act_score || profile.act,
    interests: interests.length > 0 ? interests : (profile.interests || profile.focus_areas || []),
    accomplishments: profile.accomplishments || profile.achievements || [],
    // Use demographic signals
    background: signals?.demographics ? Array.from(signals.demographics) : [],
    financial_need: signals?.financial?.needLevel === 'High' || 
                    signals?.financial?.needLevel === 'Critical' ||
                    signals?.assistance?.has('low_income'),
    interested_schools: interested_schools.length > 0 ? interested_schools : (profile.student_info?.schools || []),
    major: major || profile.student_info?.intended_major || profile.major,
    extracurriculars: profile.extracurriculars || [],
    zip:
      extractStudentCampusZip({ sections, jobParameters: {} }) ||
      signals?.location?.zip ||
      profile.student_info?.school_zip ||
      profile.zip,
    // Include first-generation status from signals
    first_generation: signals?.demographics?.has('first_generation') || false,
  }
  
  return info
}

async function searchStudentSource(source, studentInfo, profile, searchKeywords = []) {
  const opportunities = []
  const signals = profile?.signals
  
  if (source.type === 'scholarship_database') {
    // Build search criteria based on student info AND full profile signals
    const searchCriteria = {
      gpa: studentInfo.gpa,
      sat: studentInfo.sat,
      act: studentInfo.act,
      state: signals?.location?.state || profile.state,
      major: studentInfo.major,
      interests: studentInfo.interests,
      keywords: searchKeywords,
      demographics: signals?.demographics ? Array.from(signals.demographics) : [],
      first_generation: studentInfo.first_generation,
    }
    
    console.log(`[StudentGrantsCrawler] Searching ${source.name} with criteria:`, JSON.stringify(searchCriteria, null, 2))
    
    // Note: In production, implement actual API calls to scholarship databases
    // For now, return empty to indicate no real API integration yet
    console.warn(`[StudentGrantsCrawler] ${source.name} requires real API integration`)
  } else if (source.name === 'FAFSA') {
    // FAFSA specific opportunities - these are real federal programs
    opportunities.push({
      title: 'Federal Pell Grant',
      sponsor: 'U.S. Department of Education',
      description: 'Need-based federal grant for undergraduate students. Maximum award for 2024-2025 is $7,395.',
      url: 'https://studentaid.gov/understand-aid/types/grants/pell',
      amount_min: 0,
      amount_max: 7395,
      deadline: '2025-06-30',
      deadline_type: 'fixed',
      eligibility: 'Must demonstrate financial need, be a U.S. citizen or eligible noncitizen, be enrolled in an eligible degree program',
      grant_type: 'need_based',
      is_national: true,
      keywords: ['pell', 'federal', 'need-based', 'undergraduate', 'student aid'],
    })
    
    opportunities.push({
      title: 'Federal Supplemental Educational Opportunity Grant (FSEOG)',
      sponsor: 'U.S. Department of Education',
      description: 'Federal grant for undergraduates with exceptional financial need. Priority goes to Pell Grant recipients.',
      url: 'https://studentaid.gov/understand-aid/types/grants/fseog',
      amount_min: 100,
      amount_max: 4000,
      deadline_type: 'rolling',
      eligibility: 'Must be eligible for Pell Grant and have exceptional financial need',
      grant_type: 'need_based',
      is_national: true,
      keywords: ['fseog', 'federal', 'need-based', 'undergraduate', 'exceptional need'],
    })
    
    // Add TEACH Grant for students in teacher education programs
    if (searchKeywords.some(kw => kw.includes('education') || kw.includes('teacher') || kw.includes('teaching'))) {
      opportunities.push({
        title: 'TEACH Grant',
        sponsor: 'U.S. Department of Education',
        description: 'Grants for students who intend to teach in high-need fields in low-income schools.',
        url: 'https://studentaid.gov/understand-aid/types/grants/teach',
        amount_min: 0,
        amount_max: 4000,
        deadline_type: 'rolling',
        eligibility: 'Must be enrolled in a TEACH Grant-eligible program and agree to teach in a high-need field',
        grant_type: 'service_conditional',
        is_national: true,
        keywords: ['teach', 'teacher', 'education', 'high-need', 'low-income schools'],
      })
    }
    
    // Add Iraq/Afghanistan Service Grant for students whose parent died in military service
    if (signals?.military?.size > 0 || signals?.family?.has('gold_star_family')) {
      opportunities.push({
        title: 'Iraq and Afghanistan Service Grant',
        sponsor: 'U.S. Department of Education',
        description: 'For students whose parent or guardian died as a result of military service in Iraq or Afghanistan.',
        url: 'https://studentaid.gov/understand-aid/types/grants/iraq-afghanistan-service',
        amount_min: 0,
        amount_max: 7395,
        deadline_type: 'rolling',
        eligibility: 'Parent/guardian died as result of military service in Iraq/Afghanistan after 9/11',
        grant_type: 'service',
        is_national: true,
        keywords: ['military', 'service', 'iraq', 'afghanistan', 'gold star'],
      })
    }
  }
  
  return opportunities
}

async function searchSchoolFinancialAid(schoolName, studentInfo, profile) {
  const opportunities = []
  
  // Map school names to their financial aid URLs
  const schoolFinAidUrls = {
    'Ohio State University': 'https://sfa.osu.edu',
    'University of Cincinnati': 'https://financialaid.uc.edu',
    'Case Western Reserve University': 'https://case.edu/financialaid',
    // Add more schools
  }
  
  const url = schoolFinAidUrls[schoolName]
  if (url) {
    // Previously this threw and caused `/api/real-crawlers/run` to return 500.
    // We can return a *real* link-only opportunity (no scraped claims) instead.
    opportunities.push({
      title: `${schoolName} — Financial Aid & Scholarships`,
      sponsor: schoolName,
      description:
        'Financial aid and scholarship information (link only). Detailed scholarship extraction is not implemented yet.',
      url,
      amount_min: 0,
      amount_max: 0,
      deadline_type: 'rolling',
      eligibility: 'See the linked page for eligibility details.',
      is_national: true,
      keywords: ['financial aid', 'scholarship', 'tuition', 'student aid'],
    })
  }
  
  return opportunities
}

// Remove mock scholarship generation function - not allowed in production
// function generateScholarshipOpportunities() removed

function calculateStudentMatchScore(opportunity, studentInfo, profile) {
  let score = 60 // Base score
  
  // GPA match
  if (opportunity.eligibility?.includes('GPA') || opportunity.eligibility?.includes('gpa')) {
    const requiredGPA = extractGPA(opportunity.eligibility)
    if (requiredGPA && studentInfo.gpa >= requiredGPA) {
      score += 20
    } else if (requiredGPA && studentInfo.gpa < requiredGPA) {
      return 0 // Doesn't meet minimum requirement
    }
  }
  
  // Test score match
  if (opportunity.eligibility?.includes('SAT') || opportunity.eligibility?.includes('ACT')) {
    const requiredSAT = extractSAT(opportunity.eligibility)
    const requiredACT = extractACT(opportunity.eligibility)
    
    if ((requiredSAT && studentInfo.sat >= requiredSAT) || 
        (requiredACT && studentInfo.act >= requiredACT)) {
      score += 20
    }
  }
  
  // School-specific bonus
  if (opportunity.school_specific && studentInfo.interested_schools?.includes(opportunity.sponsor)) {
    score += 15
  }
  
  // Major/interest match
  const oppText = `${opportunity.title} ${opportunity.description}`.toLowerCase()
  if (studentInfo.major && oppText.includes(studentInfo.major.toLowerCase())) {
    score += 15
  }
  
  // Financial need match
  if (opportunity.grant_type === 'need_based' && studentInfo.financial_need) {
    score += 10
  }
  
  // Interest alignment
  const matchedInterests = studentInfo.interests?.filter(interest => 
    oppText.includes(interest.toLowerCase())
  ) || []
  
  if (matchedInterests.length > 0) {
    score += Math.min(15, matchedInterests.length * 5)
  }
  
  return Math.min(100, Math.round(score))
}

function isStudentLoan(opportunity) {
  const loanKeywords = [
    'loan', 'repay', 'interest', 'apr', 'subsidized', 'unsubsidized',
    'plus loan', 'private loan', 'student loan', 'borrow'
  ]
  
  const text = `${opportunity.title} ${opportunity.description} ${opportunity.eligibility}`.toLowerCase()
  
  return loanKeywords.some(keyword => text.includes(keyword))
}

function extractGPA(text) {
  const gpaMatch = text.match(/(\d+\.\d+)\s*GPA/i)
  return gpaMatch ? parseFloat(gpaMatch[1]) : null
}

function extractSAT(text) {
  const satMatch = text.match(/SAT\s*(\d{3,4})/i)
  return satMatch ? parseInt(satMatch[1]) : null
}

function extractACT(text) {
  const actMatch = text.match(/ACT\s*(\d{1,2})/i)
  return actMatch ? parseInt(actMatch[1]) : null
}

export default { crawlStudentGrants }