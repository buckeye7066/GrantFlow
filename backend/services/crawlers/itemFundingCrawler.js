/**
 * Item-Specific Funding Crawler
 * REAL web discovery for specific items, services, or training.
 *
 * DESIGN PRINCIPLE: When someone needs a 15-passenger Ford van, we don't just
 * link to a generic "vehicle donation" page. We actively search the web for
 * real organizations that provide that specific item, and return results with
 * real URLs the user can click and apply to.
 *
 * When someone needs CPR/First Aid training, we find real providers offering
 * that specific class - free or funded.
 *
 * HOW IT WORKS:
 * 1. Parse the item request to understand what's being asked for
 * 2. Search Google (via scraping) for real sources that donate/provide/fund that item
 * 3. Search known item-specific organizations
 * 4. Combine profile signals for targeted searches (e.g., "veteran van donation")
 * 5. Return ONLY results with real, clickable URLs
 *
 * CRITICAL: No fabricated data. Every result must have a real URL.
 */
import * as cheerio from 'cheerio'
import { scoreOpportunity as calculateMatchScore } from '../matchEngine.js'

function buildSearchKeywords(profile, maxKeywords = 10) {
  const kw = new Set();
  const signals = profile?.signals || {};
  if (signals.keywordSet instanceof Set) signals.keywordSet.forEach(k => kw.add(k));
  if (signals.interests instanceof Set) signals.interests.forEach(k => kw.add(k));
  const loc = signals.location || {};
  if (loc.state) kw.add(loc.state);
  if (loc.city) kw.add(loc.city);
  const name = profile?.display_name || profile?.name || '';
  if (name) kw.add(name.split(/\s+/)[0]);
  return [...kw].slice(0, maxKeywords);
}
import { getWithRetry } from './httpClient.js'
import { planCrawlerQueries } from './queryPlanner.js'
import {
  resolveCrawlerContext,
  mergePlanKeywords,
  enforceCrawlerOpportunityContract,
} from './crawlerOpportunityContract.js'
import { enforceOpportunityPolicy } from './opportunityPolicy.js'
import { createLogger } from '../../utils/logger.js'
const log = createLogger('itemFundingCrawler')

/**
   * Known organizations that provide specific item categories.
   * These are verified, real organizations with real programs.
   */
