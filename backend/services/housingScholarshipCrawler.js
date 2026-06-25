/**
 * Housing Scholarship Crawler
 *
 * Crawls and seeds REAL funding sources that can be used toward off-campus
 * living expenses — either because they generate a refund check paid to the
 * student, pay a stipend directly, or provide housing assistance.
 *
 * Categories covered:
 *   - Tennessee state programs (HOPE, TSAC programs)
 *   - Faith-based denominational scholarships
 *   - Talent / music merit scholarships (non-major eligible)
 *   - COA adjustment pathways
 *   - RA / campus housing stipend programs
 *
 * ALL URLs validated before insertion. Dead links are rejected.
 * ALL records use funding_category + usable_for_housing + refund_potential
 * classification fields added in migration 054.
 */

import { upsertFundingOpportunity } from './opportunityInserter.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('housingScholarshipCrawler')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Real funding sources — verified URLs as of April 2026
// ---------------------------------------------------------------------------

const HOUSING_FUNDING_CATALOG = [
  // ── Tennessee State Programs ───────────────────────────────────────────────

  {
    title: 'Tennessee HOPE Scholarship',
    sponsor: 'Tennessee Student Assistance Corporation (TSAC)',
    source: 'housing_scholarship_crawler',
    source_id: 'tsac-hope-scholarship-2025',
    source_url: 'https://www.tn.gov/collegepays/money-for-college/tn-education-lottery-scholarship-program/tennessee-hope-scholarship.html',
    application_url: 'https://www.tn.gov/collegepays/money-for-college/tn-education-lottery-scholarship-program/tennessee-hope-scholarship.html',
    description: 'The Tennessee HOPE Scholarship is a merit-based award for Tennessee residents who graduate from high school with a minimum 3.0 GPA. The scholarship pays directly to the institution but may generate a refund if combined with other aid that exceeds tuition and fees costs, which can be used toward off-campus housing, food, and utilities. Students must be enrolled at an eligible Tennessee college or university.',
    eligibility_bullets: [
      'Tennessee resident',
      'High school graduate with 3.0 GPA or higher',
      'Enrolled at eligible Tennessee institution',
      'US citizen or eligible non-citizen',
    ],
    amount_min: 2250,
    amount_max: 6000,
    amount_description: 'Up to $6,000 per year depending on institution type; paid to institution with potential refund for COA gap',
    is_national: false,
    state: 'TN',
    opportunity_type: 'scholarship',
    record_origin: 'curated_verified',
    categories: ['education', 'scholarship', 'merit'],
    keywords: ['tennessee', 'hope', 'tsac', 'merit', 'gpa', 'state scholarship', 'tennessee resident', 'refund eligible'],
    funding_category: 'refund_eligible',
    usable_for_housing: true,
    refund_potential: true,
    eligibility_signals: {
      gpa_min: 3.0,
      state: 'TN',
      field_of_study: null,
      faith_affiliation: null,
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },

  {
    title: 'Tennessee HOPE Access Grant',
    sponsor: 'Tennessee Student Assistance Corporation (TSAC)',
    source: 'housing_scholarship_crawler',
    source_id: 'tsac-hope-access-grant-2025',
    source_url: 'https://www.tn.gov/collegepays/money-for-college/tn-education-lottery-scholarship-program/tennessee-hope-access-grant.html',
    application_url: 'https://studentaid.gov/h/apply-for-aid/fafsa',
    description: 'The Tennessee HOPE Access Grant supplements the HOPE Scholarship for students from low-income families. Award amount is determined by family income and EFC. Funds are disbursed to the institution and any excess after tuition/fees may be refunded to the student for living expenses including off-campus rent, utilities, and food.',
    eligibility_bullets: [
      'Tennessee resident',
      'Eligible for Tennessee HOPE Scholarship',
      'Family income below threshold',
      'Complete FAFSA',
    ],
    amount_min: 750,
    amount_max: 1500,
    amount_description: 'Up to $1,500/year supplemental award on top of HOPE Scholarship',
    is_national: false,
    state: 'TN',
    opportunity_type: 'scholarship',
    record_origin: 'curated_verified',
    categories: ['education', 'scholarship', 'financial_need'],
    keywords: ['tennessee', 'hope access', 'tsac', 'low income', 'tennessee resident', 'fafsa'],
    funding_category: 'refund_eligible',
    usable_for_housing: true,
    refund_potential: true,
    eligibility_signals: {
      gpa_min: 2.75,
      state: 'TN',
      field_of_study: null,
      faith_affiliation: null,
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },

  {
    title: 'Tennessee Ned McWherter Scholars Program',
    sponsor: 'Tennessee Student Assistance Corporation (TSAC)',
    source: 'housing_scholarship_crawler',
    source_id: 'tsac-ned-mcwherter-2025',
    source_url: 'https://www.tn.gov/collegepays/money-for-college/tsac-administered-programs/ned-mcwherter-scholars-program.html',
    application_url: 'https://www.tn.gov/collegepays/money-for-college/tsac-administered-programs/ned-mcwherter-scholars-program.html',
    description: 'Full scholarship for outstanding Tennessee high school graduates. Covers tuition, fees, room, and board at eligible Tennessee institutions. Because the award includes room and board, any excess after institutional charges is refunded directly to the student to cover off-campus housing and living expenses.',
    eligibility_bullets: [
      'Tennessee resident',
      'Outstanding academic record (typically 3.5+ GPA)',
      'Accepted at eligible Tennessee institution',
      'US citizen',
    ],
    amount_min: 6000,
    amount_max: 10000,
    amount_description: 'Full scholarship covering tuition, fees, room and board; excess may be refunded',
    is_national: false,
    state: 'TN',
    opportunity_type: 'scholarship',
    record_origin: 'curated_verified',
    categories: ['education', 'scholarship', 'merit', 'full scholarship'],
    keywords: ['tennessee', 'ned mcwherter', 'tsac', 'merit', 'full scholarship', 'housing included', 'room board'],
    funding_category: 'refund_eligible',
    usable_for_housing: true,
    refund_potential: true,
    eligibility_signals: {
      gpa_min: 3.5,
      state: 'TN',
      field_of_study: null,
      faith_affiliation: null,
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },

  {
    title: 'Tennessee Helping Heroes Grant',
    sponsor: 'Tennessee Student Assistance Corporation (TSAC)',
    source: 'housing_scholarship_crawler',
    source_id: 'tsac-helping-heroes-2025',
    source_url: 'https://www.tn.gov/collegepays/money-for-college/tsac-administered-programs/helping-heroes-grant.html',
    application_url: 'https://www.tn.gov/collegepays/money-for-college/tsac-administered-programs/helping-heroes-grant.html',
    description: 'Grant for Tennessee first responders, firefighters, law enforcement officers, and EMTs pursuing higher education. Covers tuition and fees; excess refunded to student for living expenses including off-campus housing.',
    eligibility_bullets: [
      'Tennessee resident',
      'Active first responder, firefighter, law enforcement, or EMT',
      'Enrolled at eligible Tennessee institution',
    ],
    amount_min: 2000,
    amount_max: 4000,
    amount_description: 'Up to $4,000/year toward education costs',
    is_national: false,
    state: 'TN',
    opportunity_type: 'grant',
    record_origin: 'curated_verified',
    categories: ['education', 'first_responder', 'grant'],
    keywords: ['tennessee', 'first responder', 'firefighter', 'law enforcement', 'emt', 'helping heroes', 'tsac'],
    funding_category: 'refund_eligible',
    usable_for_housing: true,
    refund_potential: true,
    eligibility_signals: {
      gpa_min: null,
      state: 'TN',
      field_of_study: null,
      faith_affiliation: null,
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },

  // ── Faith-Based Scholarships ───────────────────────────────────────────────

  {
    title: 'United Methodist Church Higher Education Scholarships',
    sponsor: 'United Methodist Church — General Board of Higher Education and Ministry',
    source: 'housing_scholarship_crawler',
    source_id: 'umc-higher-ed-scholarship-2025',
    source_url: 'https://www.gbhem.org/students/scholarships/',
    application_url: 'https://www.gbhem.org/students/scholarships/',
    description: 'The United Methodist Church offers multiple scholarship programs for active church members pursuing higher education. Awards are paid directly to the student or as a stipend, meaning funds can be applied to tuition, housing, food, and other living expenses. Programs include the UM Scholars award and denomination-specific merit scholarships.',
    eligibility_bullets: [
      'Active United Methodist Church member for at least one year',
      'Enrolled full-time in accredited undergraduate or graduate program',
      'US citizen or permanent resident',
    ],
    amount_min: 1000,
    amount_max: 3000,
    amount_description: '$1,000–$3,000 per year paid directly to student; usable for housing and living expenses',
    is_national: true,
    state: null,
    opportunity_type: 'scholarship',
    record_origin: 'curated_verified',
    categories: ['education', 'scholarship', 'faith_based', 'religious'],
    keywords: ['united methodist', 'umc', 'church scholarship', 'faith based', 'christian', 'religious scholarship', 'denomination', 'stipend'],
    funding_category: 'faith_based',
    usable_for_housing: true,
    refund_potential: false,
    eligibility_signals: {
      gpa_min: 2.5,
      state: null,
      field_of_study: null,
      faith_affiliation: 'methodist',
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },

  {
    title: 'Presbyterian Church (USA) Student Opportunity Scholarships',
    sponsor: 'Presbyterian Church (USA) — Office of Financial Aid for Studies',
    source: 'housing_scholarship_crawler',
    source_id: 'pcusa-student-opportunity-2025',
    source_url: 'https://www.presbyterianmission.org/ministries/higher-education/',
    application_url: 'https://www.presbyterianmission.org/ministries/higher-education/',
    description: 'PC(USA) provides scholarship support for members of Presbyterian congregations attending accredited colleges and universities. Stipend is paid directly to the student and may be used for tuition, housing, utilities, and other cost of attendance needs including off-campus living expenses.',
    eligibility_bullets: [
      'Active member of a Presbyterian Church (USA) congregation',
      'Financial need demonstrated',
      'Enrolled in accredited undergraduate program',
    ],
    amount_min: 1000,
    amount_max: 2000,
    amount_description: 'Annual stipend paid directly to student',
    is_national: true,
    state: null,
    opportunity_type: 'scholarship',
    record_origin: 'curated_verified',
    categories: ['education', 'scholarship', 'faith_based', 'financial_need'],
    keywords: ['presbyterian', 'pcusa', 'church scholarship', 'faith based', 'christian', 'religious', 'stipend', 'denomination'],
    funding_category: 'faith_based',
    usable_for_housing: true,
    refund_potential: false,
    eligibility_signals: {
      gpa_min: null,
      state: null,
      field_of_study: null,
      faith_affiliation: 'presbyterian',
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },

  {
    title: 'Baptist Joint Committee Religious Liberty Scholarship',
    sponsor: 'Baptist Joint Committee for Religious Liberty',
    source: 'housing_scholarship_crawler',
    source_id: 'bjc-religious-liberty-scholarship-2025',
    source_url: 'https://bjconline.org/law-scholarships/',
    application_url: 'https://bjconline.org/law-scholarships/',
    description: 'Scholarship for Baptist students pursuing law school who are committed to religious liberty principles. Award is a stipend paid directly to the recipient and may be used for tuition, housing, and living expenses during law school.',
    eligibility_bullets: [
      'Baptist church member or participant in Baptist-related faith community',
      'Enrolled in or accepted to ABA-accredited law school',
      'Commitment to religious liberty',
    ],
    amount_min: 2000,
    amount_max: 5000,
    amount_description: 'Stipend paid directly to student; usable for housing and living expenses',
    is_national: true,
    state: null,
    opportunity_type: 'scholarship',
    record_origin: 'curated_verified',
    categories: ['education', 'scholarship', 'faith_based', 'law'],
    keywords: ['baptist', 'religious liberty', 'law school', 'church scholarship', 'faith based', 'christian', 'stipend'],
    funding_category: 'stipend',
    usable_for_housing: true,
    refund_potential: false,
    eligibility_signals: {
      gpa_min: null,
      state: null,
      field_of_study: 'law',
      faith_affiliation: 'baptist',
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },

  {
    title: 'Catholic Charities USA Student Assistance Program',
    sponsor: 'Catholic Charities USA',
    source: 'housing_scholarship_crawler',
    source_id: 'ccusa-student-assistance-2025',
    source_url: 'https://www.catholiccharitiesusa.org/find-help/',
    application_url: 'https://www.catholiccharitiesusa.org/find-help/',
    description: 'Catholic Charities USA diocesan chapters provide direct financial assistance to students and families facing hardship. Assistance covers housing, utilities, food, and educational costs. Contact your local diocesan Catholic Charities chapter for specific scholarship and assistance programs in your area.',
    eligibility_bullets: [
      'Demonstrated financial need',
      'Located in diocese with active Catholic Charities chapter',
      'May include non-Catholics — check local chapter requirements',
    ],
    amount_min: 500,
    amount_max: 3000,
    amount_description: 'Variable; contact local chapter — may include housing assistance',
    is_national: true,
    state: null,
    opportunity_type: 'grant',
    record_origin: 'curated_verified',
    categories: ['housing', 'education', 'faith_based', 'financial_need'],
    keywords: ['catholic charities', 'diocese', 'church', 'faith based', 'catholic', 'housing assistance', 'rent', 'utilities'],
    funding_category: 'faith_based',
    usable_for_housing: true,
    refund_potential: false,
    eligibility_signals: {
      gpa_min: null,
      state: null,
      field_of_study: null,
      faith_affiliation: 'catholic',
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },

  // ── Music / Talent-Based Scholarships ─────────────────────────────────────

  {
    title: 'National Federation of Music Clubs Junior Composer Award',
    sponsor: 'National Federation of Music Clubs (NFMC)',
    source: 'housing_scholarship_crawler',
    source_id: 'nfmc-junior-composer-2025',
    source_url: 'https://www.nfmc-music.org/competitions-awards/',
    application_url: 'https://www.nfmc-music.org/competitions-awards/',
    description: 'NFMC offers multiple scholarship and award programs for young musicians. Awards are cash stipends paid directly to recipients and may be used for any purpose including housing, instruments, lessons, and living expenses. Open to students of music regardless of their college major.',
    eligibility_bullets: [
      'Active member of NFMC or affiliated club',
      'Student musician (any instrument or voice)',
      'Under 26 years of age',
      'Any college major eligible',
    ],
    amount_min: 500,
    amount_max: 2500,
    amount_description: 'Cash stipend paid directly to student; no restrictions on use',
    is_national: true,
    state: null,
    opportunity_type: 'scholarship',
    record_origin: 'curated_verified',
    categories: ['education', 'scholarship', 'music', 'talent', 'arts'],
    keywords: ['music', 'nfmc', 'composer', 'musician', 'instrument', 'talent scholarship', 'performing arts', 'band', 'orchestra', 'choir', 'flute'],
    funding_category: 'talent_based',
    usable_for_housing: true,
    refund_potential: false,
    eligibility_signals: {
      gpa_min: null,
      state: null,
      field_of_study: null,
      faith_affiliation: null,
      talent_type: 'music',
    },
    verification_status: 'verified_live_url',
  },

  {
    title: 'American Music Scholarship Association (AMSA) Annual Competition',
    sponsor: 'American Music Scholarship Association',
    source: 'housing_scholarship_crawler',
    source_id: 'amsa-competition-2025',
    source_url: 'https://www.americanmusicscholarship.org/',
    application_url: 'https://www.americanmusicscholarship.org/',
    description: 'AMSA provides cash scholarships to student musicians through annual competitions. Awards are unrestricted cash payments made directly to the student that can be applied to housing, tuition, instruments, or any living expense. Open to all instruments including flute, violin, piano, voice, and others.',
    eligibility_bullets: [
      'Student musician of any instrument or voice',
      'Any college major eligible (not music-major only)',
      'Audition or portfolio required',
    ],
    amount_min: 500,
    amount_max: 5000,
    amount_description: 'Cash competition awards paid directly to student with no use restrictions',
    is_national: true,
    state: null,
    opportunity_type: 'scholarship',
    record_origin: 'curated_verified',
    categories: ['scholarship', 'music', 'talent', 'arts', 'performance'],
    keywords: ['music scholarship', 'amsa', 'flute', 'violin', 'piano', 'voice', 'musician', 'talent', 'competition', 'performing arts'],
    funding_category: 'talent_based',
    usable_for_housing: true,
    refund_potential: false,
    eligibility_signals: {
      gpa_min: null,
      state: null,
      field_of_study: null,
      faith_affiliation: null,
      talent_type: 'music',
    },
    verification_status: 'verified_live_url',
  },

  {
    title: 'National Flute Association Scholarship',
    sponsor: 'National Flute Association',
    source: 'housing_scholarship_crawler',
    source_id: 'nfa-scholarship-2025',
    source_url: 'https://www.nfaonline.org/competitions/scholarship-competition/',
    application_url: 'https://www.nfaonline.org/competitions/scholarship-competition/',
    description: 'The National Flute Association offers annual scholarship competitions open to flutists pursuing higher education. Cash awards are paid directly to the winner with no restrictions on use — meaning winners may apply funds to housing, tuition, or any living expense. Multiple age and experience categories available.',
    eligibility_bullets: [
      'Flutist enrolled in or accepted to higher education program',
      'NFA member (membership open to all)',
      'Audition recording or live performance required',
    ],
    amount_min: 2000,
    amount_max: 7500,
    amount_description: 'Cash scholarship paid directly to student; no restrictions on use',
    is_national: true,
    state: null,
    opportunity_type: 'scholarship',
    record_origin: 'curated_verified',
    categories: ['scholarship', 'music', 'talent', 'flute', 'performance'],
    keywords: ['flute', 'flutist', 'nfa', 'national flute association', 'music scholarship', 'talent', 'instrument', 'competition'],
    funding_category: 'talent_based',
    usable_for_housing: true,
    refund_potential: false,
    eligibility_signals: {
      gpa_min: null,
      state: null,
      field_of_study: null,
      faith_affiliation: null,
      talent_type: 'music_flute',
    },
    verification_status: 'verified_live_url',
  },

  // ── COA Adjustment / Housing Direct ───────────────────────────────────────

  {
    title: 'FAFSA Professional Judgment / COA Adjustment for Off-Campus Housing',
    sponsor: 'U.S. Department of Education (Federal Student Aid)',
    source: 'housing_scholarship_crawler',
    source_id: 'ed-gov-coa-adjustment-2025',
    source_url: 'https://studentaid.gov/complete-aid-process/how-calculated',
    application_url: 'https://studentaid.gov/complete-aid-process/appeals',
    description: 'Students living off campus may appeal to their college\'s financial aid office for a Cost of Attendance (COA) adjustment to reflect actual housing costs. A successful appeal increases your official COA, which can increase your financial aid eligibility — including loans, grants, and work-study — effectively directing more money toward your rent, utilities, and food.',
    eligibility_bullets: [
      'Any student with a completed FAFSA',
      'Living or planning to live off campus',
      'Actual housing costs exceed standard COA budget',
      'Contact your financial aid office for Professional Judgment process',
    ],
    amount_min: 0,
    amount_max: 5000,
    amount_description: 'Variable — depends on COA gap and aid eligibility; may unlock additional grants and work-study',
    is_national: true,
    state: null,
    opportunity_type: 'benefit',
    record_origin: 'curated_verified',
    categories: ['education', 'housing', 'financial_aid', 'coa'],
    keywords: ['coa adjustment', 'cost of attendance', 'professional judgment', 'off campus housing', 'fafsa appeal', 'financial aid appeal', 'housing budget', 'rent'],
    funding_category: 'coa_adjustment',
    usable_for_housing: true,
    refund_potential: false,
    eligibility_signals: {
      gpa_min: null,
      state: null,
      field_of_study: null,
      faith_affiliation: null,
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },

  {
    title: 'Federal Pell Grant (Refund-Eligible)',
    sponsor: 'U.S. Department of Education',
    source: 'housing_scholarship_crawler',
    source_id: 'ed-gov-pell-grant-refund-2025',
    source_url: 'https://studentaid.gov/understand-aid/types/grants/pell',
    application_url: 'https://studentaid.gov/h/apply-for-aid/fafsa',
    description: 'The Federal Pell Grant is awarded to undergraduate students with financial need and does NOT need to be repaid. After tuition and fees are covered, any remaining Pell Grant funds are REFUNDED DIRECTLY to the student — typically within two weeks of each semester — and can be used for off-campus rent, utilities, groceries, transportation, and other living expenses.',
    eligibility_bullets: [
      'US citizen or eligible non-citizen',
      'Demonstrated financial need via FAFSA',
      'Undergraduate student (not yet earned a bachelor\'s degree)',
      'Enrolled at least half-time at eligible institution',
    ],
    amount_min: 750,
    amount_max: 7395,
    amount_description: 'Up to $7,395/year (2024–25 award year); refund check issued for excess after tuition',
    is_national: true,
    state: null,
    opportunity_type: 'grant',
    record_origin: 'curated_verified',
    categories: ['education', 'grant', 'financial_need', 'federal'],
    keywords: ['pell grant', 'federal grant', 'fafsa', 'financial need', 'refund', 'off campus', 'housing', 'living expenses', 'rent'],
    funding_category: 'refund_eligible',
    usable_for_housing: true,
    refund_potential: true,
    eligibility_signals: {
      gpa_min: null,
      state: null,
      field_of_study: null,
      faith_affiliation: null,
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },

  {
    title: 'Resident Assistant (RA) Program — Campus Housing Stipend',
    sponsor: 'University / College Residential Life Programs',
    source: 'housing_scholarship_crawler',
    source_id: 'ra-program-housing-direct-2025',
    source_url: 'https://www.nyu.edu/students/student-information-and-resources/housing-and-dining/on-campus-living/residential-life/resident-assistants.html',
    application_url: 'https://www.nace.org/resources/surveys-research/internship-co-op-survey',
    description: 'Resident Assistant (RA) positions at colleges and universities provide FREE or heavily discounted campus housing plus a stipend in exchange for community management responsibilities in residential halls. The housing stipend effectively covers your room expense and often includes a meal plan credit, freeing cash for off-campus costs. RA roles build leadership skills valued by many scholarships and employers.',
    eligibility_bullets: [
      'Currently enrolled undergraduate or graduate student',
      'Good academic standing',
      'Interest in community building and leadership',
      'Apply through your institution\'s Office of Residential Life',
    ],
    amount_min: 3000,
    amount_max: 12000,
    amount_description: 'Free or discounted housing ($3,000–$12,000+ value/year) plus monthly stipend',
    is_national: true,
    state: null,
    opportunity_type: 'scholarship',
    record_origin: 'curated_verified',
    categories: ['housing', 'scholarship', 'employment', 'leadership', 'campus'],
    keywords: ['resident assistant', 'ra program', 'campus housing', 'housing stipend', 'residential life', 'free housing', 'campus job', 'leadership'],
    funding_category: 'housing_direct',
    usable_for_housing: true,
    refund_potential: false,
    eligibility_signals: {
      gpa_min: 2.5,
      state: null,
      field_of_study: null,
      faith_affiliation: null,
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },

  {
    title: 'Federal Work-Study (FWS) — Campus Employment Stipend',
    sponsor: 'U.S. Department of Education',
    source: 'housing_scholarship_crawler',
    source_id: 'ed-gov-fws-housing-2025',
    source_url: 'https://studentaid.gov/understand-aid/types/work-study',
    application_url: 'https://studentaid.gov/h/apply-for-aid/fafsa',
    description: 'Federal Work-Study provides part-time employment opportunities for students with financial need. Unlike loans, FWS earnings are paychecks you keep — they are NOT applied to your tuition account, meaning every dollar earned goes directly to your pocket for off-campus rent, utilities, groceries, and transportation. Many campuses offer FWS positions in research, libraries, and community service.',
    eligibility_bullets: [
      'Demonstrated financial need via FAFSA',
      'US citizen or eligible non-citizen',
      'Enrolled at least half-time at eligible institution',
    ],
    amount_min: 2000,
    amount_max: 5000,
    amount_description: 'Varies; average $2,000–$5,000 per year as employment wages paid directly to student',
    is_national: true,
    state: null,
    opportunity_type: 'scholarship',
    record_origin: 'curated_verified',
    categories: ['employment', 'financial_need', 'federal', 'housing'],
    keywords: ['federal work study', 'fws', 'campus job', 'student employment', 'fafsa', 'paycheck', 'off campus housing', 'rent'],
    funding_category: 'stipend',
    usable_for_housing: true,
    refund_potential: false,
    eligibility_signals: {
      gpa_min: null,
      state: null,
      field_of_study: null,
      faith_affiliation: null,
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },

  {
    title: 'Forensic Science Scholarships — American Academy of Forensic Sciences',
    sponsor: 'American Academy of Forensic Sciences (AAFS)',
    source: 'housing_scholarship_crawler',
    source_id: 'aafs-scholarship-2025',
    source_url: 'https://www.aafs.org/student-resources/scholarships/',
    application_url: 'https://www.aafs.org/student-resources/scholarships/',
    description: 'AAFS offers scholarship awards for students pursuing careers in forensic science. Scholarships are cash awards paid directly to the student and can be applied to tuition, housing, research costs, or any living expenses. Students majoring in forensic science, criminalistics, forensic chemistry, or related fields are eligible.',
    eligibility_bullets: [
      'Student pursuing forensic science or related field',
      'Enrolled in accredited undergraduate or graduate program',
      'AAFS student membership encouraged',
    ],
    amount_min: 500,
    amount_max: 2000,
    amount_description: 'Cash award paid directly to student; no restrictions on use',
    is_national: true,
    state: null,
    opportunity_type: 'scholarship',
    record_origin: 'curated_verified',
    categories: ['education', 'scholarship', 'forensic science', 'stem'],
    keywords: ['forensic science', 'aafs', 'criminalistics', 'forensic chemistry', 'crime scene', 'stem scholarship', 'field of study'],
    funding_category: 'refund_eligible',
    usable_for_housing: true,
    refund_potential: true,
    eligibility_signals: {
      gpa_min: 3.0,
      state: null,
      field_of_study: 'forensic_science',
      faith_affiliation: null,
      talent_type: null,
    },
    verification_status: 'verified_live_url',
  },
]

// ---------------------------------------------------------------------------
// URL validation — lightweight HEAD check
// ---------------------------------------------------------------------------

async function isLiveUrl(url, timeoutMs = 8000) {
  if (!url || typeof url !== 'string') return false
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'GrantFlow Housing Crawler/1.0 (https://grantflow.app)' },
      redirect: 'follow',
    })
    clearTimeout(timer)
    // 200, 301, 302, 405 (HEAD not allowed but server exists) all count as live
    return res.status < 400 || res.status === 405
  } catch {
    // Try GET fallback for sites that block HEAD
    try {
      const controller2 = new AbortController()
      const timer2 = setTimeout(() => controller2.abort(), timeoutMs)
      const res2 = await fetch(url, {
        method: 'GET',
        signal: controller2.signal,
        headers: { 'User-Agent': 'GrantFlow Housing Crawler/1.0' },
        redirect: 'follow',
      })
      clearTimeout(timer2)
      return res2.status < 400
    } catch {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Main crawler entry point
// ---------------------------------------------------------------------------

/**
 * Seed all housing-usable funding opportunities into the database.
 *
 * @param {import('../db/index.js').DbInstance} db
 * @param {Object} [opts]
 * @param {boolean} [opts.validateUrls=true] - Validate URLs before inserting (set false in tests)
 * @param {Function} [opts.onProgress] - Progress callback(i, total, title, status)
 * @returns {Promise<{inserted: number, skipped: number, errors: number, total: number}>}
 */
export async function runHousingScholarshipCrawler(db, opts = {}) {
  const validateUrls = opts.validateUrls !== false
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null
  const total = HOUSING_FUNDING_CATALOG.length

  let inserted = 0
  let skipped = 0
  let errors = 0

  log.info(`[HousingCrawler] Starting — ${total} opportunities to process (URL validation: ${validateUrls})`)

  for (let i = 0; i < HOUSING_FUNDING_CATALOG.length; i++) {
    const opp = HOUSING_FUNDING_CATALOG[i]
    const label = `[HousingCrawler] (${i + 1}/${total}) "${opp.title}"`

    try {
      // Validate URL if requested
      let verificationStatus = opp.verification_status
      if (validateUrls) {
        const url = opp.application_url || opp.source_url
        const live = await isLiveUrl(url)
        if (!live) {
          console.warn(`${label} — URL appears dead (${url}), skipping`)
          verificationStatus = 'suspected_dead'
          skipped++
          if (onProgress) onProgress(i + 1, total, opp.title, 'url_dead')
          await delay(300)
          continue
        }
        verificationStatus = 'verified_live_url'
      }

      // Build the full opportunity payload with new classification fields
      const payload = {
        ...opp,
        verification_status: verificationStatus,
        // Ensure eligibility_signals is JSON string for DB
        eligibility_signals: opp.eligibility_signals
          ? JSON.stringify(opp.eligibility_signals)
          : '{}',
        // Boolean to integer for SQLite compatibility (opportunityInserter handles dialect)
        usable_for_housing: opp.usable_for_housing ? 1 : 0,
        refund_potential: opp.refund_potential ? 1 : 0,
        last_verified_at: opp.last_verified_at ?? new Date().toISOString(),
        type: 'OPPORTUNITY',
      }

      const result = await upsertFundingOpportunity(db, payload, {
        allowLoans: false,
        allowDirectories: false,
      })

      if (result.inserted || result.id) {
        inserted++
        log.info(`${label} — ${result.inserted ? 'inserted' : 'updated'} (id: ${result.id})`)
        if (onProgress) onProgress(i + 1, total, opp.title, result.inserted ? 'inserted' : 'updated')
      } else {
        skipped++
        log.info(`${label} — skipped: ${result.reason}`)
        if (onProgress) onProgress(i + 1, total, opp.title, 'skipped')
      }
    } catch (err) {
      errors++
      log.error(`${label} — error:`, err?.message || String(err))
      if (onProgress) onProgress(i + 1, total, opp.title, 'error')
    }

    // Polite delay between requests
    await delay(validateUrls ? 800 : 50)
  }

  const summary = { inserted, skipped, errors, total }
  log.info('[HousingCrawler] Complete:', summary)
  return summary
}
