/**
 * Student Grants Crawler
 * Searches for student grants, endowments, FAFSA, CommonApp, and school financial aid
 * Based on test scores, background, interests, accomplishments
 * Excludes loans and matching funds
 */

import axios from 'axios'
import * as cheerio from 'cheerio'

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
  
  // Check if this is a student profile
  if (!isStudentProfile(profile)) {
    console.log('[StudentGrantsCrawler] Not a student profile, skipping')
    return results
  }
  
  const studentInfo = extractStudentInfo(profile)
  console.log(`[StudentGrantsCrawler] Searching for student: ${studentInfo.name || 'Unknown'}`)
  console.log(`[StudentGrantsCrawler] GPA: ${studentInfo.gpa}, SAT: ${studentInfo.sat}, ACT: ${studentInfo.act}`)
  
  // Search general scholarship databases
  for (const source of STUDENT_FUNDING_SOURCES) {
    try {
      const opportunities = await searchStudentSource(source, studentInfo, profile)
      
      for (const opp of opportunities) {
        // Skip loans
        if (isStudentLoan(opp)) continue
        
        const matchScore = calculateStudentMatchScore(opp, studentInfo, profile)
        
        if (matchScore >= 80) {
          results.push({
            ...opp,
            match_score: matchScore,
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
        
        for (const opp of schoolAid) {
          if (isStudentLoan(opp)) continue
          
          const matchScore = calculateStudentMatchScore(opp, studentInfo, profile)
          
          if (matchScore >= 80) {
            results.push({
              ...opp,
              match_score: matchScore,
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
  
  console.log(`[StudentGrantsCrawler] Found ${results.length} student opportunities with 80%+ match`)
  return results
}

function isStudentProfile(profile) {
  return profile.profile_type === 'student' ||
         profile.is_student === true ||
         profile.student_info !== undefined ||
         (profile.age && profile.age >= 14 && profile.age <= 25)
}

function extractStudentInfo(profile) {
  const info = {
    name: profile.name || profile.display_name,
    age: profile.age,
    gpa: profile.student_info?.gpa || profile.gpa,
    sat: profile.student_info?.sat_score || profile.sat,
    act: profile.student_info?.act_score || profile.act,
    interests: profile.interests || profile.focus_areas || [],
    accomplishments: profile.accomplishments || profile.achievements || [],
    background: profile.background || profile.demographics || {},
    financial_need: profile.financial_need || profile.efc, // Expected Family Contribution
    interested_schools: profile.student_info?.schools || profile.schools_of_interest || [],
    major: profile.student_info?.intended_major || profile.major,
    extracurriculars: profile.extracurriculars || [],
    zip: profile.student_info?.school_zip || profile.zip
  }
  
  return info
}

async function searchStudentSource(source, studentInfo, profile) {
  const opportunities = []
  
  if (source.type === 'scholarship_database') {
    // Build search criteria based on student info
    const searchCriteria = {
      gpa: studentInfo.gpa,
      sat: studentInfo.sat,
      act: studentInfo.act,
      state: profile.state,
      major: studentInfo.major,
      interests: studentInfo.interests
    }
    
    // Production: Must use real scholarship database APIs
    // No mock data generation in production
    throw new Error(
      `Real ${source.name} API integration required. ` +
      `Mock scholarship generation is disabled in production. ` +
      `Please implement actual API calls to ${source.baseUrl}`
    )
  } else if (source.name === 'FAFSA') {
    // FAFSA specific opportunities - these are real federal programs
    opportunities.push({
      title: 'Federal Pell Grant',
      sponsor: 'U.S. Department of Education',
      description: 'Need-based federal grant for undergraduate students',
      url: 'https://studentaid.gov/understand-aid/types/grants/pell',
      amount_min: 0,
      amount_max: 7395, // 2024-2025 maximum
      deadline: 'June 30, 2025',
      eligibility: 'Must demonstrate financial need, be a U.S. citizen or eligible noncitizen',
      grant_type: 'need_based'
    })
    
    opportunities.push({
      title: 'Federal Supplemental Educational Opportunity Grant (FSEOG)',
      sponsor: 'U.S. Department of Education',
      description: 'Federal grant for undergraduates with exceptional financial need',
      url: 'https://studentaid.gov/understand-aid/types/grants/fseog',
      amount_min: 100,
      amount_max: 4000,
      deadline: 'Varies by school',
      eligibility: 'Must be eligible for Pell Grant and have exceptional financial need',
      grant_type: 'need_based'
    })
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
    // Production: Must implement real scraping or API calls to school financial aid pages
    throw new Error(
      `Real school financial aid scraper required for ${schoolName}. ` +
      `Mock school scholarship generation is disabled in production. ` +
      `Please implement actual scraping/API calls to ${url}`
    )
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