const KNOWN_ITEM_SOURCES = {
    vehicle: [
      {
              name: 'Vehicles for Change',
              url: 'https://www.vehiclesforchange.org/',
              description: 'Provides affordable vehicles to families in need. Serves multiple states. Vehicles are repaired and sold at low cost.',
              keywords: ['vehicle', 'car', 'transportation'],
      },
      {
              name: '1-800-Charity Cars',
              url: 'https://www.800charitycars.org/',
              description: 'Donates vehicles to struggling families, single parents, and domestic violence survivors nationwide.',
              keywords: ['vehicle', 'car', 'donation', 'free car'],
      },
      {
              name: 'Working Cars for Working People',
              url: 'https://www.workingcarsforworkingpeople.org/',
              description: 'Provides donated vehicles to low-income working individuals and families.',
              keywords: ['vehicle', 'car', 'working', 'low income'],
      },
      {
              name: 'Good News Garage',
              url: 'https://www.goodnewsgarage.org/',
              description: 'Donates refurbished vehicles to people in need. Partners with social service agencies.',
              keywords: ['vehicle', 'car', 'donation', 'refurbished'],
      },
      {
              name: 'Free Charity Cars',
              url: 'https://freecharitycars.com/',
              description: 'Free cars for people in need. Application-based program accepting requests nationwide.',
              keywords: ['vehicle', 'car', 'free', 'donation'],
      },
        ],
    van: [
      {
              name: 'Vans for Disabled Veterans',
              url: 'https://www.va.gov/health-care/about-va-health-benefits/vision-care/blind-low-vision-rehab-services/',
              description: 'VA automobile allowance and adaptive equipment grants for eligible veterans with disabilities.',
              keywords: ['van', 'veteran', 'disability', 'adaptive'],
      },
      {
              name: 'National Mobility Equipment Dealers Association (NMEDA)',
              url: 'https://www.nmeda.com/consumer-resources/',
              description: 'Resources for adaptive vehicles including wheelchair-accessible vans and mobility equipment.',
              keywords: ['van', 'wheelchair', 'accessible', 'mobility', 'adaptive'],
      },
      {
              name: 'Braun Ability Assistance',
              url: 'https://www.braunability.com/',
              description: 'Wheelchair accessible vehicles and conversion vans. Has financing and assistance programs.',
              keywords: ['van', 'wheelchair', 'accessible', 'conversion'],
      },
        ],
    // Vehicles/vans specifically for ORGANIZATIONS (nonprofits, churches, schools).
    // These programs grant or deeply discount vehicles to 501(c)(3)s and community groups.
    nonprofit_vehicle: [
      {
              name: 'Good News Garage — Nonprofit Vehicle Partnerships',
              url: 'https://www.goodnewsgarage.org/about/our-programs/',
              description: 'Partners with social-service agencies and nonprofits to place donated, refurbished vehicles with the people and programs they serve.',
              keywords: ['van', 'vehicle', 'nonprofit', 'agency', 'donation', 'fleet'],
      },
      {
              name: 'Enterprise Mobility Foundation — Community Grants',
              url: 'https://www.enterprisemobility.com/en/about/foundation.html',
              description: 'Enterprise Mobility Foundation funds nonprofits, including transportation-access and mobility programs that need vehicles and vans for community service.',
              keywords: ['van', 'vehicle', 'transportation', 'nonprofit', 'mobility', 'community'],
      },
      {
              name: 'Ford Motor Company Fund — Community Grants',
              url: 'https://www.fordfund.org/',
              description: 'Ford Fund makes grants to nonprofits for community programs and mobility/transportation needs; some programs support vehicle access for service organizations.',
              keywords: ['van', 'vehicle', 'transportation', 'nonprofit', 'mobility', 'corporate giving'],
      },
      {
              name: 'Toyota USA Foundation & Community Grants',
              url: 'https://www.toyota.com/usa/community/',
              description: 'Toyota community and mobility grants supporting nonprofits, including organizations needing vehicles for outreach and transportation programs.',
              keywords: ['van', 'vehicle', 'transportation', 'nonprofit', 'mobility', 'corporate giving'],
      },
      {
              name: 'USDA Rural Development — Community Facilities (vehicles/equipment)',
              url: 'https://www.rd.usda.gov/programs-services/community-facilities/community-facilities-direct-loan-grant-program',
              description: 'Community Facilities grants/loans help rural nonprofits, tribes, and public bodies buy essential community equipment and vehicles (buses, vans, ambulances).',
              keywords: ['van', 'bus', 'vehicle', 'rural', 'nonprofit', 'community facilities', 'usda'],
      },
        ],
    technology: [
      {
              name: 'TechSoup',
              url: 'https://www.techsoup.org/',
              description: 'Deeply discounted and donated technology products for nonprofits. Software, hardware, and cloud services.',
              keywords: ['technology', 'software', 'hardware', 'computers', 'nonprofit'],
      },
      {
              name: 'PCs for People',
              url: 'https://www.pcsforpeople.org/',
              description: 'Refurbished computers and low-cost internet for qualifying low-income individuals and nonprofits.',
              keywords: ['computer', 'laptop', 'internet', 'low income'],
      },
      {
              name: 'World Computer Exchange',
              url: 'https://www.worldcomputerexchange.org/',
              description: 'Refurbished computers for educational institutions and nonprofits.',
              keywords: ['computer', 'education', 'nonprofit', 'refurbished'],
      },
      {
              name: 'Human-I-T',
              url: 'https://www.human-i-t.org/',
              description: 'Free and low-cost computers, internet, and digital literacy training for underserved communities.',
              keywords: ['computer', 'internet', 'digital literacy', 'low income'],
      },
      {
              name: 'EveryoneOn',
              url: 'https://www.everyoneon.org/',
              description: 'Low-cost internet and computers for qualifying households.',
              keywords: ['internet', 'computer', 'affordable', 'low income'],
      },
        ],
    // Education / classroom technology funders — for SCHOOLS, teachers, and youth programs.
    school_technology: [
      {
              name: 'DonorsChoose — Classroom Project Funding',
              url: 'https://www.donorschoose.org/',
              description: 'Public-school teachers post classroom projects (laptops, tablets, STEM kits, supplies) and donors fund them. The leading crowdfunding platform for classroom tech and materials.',
              keywords: ['classroom', 'teacher', 'school', 'technology', 'laptop', 'tablet', 'stem', 'supplies'],
      },
      {
              name: 'Digital Wish — School Technology Grants',
              url: 'https://www.digitalwish.org/',
              description: 'Grants and discounted technology for schools and teachers, including computers, tablets, and classroom tech projects.',
              keywords: ['school', 'teacher', 'technology', 'computer', 'tablet', 'classroom', 'grant'],
      },
      {
              name: 'Tech for Learning (Computers with Causes)',
              url: 'https://www.computerswithcauses.org/',
              description: 'Donated computers and technology for schools, nonprofits, students, and educational programs.',
              keywords: ['school', 'technology', 'computer', 'student', 'education', 'donation'],
      },
      {
              name: 'E-Rate Program (Universal Service / USAC)',
              url: 'https://www.usac.org/e-rate/',
              description: 'Federal E-Rate program discounts internet access and connectivity for eligible schools and libraries.',
              keywords: ['school', 'library', 'internet', 'connectivity', 'broadband', 'e-rate', 'federal'],
      },
      {
              name: 'Best Buy Foundation — Teen Tech Centers & Grants',
              url: 'https://corporate.bestbuy.com/best-buy-foundation/',
              description: 'Corporate giving for technology access and STEM/teen programs at schools and youth-serving nonprofits.',
              keywords: ['technology', 'stem', 'youth', 'school', 'teen', 'corporate giving', 'grant'],
      },
        ],
    equipment: [
      {
              name: 'Good360',
              url: 'https://good360.org/',
              description: 'Product philanthropy platform connecting donated goods (equipment, supplies, furniture) with nonprofits in need.',
              keywords: ['equipment', 'supplies', 'furniture', 'donation', 'nonprofit'],
      },
      {
              name: 'GrantWatch Equipment Grants',
              url: 'https://www.grantwatch.com/cat/3/equipment-grants.html',
              description: 'Curated listings of equipment grants from foundations, government, and corporate sources.',
              keywords: ['equipment', 'grant', 'machinery', 'tools'],
      },
      {
              name: 'USDA Equipment Grants (Rural)',
              url: 'https://www.rd.usda.gov/programs-services/all-programs',
              description: 'USDA programs for rural community equipment, including Community Facilities grants.',
              keywords: ['equipment', 'rural', 'community', 'usda'],
      },
      {
              name: 'Walmart Community Grants — Local Equipment & Supplies',
              url: 'https://walmart.org/how-we-give/local-community-grants',
              description: 'Local store-level grants ($250–$5,000) to nonprofits, schools, and faith groups for equipment, supplies, and community programs.',
              keywords: ['equipment', 'supplies', 'nonprofit', 'school', 'corporate giving', 'community grant'],
      },
      {
              name: 'Lowe’s / Home Depot Community Improvement Grants',
              url: 'https://corporate.homedepot.com/page/building-stronger-communities',
              description: 'Corporate community grants and product donations for tools, equipment, and facility-improvement projects at nonprofits and community organizations.',
              keywords: ['equipment', 'tools', 'supplies', 'nonprofit', 'facility', 'corporate giving'],
      },
        ],
    training: [
      {
              name: 'American Red Cross (CPR/First Aid)',
              url: 'https://www.redcross.org/take-a-class',
              description: 'CPR, First Aid, AED, and other safety training classes available nationwide. Online and in-person.',
              keywords: ['cpr', 'first aid', 'training', 'certification', 'red cross'],
      },
      {
              name: 'American Heart Association Training',
              url: 'https://cpr.heart.org/en/courses',
              description: 'CPR, First Aid, and ACLS courses. Instructor-led and online. Widely recognized certification.',
              keywords: ['cpr', 'first aid', 'training', 'aha', 'certification'],
      },
      {
              name: 'OSHA Training Institute (Free/Low-Cost)',
              url: 'https://www.osha.gov/training/outreach',
              description: 'OSHA safety training including OSHA 10 and OSHA 30 courses through authorized trainers.',
              keywords: ['osha', 'safety', 'training', 'workplace', 'certification'],
      },
      {
              name: 'CareerOneStop (DOL)',
              url: 'https://www.careeronestop.org/LocalHelp/local-help.aspx',
              description: 'U.S. Department of Labor career centers offering free job training, certifications, and workforce development.',
              keywords: ['training', 'job training', 'workforce', 'career', 'certification', 'free'],
      },
      {
              name: 'Coursera for Campus / Community',
              url: 'https://www.coursera.org/for-campus',
              description: 'Free and low-cost online courses and professional certificates from top universities.',
              keywords: ['training', 'online course', 'certificate', 'education', 'free'],
      },
        ],
    furniture: [
      {
              name: 'Habitat for Humanity ReStore',
              url: 'https://www.habitat.org/restores',
              description: 'Affordable furniture, appliances, and building materials. Proceeds support Habitat homebuilding.',
              keywords: ['furniture', 'appliances', 'affordable', 'habitat'],
      },
      {
              name: 'Furniture Bank Network',
              url: 'https://www.furniturebanks.org/',
              description: 'Network of furniture banks providing free furniture to people transitioning out of homelessness or crisis.',
              keywords: ['furniture', 'free', 'donation', 'crisis'],
      },
        ],
    medical_equipment: [
      {
              name: 'MedShare',
              url: 'https://www.medshare.org/',
              description: 'Recovers surplus medical supplies and equipment for redistribution to communities in need.',
              keywords: ['medical equipment', 'medical supplies', 'healthcare'],
      },
      {
              name: 'Project C.U.R.E.',
              url: 'https://projectcure.org/',
              description: 'Collects and distributes donated medical supplies and equipment.',
              keywords: ['medical equipment', 'medical supplies', 'donation'],
      },
        ],
    adaptive_equipment: [
      {
              name: 'AbleData',
              url: 'https://abledata.acl.gov/',
              description: 'Database of assistive technology products and where to find them, funded by U.S. ACL/NIDILRR.',
              keywords: ['assistive technology', 'adaptive equipment', 'disability', 'accessibility'],
      },
      {
              name: 'United Spinal Association',
              url: 'https://www.unitedspinal.org/',
              description: 'Resources and equipment assistance for spinal cord injury and wheelchair users.',
              keywords: ['wheelchair', 'spinal cord', 'adaptive', 'mobility'],
      },
        ],
    food: [
      {
              name: 'Feeding America',
              url: 'https://www.feedingamerica.org/find-your-local-foodbank',
              description: 'Find local food banks, food pantries, and meal programs nationwide.',
              keywords: ['food', 'food bank', 'pantry', 'meals', 'hunger'],
      },
      {
              name: 'USDA Food Programs',
              url: 'https://www.fns.usda.gov/programs',
              description: 'Federal food assistance programs including SNAP, WIC, school meals, and commodity programs.',
              keywords: ['food', 'snap', 'wic', 'school meals', 'usda'],
      },
        ],
    food_truck: [
      {
        name: 'SBA Small Business Grants & Loans',
        url: 'https://www.sba.gov/funding-programs',
        description: 'SBA funding programs for starting or expanding a small business, including food trucks and mobile food vendors.',
        keywords: ['food truck', 'small business', 'sba', 'startup', 'mobile food'],
      },
      {
        name: 'SCORE Mentoring for Small Business',
        url: 'https://www.score.org/',
        description: 'Free mentoring and resources for small business owners including food truck operators.',
        keywords: ['food truck', 'small business', 'mentoring', 'startup'],
      },
      {
        name: 'Grants.gov Business Opportunities',
        url: 'https://www.grants.gov/search-grants?fundingCategories=BC',
        description: 'Federal grant opportunities for Business and Commerce, including food service and mobile vendor programs.',
        keywords: ['food truck', 'small business', 'grant', 'federal', 'commerce'],
      },
      {
        name: 'FedEx Small Business Grant Contest',
        url: 'https://www.fedex.com/en-us/small-business/grant-contest.html',
        description: 'Annual grant contest for small businesses. Food trucks and mobile food businesses are eligible.',
        keywords: ['food truck', 'small business', 'grant', 'contest'],
      },
    ],
  small_business: [
      {
        name: 'SBA Funding Programs',
        url: 'https://www.sba.gov/funding-programs',
        description: 'U.S. Small Business Administration funding programs including grants, loans, and investment capital.',
        keywords: ['small business', 'sba', 'startup', 'entrepreneur', 'funding'],
      },
      {
        name: 'Grants.gov Business & Commerce',
        url: 'https://www.grants.gov/search-grants?fundingCategories=BC',
        description: 'Federal grants for business and commerce development.',
        keywords: ['small business', 'grant', 'federal', 'commerce'],
      },
      {
        name: 'SCORE Free Business Mentoring',
        url: 'https://www.score.org/',
        description: 'Free mentoring, workshops, and resources for small business owners and entrepreneurs.',
        keywords: ['small business', 'mentoring', 'entrepreneur', 'startup'],
      },
      {
        name: 'Minority Business Development Agency',
        url: 'https://www.mbda.gov/',
        description: 'Resources and support for minority-owned businesses including grants, contracts, and capital.',
        keywords: ['small business', 'minority', 'grant', 'minority-owned'],
      },
    ],
    clothing: [
      {
              name: 'Dress for Success',
              url: 'https://dressforsuccess.org/',
              description: 'Professional clothing and career development for women entering or re-entering the workforce.',
              keywords: ['clothing', 'professional', 'women', 'career', 'interview'],
      },
      {
              name: 'Career Wardrobe',
              url: 'https://www.careerwardrobe.org/',
              description: 'Free professional and casual clothing for individuals transitioning to independence.',
              keywords: ['clothing', 'professional', 'free', 'workforce'],
      },
        ],
    cpr_certification: [
      {
              name: 'American Heart Association — CPR/BLS Courses',
              url: 'https://cpr.heart.org/en/courses',
              description: 'CPR, BLS, ACLS, Heartsaver, and instructor certification courses. The AHA is the gold standard for CPR/First Aid training.',
              keywords: ['cpr', 'bls', 'acls', 'heartsaver', 'instructor', 'certification', 'first aid', 'aed'],
      },
      {
              name: 'American Red Cross — CPR/First Aid/AED Certification',
              url: 'https://www.redcross.org/take-a-class/cpr',
              description: 'CPR, First Aid, AED, and instructor certification classes. Online and in-person. Nationally recognized.',
              keywords: ['cpr', 'first aid', 'aed', 'certification', 'instructor', 'red cross'],
      },
      {
              name: 'CareerOneStop — Training & Certification Funding',
              url: 'https://www.careeronestop.org/LocalHelp/AmericanJobCenters/find-american-job-centers.aspx',
              description: 'Find your local American Job Center for WIOA-funded training vouchers that cover CPR, First Aid, and other certification costs.',
              keywords: ['wioa', 'workforce', 'certification', 'training', 'job center', 'cpr', 'voucher'],
      },
      {
              name: 'FEMA CERT — Free Community Safety Training',
              url: 'https://www.ready.gov/cert',
              description: 'Free CERT training programs include CPR, First Aid, and emergency response skills. Available through local emergency management.',
              keywords: ['cert', 'fema', 'cpr', 'first aid', 'free', 'community', 'emergency'],
      },
      {
              name: 'National Safety Council — First Aid/CPR/AED Training',
              url: 'https://www.nsc.org/safety-training/first-aid',
              description: 'First Aid, CPR, and AED training courses from the National Safety Council. Employer and individual options available.',
              keywords: ['nsc', 'first aid', 'cpr', 'aed', 'safety', 'certification', 'employer'],
      },
    ],
    instructor_certification: [
      {
              name: 'AHA Instructor Network — Become a CPR Instructor',
              url: 'https://cpr.heart.org/en/cpr-courses-and-kits/instructor',
              description: 'Information on becoming an AHA CPR, BLS, or Heartsaver instructor. Includes Training Center requirements and instructor course details.',
              keywords: ['instructor', 'cpr instructor', 'bls instructor', 'heartsaver instructor', 'aha', 'teach cpr'],
      },
      {
              name: 'Red Cross — Become a First Aid/CPR/AED Instructor',
              url: 'https://www.redcross.org/take-a-class/become-an-instructor',
              description: 'Red Cross instructor certification pathway for CPR, First Aid, and AED. Teach in your community, workplace, or organization.',
              keywords: ['instructor', 'red cross instructor', 'teach first aid', 'teach cpr', 'certification'],
      },
      {
              name: 'ASHI/MEDIC First Aid — Instructor Programs',
              url: 'https://emergencycare.hsi.com/instructor-training',
              description: 'HSI/ASHI instructor training for CPR, First Aid, Bloodborne Pathogens, and Emergency Oxygen. Alternative to AHA and Red Cross.',
              keywords: ['instructor', 'ashi', 'medic first aid', 'hsi', 'teach', 'certification'],
      },
    ],
    license_reinstatement: [
      {
              name: 'NCSBN — PROBE Professional Boundaries & Ethics Course',
              url: 'https://www.ncsbn.org/nursing-regulation/discipline-and-alt-to-discipline/probe.page',
              description: 'The PROBE program is board-required professional boundaries and ethics education for nursing license reinstatement. Information about the course, requirements, and enrollment.',
              keywords: ['probe', 'ethics', 'reinstatement', 'nursing license', 'professional boundaries', 'board required', 'remediation'],
      },
      {
              name: 'NCSBN — Nurse Re-Entry Program Directory',
              url: 'https://www.ncsbn.org/nursing-regulation/practice/nurse-reentry.page',
              description: 'State-by-state directory of nurse re-entry programs, refresher courses, and reinstatement pathways. Includes resources for returning to practice after suspension or lapse.',
              keywords: ['nurse reentry', 'reinstatement', 'refresher', 'return to practice', 'nursing license'],
      },
      {
              name: 'CareerOneStop — WIOA Training for License Reinstatement',
              url: 'https://www.careeronestop.org/LocalHelp/AmericanJobCenters/find-american-job-centers.aspx',
              description: 'Local American Job Centers provide WIOA-funded training vouchers that may cover professional license reinstatement courses, PROBE classes, remediation education, and recertification exams.',
              keywords: ['wioa', 'workforce', 'reinstatement', 'training', 'license', 'career center', 'voucher', 'probe'],
      },
      {
              name: 'State Vocational Rehabilitation — License Reinstatement Support',
              url: 'https://rsa.ed.gov/about/states',
              description: 'State VR agencies fund professional license reinstatement costs including PROBE course fees, remediation tuition, and exam fees for individuals with barriers to employment.',
              keywords: ['vocational rehabilitation', 'reinstatement', 'license', 'disability', 'remediation', 'probe'],
      },
      {
              name: 'American Nurses Association — Workforce & Career Resources',
              url: 'https://www.nursingworld.org/practice-policy/workforce/',
              description: 'ANA workforce resources for nurses including return-to-practice support, reinstatement guidance, and connections to state nursing association programs.',
              keywords: ['nursing', 'workforce', 'return to practice', 'reinstatement', 'ana', 'career recovery'],
      },
    ],
    // ---------------------------------------------------------------------
    // APPLICANT-TYPE / CONTEXT categories (not keyed off the literal item).
    // These are selected by the requesting profile's applicant type so that,
    // e.g., a nonprofit asking for ANY item also sees capacity / in-kind /
    // community-foundation funders that routinely cover equipment & vehicles.
    // ---------------------------------------------------------------------
    nonprofit_capacity: [
      {
              name: 'Good360 — Product Philanthropy for Nonprofits',
              url: 'https://good360.org/get-help/nonprofit-membership/',
              description: 'Connects vetted 501(c)(3) nonprofits with billions in donated goods — equipment, supplies, furniture, electronics, and more — from major corporate donors.',
              keywords: ['nonprofit', 'in-kind', 'donation', 'equipment', 'supplies', 'product philanthropy'],
      },
      {
              name: 'Candid / Foundation Directory (Find Funders)',
              url: 'https://candid.org/find-funding',
              description: 'The authoritative directory of U.S. foundations and grantmakers. Search by subject, geography, and support type (including equipment and capital) to find funders for your mission.',
              keywords: ['nonprofit', 'foundation', 'grant', 'directory', 'capacity', 'capital'],
      },
      {
              name: 'GrantWatch — Nonprofit & Equipment Grants',
              url: 'https://www.grantwatch.com/cat/41/nonprofits-grants.html',
              description: 'Curated, searchable listings of foundation, corporate, and government grants for nonprofits, including equipment, vehicle, and capacity-building grants.',
              keywords: ['nonprofit', 'grant', 'equipment', 'capacity building', 'directory'],
      },
      {
              name: 'Grants.gov — Federal Grants for Organizations',
              url: 'https://www.grants.gov/search-grants',
              description: 'Searchable catalog of all federal grant opportunities. Filter by eligibility (nonprofits, public agencies, schools) and category to find funding that can cover equipment and capital needs.',
              keywords: ['nonprofit', 'federal', 'grant', 'organization', 'equipment', 'capital'],
      },
    ],
    community_foundation: [
      {
              name: 'Council on Foundations — Community Foundation Locator',
              url: 'https://www.cof.org/community-foundation-locator',
              description: 'Find your local community foundation. Community foundations make local grants to nonprofits, schools, and projects — frequently funding equipment, vehicles, and program needs in their service area.',
              keywords: ['community foundation', 'local', 'grant', 'nonprofit', 'regional'],
      },
      {
              name: 'United Way — Local Chapter Finder',
              url: 'https://www.unitedway.org/local',
              description: 'Local United Way chapters fund and partner with community nonprofits, often supporting equipment, transportation, and program-delivery needs.',
              keywords: ['united way', 'local', 'community', 'nonprofit', 'grant'],
      },
    ],
    corporate_inkind: [
      {
              name: 'Good360 — Corporate In-Kind Donations',
              url: 'https://good360.org/',
              description: 'Routes excess and new product (electronics, furniture, equipment, supplies) from leading retailers and manufacturers to qualified nonprofits and schools.',
              keywords: ['in-kind', 'corporate', 'donation', 'equipment', 'supplies', 'nonprofit'],
      },
      {
              name: 'TechSoup — Donated & Discounted Tech for Orgs',
              url: 'https://www.techsoup.org/',
              description: 'Donated and deeply discounted software, hardware, and cloud services for nonprofits, libraries, and (in many programs) schools.',
              keywords: ['in-kind', 'technology', 'software', 'hardware', 'nonprofit', 'library'],
      },
      {
              name: 'Benevity / Corporate Community Giving Portals',
              url: 'https://benevity.com/causes',
              description: 'Many large employers run grant and product-giving programs through Benevity. Nonprofits can register to receive corporate grants and in-kind support.',
              keywords: ['corporate giving', 'in-kind', 'grant', 'nonprofit', 'employer'],
      },
    ],
    school_grants: [
      {
              name: 'U.S. Department of Education — Grant Programs',
              url: 'https://www.ed.gov/grants-and-programs',
              description: 'Federal education grant programs for schools and districts, including funding that can support equipment, technology, and program materials.',
              keywords: ['school', 'education', 'federal', 'grant', 'district', 'technology', 'equipment'],
      },
      {
              name: 'NEA Foundation — Grants for Educators',
              url: 'https://www.neafoundation.org/for-educators/',
              description: 'Grants to public-school educators for classroom resources, materials, and learning tools.',
              keywords: ['school', 'teacher', 'educator', 'classroom', 'grant', 'materials'],
      },
      {
              name: 'DonorsChoose — Classroom Project Funding',
              url: 'https://www.donorschoose.org/',
              description: 'Public-school teachers request classroom resources (technology, supplies, equipment) and donors fund them.',
              keywords: ['school', 'teacher', 'classroom', 'technology', 'supplies', 'equipment'],
      },
    ],
    faith_based: [
      {
              name: 'Lilly Endowment / Religion Grant Directories',
              url: 'https://lillyendowment.org/for-grantseekers/',
              description: 'Major funder of religious and community organizations. Good entry point for faith-based ministries seeking program, equipment, and capacity grants.',
              keywords: ['faith-based', 'church', 'ministry', 'religious', 'grant', 'congregation'],
      },
      {
              name: 'ECCU / Christian Community Foundations',
              url: 'https://www.eccu.org/resources',
              description: 'Resources and grant connections for churches and faith-based nonprofits, including vehicle, facility, and equipment needs.',
              keywords: ['faith-based', 'church', 'ministry', 'vehicle', 'equipment', 'facility'],
      },
    ],
    veteran_org: [
      {
              name: 'The Home Depot Foundation — Veteran Nonprofits',
              url: 'https://corporate.homedepot.com/foundation',
              description: 'Grants and product donations to nonprofits serving veterans, including facility, equipment, and vehicle-related projects.',
              keywords: ['veteran', 'nonprofit', 'grant', 'equipment', 'facility', 'corporate giving'],
      },
      {
              name: 'VA — Grants for Veteran-Serving Organizations',
              url: 'https://www.va.gov/grants/',
              description: 'Department of Veterans Affairs grant programs for organizations serving veterans, including transportation and supportive-services grants.',
              keywords: ['veteran', 'va', 'grant', 'organization', 'transportation', 'supportive services'],
      },
    ],
}

/**
 * Normalize whatever profile-ish object we are handed into the
 * `buildProfileSignals()` shape we actually read from. Callers pass either a
 * raw signals object, a `{ signals }` wrapper, or a resolved crawler context.
 */
function resolveSignals(profileLike) {
  if (!profileLike || typeof profileLike !== 'object') return null
  if (profileLike.signals && typeof profileLike.signals === 'object') return profileLike.signals
  // Heuristic: a bare signals object has applicantTypes/needs/location keys.
  if (profileLike.applicantTypes || profileLike.needs || profileLike.applicantType) return profileLike
  return null
}

const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []))

/**
 * Detect the requesting profile's applicant type so we can add the right
 * cross-cutting funder categories. Falls back to neutral (no extra gating) when
 * signals are sparse — missing fields must never EXCLUDE results (canonical G4).
 *
 * Returns one of: 'nonprofit' | 'school' | 'business' | 'individual' | 'unknown'.
 */
function detectApplicantType(signals) {
  if (!signals) return 'unknown'
  const applicantType = String(signals.applicantType || '').toLowerCase()
  const types = toSet(signals.applicantTypes)
  const typeText = [...types].map((t) => String(t).toLowerCase()).join(' ')
  const org = signals.organization || {}

  const isSchool = /school|district|university|college|academy|classroom|teacher|educator/.test(typeText)
  if (isSchool) return 'school'

  if (applicantType === 'organization' || org.is501c3 || org.faithBased ||
      /nonprofit|non-profit|501c3|501\(c\)|foundation|charit|ministry|church|community organization/.test(typeText)) {
    return 'nonprofit'
  }
  if (applicantType === 'business' || /business|startup|entrepreneur|self_employed|llc|sole prop/.test(typeText)) {
    return 'business'
  }
  if (applicantType === 'student' || applicantType === 'individual' || types.size > 0) {
    return 'individual'
  }
  return 'unknown'
}

/**
 * Given an applicant type + base item categories, return the extra
 * cross-cutting KNOWN_ITEM_SOURCES categories that are relevant to who is
 * asking. This is what makes "a nonprofit asking for a van" also surface
 * vehicle-donation-for-nonprofits, in-kind, and community-foundation funders.
 */
function applicantTypeCategories(applicantType, baseCategories, signals) {
  const out = new Set()
  const base = new Set(baseCategories || [])
  const isVehicle = base.has('vehicle') || base.has('van')
  const isTech = base.has('technology')

  if (applicantType === 'nonprofit') {
    out.add('nonprofit_capacity')
    out.add('community_foundation')
    out.add('corporate_inkind')
    if (isVehicle) out.add('nonprofit_vehicle')
    if (signals?.organization?.faithBased) out.add('faith_based')
    if (signals?.military instanceof Set && signals.military.size > 0) out.add('veteran_org')
  } else if (applicantType === 'school') {
    out.add('school_grants')
    out.add('community_foundation')
    out.add('corporate_inkind')
    if (isTech) out.add('school_technology')
    if (isVehicle) out.add('nonprofit_vehicle')
  } else if (applicantType === 'business') {
    out.add('small_business')
  }
  // 'individual' / 'unknown': rely on the item-keyed categories + need signals;
  // do not bolt on org-only funders (keeps individual results precise).
  return [...out]
}

/**
   * Parse the item request to extract what's being asked for and build search queries.
   * When `profileLike` (signals or a {signals} wrapper) is supplied, the requesting
   * profile's applicant type adds relevant funder categories so results match WHO
   * is asking, not just WHAT they asked for.
   */
function parseItemRequest(request, profileLike = null) {
    if (!request || typeof request !== 'string') {
          return { raw: '', type: 'general', categories: [], searchQueries: [], applicantType: 'unknown' }
    }

  const lower = request.toLowerCase().trim()
    const categories = []
        const searchQueries = []

            // Detect categories
            const categoryMap = {
                  vehicle: ['van', 'bus', 'vehicle', 'car', 'truck', 'automobile', 'passenger', 'transport'],
                  van: ['van', '15 passenger', '15-passenger', 'cargo van', 'minivan', 'sprinter'],
                  technology: ['computer', 'laptop', 'software', 'printer', 'technology', 'tablet', 'ipad', 'chromebook', 'server'],
                  equipment: ['equipment', 'machine', 'tool', 'device', 'generator', 'mower', 'tractor'],
                  training: ['class', 'training', 'course', 'certification', 'cpr', 'first aid', 'osha', 'license'],
                  furniture: ['furniture', 'desk', 'chair', 'table', 'cabinet', 'bed', 'mattress', 'couch'],
                  medical_equipment: ['medical equipment', 'hospital bed', 'oxygen', 'nebulizer', 'stethoscope', 'wheelchair', 'walker', 'crutch'],
                  adaptive_equipment: ['adaptive', 'assistive', 'wheelchair ramp', 'stairlift', 'hearing aid', 'braille'],
                  food_truck: ['food truck', 'food cart', 'mobile food', 'food vendor', 'catering business', 'food trailer'],
    small_business: ['small business', 'startup', 'entrepreneur', 'business funding', 'business grant', 'sba'],
    food: ['food', 'groceries', 'meals', 'pantry', 'nutrition'],
                  clothing: ['clothing', 'clothes', 'uniform', 'suit', 'professional attire', 'work clothes'],
                  cpr_certification: ['cpr', 'first aid', 'aed', 'bls', 'heartsaver', 'acls', 'cpr class', 'first aid class', 'cpr certification', 'first aid certification', 'cpr/first aid', 'cpr/aed'],
                  instructor_certification: ['instructor certification', 'cpr instructor', 'first aid instructor', 'bls instructor', 'heartsaver instructor', 'teach cpr', 'teach first aid', 'become an instructor', 'safety trainer'],
                  license_reinstatement: ['probe', 'probe class', 'probe course', 'probe ethics', 'license reinstatement', 'reinstatement course', 'reinstatement class', 'nursing license', 'nursing reinstatement', 'ethics course', 'ethics class', 'remediation', 'remediation course', 'board required', 'board-required', 'professional boundaries', 'return to practice', 'return to nursing', 'relicensing', 'recertification', 'license back', 'nurse reentry', 'nurse re-entry', 'credential restoration'],
            }

  for (const [category, keywords] of Object.entries(categoryMap)) {
        if (keywords.some(kw => lower.includes(kw))) {
                categories.push(category)
        }
  }

  // --- Profile-aware category expansion ---------------------------------
  // Add cross-cutting funder categories based on WHO is asking. Missing
  // signals are neutral (applicantType 'unknown' adds nothing), never
  // exclusionary, per canonical rule G4.
  const signals = resolveSignals(profileLike)
  const applicantType = detectApplicantType(signals)
  for (const extra of applicantTypeCategories(applicantType, categories, signals)) {
        if (!categories.includes(extra)) categories.push(extra)
  }

  // Always-on safety net: a "general" item request from an org should still
  // reach broad funder directories so we never return zero (canonical G2).
  if (categories.length === 0) {
        if (applicantType === 'nonprofit') {
              categories.push('nonprofit_capacity', 'community_foundation')
        } else if (applicantType === 'school') {
              categories.push('school_grants', 'community_foundation')
        } else if (applicantType === 'business') {
              categories.push('small_business')
        } else {
              categories.push('general')
        }
  }

  // Build search queries from the actual item request.
  // Primary query: exactly what was asked for + "free" or "donation" or "grant"
  searchQueries.push(`free ${request}`)
    searchQueries.push(`${request} donation program`)
    searchQueries.push(`${request} grant assistance`)

  // Applicant-type-aware queries: a nonprofit wants funder/in-kind language;
  // a school wants classroom/district grant language.
  if (applicantType === 'nonprofit') {
        searchQueries.push(`${request} grant for nonprofits`)
        searchQueries.push(`${request} in-kind donation nonprofit`)
  } else if (applicantType === 'school') {
        searchQueries.push(`${request} grant for schools`)
        searchQueries.push(`${request} classroom grant`)
  } else if (applicantType === 'business') {
        searchQueries.push(`${request} small business grant`)
  } else {
        searchQueries.push(`${request} nonprofit`)
  }

  // Mission / focus-area keyword (community foundations & corporate giving
  // skew toward mission-aligned applicants).
  const missionKw = signals?.keywordSet instanceof Set
        ? [...signals.keywordSet].find((k) => typeof k === 'string' && k.length >= 4)
        : null
  if (missionKw) searchQueries.push(`${request} ${missionKw} grant`)

  return {
        raw: request,
        type: categories[0],
        categories,
        searchQueries,
        applicantType,
  }
}

/**
 * Search the web for real sources matching the item request.
 * Uses Google search scraping to find real organizations.
 */
async function searchWebForItem(itemRequest, profile) {
    const results = []
        const seenUrls = new Set()
    // Accept a raw signals object, a {signals} wrapper, or a resolved context.
    const signals = resolveSignals(profile)
    const applicantType = detectApplicantType(signals)

  // Build targeted search queries
  const queries = []

      // Base queries from the item itself
      queries.push(`"${itemRequest}" free program`)
    queries.push(`"${itemRequest}" donation nonprofit`)
    queries.push(`"${itemRequest}" grant funding`)

  // Applicant-type-aware queries — surface funders that match WHO is asking.
  if (applicantType === 'nonprofit') {
        queries.push(`"${itemRequest}" grant for nonprofits`)
        queries.push(`"${itemRequest}" in-kind donation 501c3`)
  } else if (applicantType === 'school') {
        queries.push(`"${itemRequest}" grant for schools`)
        queries.push(`"${itemRequest}" classroom grant`)
  } else if (applicantType === 'business') {
        queries.push(`"${itemRequest}" small business grant`)
  }

  // Profile-enhanced queries
  const state = signals?.location?.state
    if (state) {
          // Org applicants benefit from a state community-foundation hint.
          if (applicantType === 'nonprofit' || applicantType === 'school') {
                queries.push(`"${itemRequest}" ${state} community foundation grant`)
          } else {
                queries.push(`"${itemRequest}" free ${state}`)
          }
          queries.push(`"${itemRequest}" program ${state}`)
    }

  // Mission / focus-area aware query (drives community-foundation & corporate
  // giving relevance for org applicants). Neutral when signals are sparse.
  const missionKw = signals?.keywordSet instanceof Set
        ? [...signals.keywordSet].find((k) => typeof k === 'string' && k.length >= 4)
        : null
  if (missionKw && (applicantType === 'nonprofit' || applicantType === 'school')) {
        queries.push(`"${itemRequest}" ${missionKw} grant`)
  }

  // Profile-enhanced queries: use ALL available signals for targeted searches
  if (signals?.military?.size > 0) {
    queries.push(`"${itemRequest}" veteran`)
  }
  if (signals?.assistance instanceof Set && (signals.assistance.has('low_income') || signals.assistance.has('ssi_recipient') || signals.assistance.has('snap_recipient'))) {
    queries.push(`"${itemRequest}" low income assistance`)
  }
  if (signals?.health?.size > 0) {
    queries.push(`"${itemRequest}" disability`)
  }
  if (signals?.family instanceof Set) {
    if (signals.family.has('single_parent')) queries.push(`"${itemRequest}" single parent`)
    if (signals.family.has('foster_youth')) queries.push(`"${itemRequest}" foster youth`)
    if (signals.family.has('homeless')) queries.push(`"${itemRequest}" homeless`)
  }
  if (signals?.demographics instanceof Set) {
    if (signals.demographics.has('senior')) queries.push(`"${itemRequest}" senior elderly`)
    if (signals.demographics.has('youth') || signals.demographics.has('young_adult')) queries.push(`"${itemRequest}" youth`)
  }
  const applicantTypes = signals?.applicantTypes
  if (applicantTypes instanceof Set && applicantTypes.has('student')) {
    queries.push(`"${itemRequest}" student scholarship`)
  }

  // De-duplicate queries (applicant-type + profile dimensions can overlap),
  // then cap at 10 to cover the richer, more targeted query set.
  const uniqueQueries = [...new Set(queries)]
  const searchPromises = uniqueQueries.slice(0, 10).map(async (query) => {
        try {
                const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`

          const response = await getWithRetry(
                    searchUrl,
            {
                        headers: {
                                      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                      'Accept-Language': 'en-US,en;q=0.5',
                        },
            },
            { timeoutMs: 8000, retries: 1 },
                  )

          if (!response?.data) return []

                  const $ = cheerio.load(response.data)
                const found = []

                        // DuckDuckGo HTML results
                        $('.result, .results_links').each((i, elem) => {
                                  if (i >= 8) return // Cap per query

                                                                  const $elem = $(elem)
                                  const titleElem = $elem.find('.result__title a, .result__a')
                                  const title = titleElem.text().trim()
                                  const href = titleElem.attr('href') || ''
                                  const snippet = $elem.find('.result__snippet').text().trim()

                                                                  if (!title || !href) return

                                                                  // Extract the actual URL from DuckDuckGo redirect
                                                                  let actualUrl = href
                                  if (href.includes('uddg=')) {
                                              try {
                                                            const urlParam = new URL(href, 'https://duckduckgo.com')
                                                            actualUrl = urlParam.searchParams.get('uddg') || href
                                              } catch {
                                                            actualUrl = href
                                              }
                                  }

                                                                  // Decode if needed
                                                                  try {
                                                                              actualUrl = decodeURIComponent(actualUrl)
                                                                  } catch (err) {
                                                                              console.warn('[ItemFundingCrawler] URL decode failed:', actualUrl, err.message)
                                                                  }

                                                                  // Skip search engine results pages, ads, and non-useful URLs
                                                                  if (actualUrl.includes('google.com/search') ||
                                                                                  actualUrl.includes('bing.com/search') ||
                                                                                  actualUrl.includes('duckduckgo.com') ||
                                                                                  actualUrl.includes('youtube.com/watch') ||
                                                                                  actualUrl.includes('facebook.com') ||
                                                                                  actualUrl.includes('twitter.com') ||
                                                                                  actualUrl.includes('instagram.com') ||
                                                                                  actualUrl.includes('pinterest.com') ||
                                                                                  actualUrl.includes('amazon.com') ||
                                                                                  actualUrl.includes('ebay.com') ||
                                                                                  actualUrl.includes('walmart.com') ||
                                                                                  actualUrl.includes('target.com')) {
                                                                              return
                                                                  }

                                                                  // Skip if already seen
                                                                  const urlKey = actualUrl.toLowerCase().replace(/\/$/, '')
                                  if (seenUrls.has(urlKey)) return
                                  seenUrls.add(urlKey)

                                                                  found.push({
                                                                              title,
                                                                              url: actualUrl,
                                                                              description: snippet,
                                                                              _search_query: query,
                                                                  })
                        })

          return found
        } catch (error) {
                console.error(`[ItemFundingCrawler] Web search failed for "${query}":`, error.message)
                return []
        }
  })

  const settled = await Promise.allSettled(searchPromises)
    for (const result of settled) {
          if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                  results.push(...result.value)
          } else if (result.status === 'rejected') {
                  console.error('[ItemFundingCrawler] Search promise rejected:', result.reason)
          }
    }

  return results
}

function finalizeItemResults(rows, { facets, queryPlan }) {
  return rows
    .map((row) =>
      enforceCrawlerOpportunityContract(row, {
        crawlerType: 'item_matching',
        facets,
        queryPlan,
        sourceFallback: row?.source ?? row?.sponsor ?? 'Item funding',
      }),
    )
    .filter(Boolean)
}

export async function crawlItemFunding(profileInput, options = {}) {
    const { profile, signals, facets, queryPlan: queryPlanFromContext } = resolveCrawlerContext(profileInput, options)
    const queryPlan =
        queryPlanFromContext ??
        planCrawlerQueries({
              crawlerType: 'item_matching',
              facets,
              location: facets?.geo ?? signals?.location ?? {},
              // All resolved addresses so local funding is crawled for both home + school.
              locations: Array.isArray(signals?.locations) && signals.locations.length
                ? signals.locations
                : null,
        })
    const results = []
        const itemRequest = options.item_request

  if (!itemRequest) {
        log.info('[ItemFundingCrawler] No item request specified')
        return results
  }

    const searchKeywords = signals ? mergePlanKeywords(buildSearchKeywords(profile, 10), queryPlan).slice(0, 20) : []
        // Pass profile signals so categories reflect WHO is asking (applicant type),
        // not just WHAT the item is.
        const parsed = parseItemRequest(itemRequest, signals)

  log.info(`[ItemFundingCrawler] Searching for: "${itemRequest}"`)
    log.info(`[ItemFundingCrawler] Detected categories: ${parsed.categories.join(', ')}`)
    log.info(`[ItemFundingCrawler] Applicant type: ${parsed.applicantType}`)
    log.info(`[ItemFundingCrawler] Profile: ${profile.display_name || profile.name || 'Unknown'}`)

  const seenUrls = new Set()

  // === 1. KNOWN SOURCES for detected categories ===
  for (const category of parsed.categories) {
        const sources = KNOWN_ITEM_SOURCES[category] || []
              for (const source of sources) {
                      if (seenUrls.has(source.url)) continue
                      seenUrls.add(source.url)

          const opp = {
                    title: `${source.name} — ${category.replace(/_/g, ' ')}`,
                    sponsor: source.name,
                    description: source.description,
                    url: source.url,
                    application_url: source.url,
                    source_url: source.url,
                    amount_min: 0,
                    amount_max: 0,
                    amount_description: 'See source for program details',
                    deadline: null,
                    deadline_type: 'rolling',
                    eligibility: `See ${source.name} website for eligibility`,
                    is_national: true,
                    categories: [category, 'item_funding'],
                    keywords: [...(source.keywords || []), itemRequest.toLowerCase()],
                    opportunity_type: 'program',
                    item_requested: itemRequest,
          }

          // Apply centralized policy (URL, placeholder, loan, matching-funds) before scoring
          if (!enforceOpportunityPolicy(opp).ok) continue

          // Score using profile if available
          let matchScore = 60 // Base score for category match
          let reasons = [`Known source for ${category.replace(/_/g, ' ')}`]
                      let matchedSignals = []

                              if (signals) {
                                        const result = calculateMatchScore(profile, opp)
                                        matchScore = Math.max(matchScore, result.score)
                                        reasons = [...result.reasons, ...reasons]
                                        matchedSignals = result.matchedSignals || []
                              }

          results.push({
                    ...opp,
                    match_score: Math.min(100, matchScore + 10), // Category bonus
                    match_reasons: reasons,
                    matched_signals: matchedSignals,
                    crawler_type: 'item_funding',
                    source: source.name,
          })
              }
  }

  // === 2. LIVE WEB SEARCH for the specific item ===
  try {
        log.info(`[ItemFundingCrawler] Searching web for "${itemRequest}"...`)
        // Pass signals (wrapped) so web queries are applicant-type/profile aware.
        const rawWebResults = await searchWebForItem(itemRequest, { profile, signals })
        const webResults = Array.isArray(rawWebResults) && rawWebResults !== null ? rawWebResults : []

      log.info(`[ItemFundingCrawler] Web search found ${webResults.length} results`)

      for (const webResult of webResults) {
              const urlKey = (webResult.url || '').toLowerCase().replace(/\/$/, '')
              if (seenUrls.has(urlKey)) continue
              seenUrls.add(urlKey)

          const opp = {
                    title: webResult.title,
                    sponsor: extractDomain(webResult.url),
                    description: webResult.description || `Found via web search for "${itemRequest}"`,
                    url: webResult.url,
                    application_url: webResult.url,
                    source_url: webResult.url,
                    amount_min: 0,
                    amount_max: 0,
                    amount_description: 'See source for details',
                    deadline: null,
                    deadline_type: 'rolling',
                    eligibility: 'See source website',
                    is_national: true,
                    categories: [...parsed.categories, 'item_funding'],
                    keywords: [itemRequest.toLowerCase(), ...parsed.categories],
                    opportunity_type: 'program',
                    item_requested: itemRequest,
          }

          // Score: web results start lower and get boosted by profile match
          let matchScore = 50
              let reasons = [`Web search result for "${itemRequest}"`]
              let matchedSignals = []

                      if (signals) {
                                const result = calculateMatchScore(profile, opp)
                                matchScore = Math.max(matchScore, result.score)
                                reasons = [...result.reasons, ...reasons]
                                matchedSignals = result.matchedSignals || []
                      }

          // Boost if the title/description mentions the specific item
          const itemWords = itemRequest.toLowerCase().split(/\s+/).filter(w => w.length >= 3)
              const resultText = `${webResult.title} ${webResult.description}`.toLowerCase()
              const wordMatches = itemWords.filter(w => resultText.includes(w)).length
              const itemRelevance = itemWords.length > 0 ? wordMatches / itemWords.length : 0

          if (itemRelevance >= 0.5) {
                    matchScore = Math.min(100, matchScore + 15)
                    reasons.push(`High item relevance: ${Math.round(itemRelevance * 100)}% keyword match`)
          } else if (itemRelevance >= 0.25) {
                    matchScore = Math.min(100, matchScore + 8)
                    reasons.push(`Partial item relevance: ${Math.round(itemRelevance * 100)}% keyword match`)
          }

          if (matchScore >= 40) { // Lower threshold for web results - we want to show real finds
                results.push({
                            ...opp,
                            match_score: matchScore,
                            match_reasons: reasons,
                            matched_signals: matchedSignals,
                            crawler_type: 'item_funding',
                            source: 'Web Search',
                            _discovery_method: 'web_search',
                })
          }
      }
  } catch (error) {
        console.error(`[ItemFundingCrawler] Web search error:`, error.message)
  }

  // === 3. ZERO-RESULT SAFETY NET (canonical G2) ===
  // If nothing matched (e.g. live web search is unavailable because no network/
  // search keys, AND the item didn't map to a known category), still return real,
  // broad funder directories appropriate to the applicant type. Never return an
  // empty set for a reasonable request.
  if (results.length === 0) {
        const fallbackCategories =
              parsed.applicantType === 'school'
                    ? ['school_grants', 'community_foundation', 'corporate_inkind']
                    : parsed.applicantType === 'business'
                          ? ['small_business']
                          : ['nonprofit_capacity', 'community_foundation', 'corporate_inkind']
        log.info(`[ItemFundingCrawler] Zero results — applying ${parsed.applicantType} fallback directories`)
        for (const category of fallbackCategories) {
              for (const source of KNOWN_ITEM_SOURCES[category] || []) {
                    const urlKey = source.url.toLowerCase().replace(/\/$/, '')
                    if (seenUrls.has(urlKey)) continue
                    seenUrls.add(urlKey)
                    const opp = {
                          title: `${source.name} — ${category.replace(/_/g, ' ')}`,
                          sponsor: source.name,
                          description: source.description,
                          url: source.url,
                          application_url: source.url,
                          source_url: source.url,
                          amount_min: 0,
                          amount_max: 0,
                          amount_description: 'See source for program details',
                          deadline: null,
                          deadline_type: 'rolling',
                          eligibility: `See ${source.name} website for eligibility`,
                          is_national: true,
                          categories: [category, 'item_funding'],
                          keywords: [...(source.keywords || []), itemRequest.toLowerCase()],
                          opportunity_type: 'program',
                          item_requested: itemRequest,
                    }
                    if (!enforceOpportunityPolicy(opp).ok) continue
                    results.push({
                          ...opp,
                          match_score: 45,
                          match_reasons: [
                                `Broad funder directory relevant to ${parsed.applicantType === 'unknown' ? 'your organization' : parsed.applicantType} applicants`,
                                'Shown because no exact item match was found (start here)',
                          ],
                          matched_signals: [],
                          crawler_type: 'item_funding',
                          source: source.name,
                          _discovery_method: 'fallback_directory',
                    })
              }
        }
  }

  // Sort by match score
  results.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

  // Cap results
  const capped = results.slice(0, 30)

  log.info(`[ItemFundingCrawler] Found ${capped.length} real sources for "${itemRequest}"`)
    return finalizeItemResults(capped, { facets, queryPlan })
}

function extractDomain(url) {
    try {
          const parsed = new URL(url)
          return parsed.hostname.replace('www.', '')
    } catch {
          return 'Unknown'
    }
}

// Function removed - loan filtering is handled by enforceOpportunityPolicy

export { searchWebForItem, KNOWN_ITEM_SOURCES, parseItemRequest }
export default { crawlItemFunding, searchWebForItem, KNOWN_ITEM_SOURCES, parseItemRequest }
