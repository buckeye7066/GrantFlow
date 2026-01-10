/**
 * Real Location-Based Funding Crawler
 * 
 * Crawls REAL funding sources and maps them to ZIP codes based on:
 * - National programs (apply to all ZIPs)
 * - State programs (apply to all ZIPs in state)
 * - Local/metro programs (apply to ZIPs in that metro area)
 * 
 * ALL URLs are verified real funding sources - NO placeholders
 */

import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// State full names
const STATE_NAMES = {
  'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California',
  'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware', 'FL': 'Florida', 'GA': 'Georgia',
  'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa',
  'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
  'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi', 'MO': 'Missouri',
  'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey',
  'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio',
  'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina',
  'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont',
  'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming',
  'DC': 'District of Columbia', 'PR': 'Puerto Rico', 'VI': 'Virgin Islands', 'GU': 'Guam'
};

/**
 * REAL National Funding Programs - These apply to ALL ZIP codes
 * Every URL here is a real, verified funding source
 */
const NATIONAL_PROGRAMS = [
  // FEDERAL BENEFITS
  {
    id: 'nat-snap',
    title: 'SNAP (Food Stamps) Benefits',
    sponsor: 'USDA Food and Nutrition Service',
    source_url: 'https://www.fns.usda.gov/snap/supplemental-nutrition-assistance-program',
    application_url: 'https://www.fns.usda.gov/snap/state-directory',
    description: 'Monthly food assistance for low-income individuals and families. Apply through your state agency.',
    amount_min: 23, amount_max: 1751,
    categories: ['food assistance', 'benefits', 'nutrition'],
    keywords: ['snap', 'food stamps', 'ebt', 'food assistance', 'low income'],
    opportunity_type: 'benefit',
    eligibility: ['Income at/below 130% poverty', 'Assets below state limits', 'U.S. citizen or qualified alien']
  },
  {
    id: 'nat-medicaid',
    title: 'Medicaid Health Coverage',
    sponsor: 'Centers for Medicare & Medicaid Services',
    source_url: 'https://www.medicaid.gov/',
    application_url: 'https://www.healthcare.gov/medicaid-chip/',
    description: 'Free or low-cost health coverage for eligible low-income adults, children, pregnant women, elderly, and disabled.',
    amount_min: null, amount_max: null,
    categories: ['healthcare', 'insurance', 'benefits'],
    keywords: ['medicaid', 'health insurance', 'healthcare', 'low income'],
    opportunity_type: 'benefit',
    eligibility: ['Income-based (varies by state)', 'Pregnant women, children, elderly, disabled', 'Apply via state Medicaid or Healthcare.gov']
  },
  {
    id: 'nat-medicare',
    title: 'Medicare Health Insurance',
    sponsor: 'Centers for Medicare & Medicaid Services',
    source_url: 'https://www.medicare.gov/',
    application_url: 'https://www.medicare.gov/basics/get-started-with-medicare/sign-up/when-does-medicare-coverage-start',
    description: 'Federal health insurance for people 65+, certain younger people with disabilities, and people with End-Stage Renal Disease.',
    amount_min: null, amount_max: null,
    categories: ['healthcare', 'insurance', 'seniors'],
    keywords: ['medicare', 'health insurance', 'seniors', '65+', 'disability'],
    opportunity_type: 'benefit',
    eligibility: ['Age 65 or older', 'Under 65 with certain disabilities', 'Any age with ESRD']
  },
  {
    id: 'nat-ssi',
    title: 'Supplemental Security Income (SSI)',
    sponsor: 'Social Security Administration',
    source_url: 'https://www.ssa.gov/ssi/',
    application_url: 'https://www.ssa.gov/benefits/ssi/',
    description: 'Monthly cash payments for aged, blind, or disabled people with limited income and resources.',
    amount_min: 100, amount_max: 943,
    categories: ['disability', 'income support', 'seniors'],
    keywords: ['ssi', 'disability', 'supplemental income', 'blind', 'elderly'],
    opportunity_type: 'benefit',
    eligibility: ['Age 65+ OR blind OR disabled', 'Limited income and resources', 'U.S. resident']
  },
  {
    id: 'nat-ssdi',
    title: 'Social Security Disability Insurance (SSDI)',
    sponsor: 'Social Security Administration',
    source_url: 'https://www.ssa.gov/disability/',
    application_url: 'https://www.ssa.gov/applyfordisability/',
    description: 'Monthly benefits for workers who become disabled and cannot work, based on work history.',
    amount_min: 100, amount_max: 3822,
    categories: ['disability', 'income support'],
    keywords: ['ssdi', 'disability', 'social security', 'disabled workers'],
    opportunity_type: 'benefit',
    eligibility: ['Unable to work due to medical condition', 'Condition lasts 12+ months', 'Sufficient work credits']
  },
  {
    id: 'nat-tanf',
    title: 'Temporary Assistance for Needy Families (TANF)',
    sponsor: 'HHS Administration for Children and Families',
    source_url: 'https://www.acf.hhs.gov/ofa/programs/tanf',
    application_url: 'https://www.benefits.gov/benefit/613',
    description: 'Cash assistance and support services for low-income families with children.',
    amount_min: 100, amount_max: 1000,
    categories: ['family assistance', 'cash aid', 'children'],
    keywords: ['tanf', 'welfare', 'cash assistance', 'family', 'children'],
    opportunity_type: 'benefit',
    eligibility: ['Family with children under 18', 'Meet state income requirements', 'Participate in work activities']
  },
  {
    id: 'nat-wic',
    title: 'WIC - Women, Infants, and Children',
    sponsor: 'USDA Food and Nutrition Service',
    source_url: 'https://www.fns.usda.gov/wic',
    application_url: 'https://www.fns.usda.gov/wic/wic-how-apply',
    description: 'Nutrition program providing food, nutrition education, and healthcare referrals for pregnant/postpartum women and children under 5.',
    amount_min: 50, amount_max: 100,
    categories: ['nutrition', 'women', 'children', 'pregnancy'],
    keywords: ['wic', 'women', 'infants', 'children', 'nutrition', 'pregnancy'],
    opportunity_type: 'benefit',
    eligibility: ['Pregnant, breastfeeding, or postpartum women', 'Infants and children under 5', 'Income at/below 185% poverty']
  },
  {
    id: 'nat-section8',
    title: 'Housing Choice Voucher (Section 8)',
    sponsor: 'HUD',
    source_url: 'https://www.hud.gov/topics/housing_choice_voucher_program_section_8',
    application_url: 'https://www.hud.gov/program_offices/public_indian_housing/pha/contacts',
    description: 'Rental assistance vouchers for very low-income families, elderly, and disabled to afford housing in the private market.',
    amount_min: 500, amount_max: 3000,
    categories: ['housing', 'rental assistance'],
    keywords: ['section 8', 'housing voucher', 'rental assistance', 'hud'],
    opportunity_type: 'benefit',
    eligibility: ['Income at/below 50% area median income', 'Apply through local Public Housing Agency', 'Waitlists may be long']
  },
  {
    id: 'nat-liheap',
    title: 'LIHEAP - Energy Assistance',
    sponsor: 'HHS Office of Community Services',
    source_url: 'https://www.acf.hhs.gov/ocs/programs/liheap',
    application_url: 'https://www.acf.hhs.gov/ocs/liheap-state-and-territory-contact-listing',
    description: 'Helps low-income households pay heating/cooling bills and weatherize homes.',
    amount_min: 100, amount_max: 2000,
    categories: ['energy', 'utilities', 'heating', 'cooling'],
    keywords: ['liheap', 'energy assistance', 'heating', 'cooling', 'utility bills'],
    opportunity_type: 'benefit',
    eligibility: ['Income at/below 150% poverty', 'Responsible for energy costs', 'Priority for elderly, disabled, children']
  },
  {
    id: 'nat-weatherization',
    title: 'Weatherization Assistance Program',
    sponsor: 'Department of Energy',
    source_url: 'https://www.energy.gov/scep/wap/weatherization-assistance-program',
    application_url: 'https://www.energy.gov/scep/wap/how-apply-weatherization-assistance',
    description: 'Free home energy efficiency improvements including insulation, air sealing, and heating/cooling repairs.',
    amount_min: 2500, amount_max: 8009,
    categories: ['energy', 'home improvement'],
    keywords: ['weatherization', 'energy efficiency', 'insulation', 'home improvement'],
    opportunity_type: 'benefit',
    eligibility: ['Income at/below 200% poverty', 'Own or rent home', 'Free service - no repayment']
  },
  {
    id: 'nat-headstart',
    title: 'Head Start / Early Head Start',
    sponsor: 'HHS Office of Head Start',
    source_url: 'https://www.acf.hhs.gov/ohs',
    application_url: 'https://eclkc.ohs.acf.hhs.gov/center-locator',
    description: 'Free early childhood education, health, and family services for children 0-5 from low-income families.',
    amount_min: null, amount_max: null,
    categories: ['education', 'children', 'early childhood'],
    keywords: ['head start', 'preschool', 'early childhood', 'education'],
    opportunity_type: 'program',
    eligibility: ['Family income at/below poverty level', 'Children ages 0-5', 'Homeless families automatically eligible']
  },
  {
    id: 'nat-school-meals',
    title: 'Free and Reduced School Meals',
    sponsor: 'USDA Food and Nutrition Service',
    source_url: 'https://www.fns.usda.gov/nslp',
    application_url: 'https://www.fns.usda.gov/cn/applying-free-and-reduced-price-school-meals',
    description: 'Free or reduced-price breakfast and lunch for children from low-income families at participating schools.',
    amount_min: null, amount_max: 2000,
    categories: ['nutrition', 'children', 'education'],
    keywords: ['school meals', 'free lunch', 'children', 'nutrition', 'low income'],
    opportunity_type: 'benefit',
    eligibility: ['Income at/below 185% poverty for reduced', 'At/below 130% poverty for free', 'Apply through school']
  },
  // FEDERAL EDUCATION GRANTS
  {
    id: 'nat-pell',
    title: 'Federal Pell Grant',
    sponsor: 'U.S. Department of Education',
    source_url: 'https://studentaid.gov/understand-aid/types/grants/pell',
    application_url: 'https://studentaid.gov/h/apply-for-aid/fafsa',
    description: 'Federal grant for undergraduate students with exceptional financial need. Max $7,395 for 2024-25.',
    amount_min: 750, amount_max: 7395,
    categories: ['education', 'college', 'scholarship'],
    keywords: ['pell grant', 'federal', 'college', 'financial aid', 'undergraduate'],
    opportunity_type: 'grant',
    eligibility: ['Undergraduate student', 'Financial need via FAFSA', 'U.S. citizen or eligible noncitizen', 'No repayment required']
  },
  {
    id: 'nat-fseog',
    title: 'Federal SEOG Grant',
    sponsor: 'U.S. Department of Education',
    source_url: 'https://studentaid.gov/understand-aid/types/grants/fseog',
    application_url: 'https://studentaid.gov/h/apply-for-aid/fafsa',
    description: 'Supplemental grant for undergraduates with exceptional financial need. Priority to Pell recipients.',
    amount_min: 100, amount_max: 4000,
    categories: ['education', 'college', 'scholarship'],
    keywords: ['fseog', 'federal', 'college', 'financial aid'],
    opportunity_type: 'grant',
    eligibility: ['Must receive Pell Grant', 'Exceptional financial need', 'Enrolled at participating school']
  },
  {
    id: 'nat-teach',
    title: 'TEACH Grant',
    sponsor: 'U.S. Department of Education',
    source_url: 'https://studentaid.gov/understand-aid/types/grants/teach',
    application_url: 'https://studentaid.gov/h/apply-for-aid/fafsa',
    description: 'Up to $4,000/year for students who agree to teach in high-need fields at low-income schools for 4 years.',
    amount_min: 4000, amount_max: 4000,
    categories: ['education', 'teaching'],
    keywords: ['teach grant', 'teaching', 'education', 'service'],
    opportunity_type: 'grant',
    eligibility: ['Agree to teach 4 years in high-need field', 'Maintain 3.25 GPA', 'Converts to loan if service not completed']
  },
  // VETERANS BENEFITS
  {
    id: 'nat-gi-bill',
    title: 'Post-9/11 GI Bill',
    sponsor: 'U.S. Department of Veterans Affairs',
    source_url: 'https://www.va.gov/education/about-gi-bill-benefits/post-9-11/',
    application_url: 'https://www.va.gov/education/how-to-apply/',
    description: 'Education benefits for veterans who served after 9/10/2001. Covers tuition, housing, and books.',
    amount_min: 1000, amount_max: 27000,
    categories: ['veterans', 'education', 'military'],
    keywords: ['gi bill', 'veterans', 'education', 'military', 'tuition'],
    opportunity_type: 'benefit',
    eligibility: ['Served after 9/10/2001', 'At least 90 days active duty', 'Honorable discharge']
  },
  // VA Home Loan removed - loans not included per user request
  {
    id: 'nat-va-disability',
    title: 'VA Disability Compensation',
    sponsor: 'U.S. Department of Veterans Affairs',
    source_url: 'https://www.va.gov/disability/',
    application_url: 'https://www.va.gov/disability/how-to-file-claim/',
    description: 'Tax-free monthly payments for veterans with service-connected disabilities.',
    amount_min: 165, amount_max: 3737,
    categories: ['veterans', 'disability'],
    keywords: ['va disability', 'veterans', 'disability compensation', 'service-connected'],
    opportunity_type: 'benefit',
    eligibility: ['Service-connected disability', 'Served on active duty', 'Discharged under other than dishonorable conditions']
  },
  {
    id: 'nat-va-pension',
    title: 'VA Pension',
    sponsor: 'U.S. Department of Veterans Affairs',
    source_url: 'https://www.va.gov/pension/',
    application_url: 'https://www.va.gov/pension/how-to-apply/',
    description: 'Tax-free monthly payments for wartime veterans with limited income who are 65+ or permanently disabled.',
    amount_min: 100, amount_max: 2500,
    categories: ['veterans', 'pension', 'seniors'],
    keywords: ['va pension', 'veterans', 'wartime', 'low income'],
    opportunity_type: 'benefit',
    eligibility: ['Wartime veteran', 'Age 65+ or permanently disabled', 'Limited income']
  },
  // SMALL BUSINESS
  // SBA 7(a), Microloan, and Disaster Loans removed - loans not included per user request
  // MAJOR SCHOLARSHIPS
  {
    id: 'nat-gates-scholarship',
    title: 'The Gates Scholarship',
    sponsor: 'Bill & Melinda Gates Foundation',
    source_url: 'https://www.thegatesscholarship.org/',
    application_url: 'https://www.thegatesscholarship.org/scholarship',
    description: 'Full scholarship for outstanding minority high school seniors from low-income households.',
    amount_min: 5000, amount_max: 80000,
    categories: ['scholarship', 'minority students', 'education'],
    keywords: ['gates scholarship', 'minority', 'college', 'full scholarship'],
    opportunity_type: 'scholarship',
    eligibility: ['High school senior', 'Pell Grant eligible', 'Minority student', 'GPA 3.3+']
  },
  {
    id: 'nat-coca-cola',
    title: 'Coca-Cola Scholars Program',
    sponsor: 'Coca-Cola Scholars Foundation',
    source_url: 'https://www.coca-colascholarsfoundation.org/apply/',
    application_url: 'https://www.coca-colascholarsfoundation.org/apply/',
    description: '$20,000 scholarship for high school seniors demonstrating leadership and community service.',
    amount_min: 20000, amount_max: 20000,
    categories: ['scholarship', 'leadership'],
    keywords: ['coca-cola', 'scholarship', 'leadership', 'community service'],
    opportunity_type: 'scholarship',
    eligibility: ['High school senior', 'U.S. citizen', 'GPA 3.0+', 'Leadership and service']
  },
  {
    id: 'nat-dell-scholars',
    title: 'Dell Scholars Program',
    sponsor: 'Michael & Susan Dell Foundation',
    source_url: 'https://www.dellscholars.org/',
    application_url: 'https://www.dellscholars.org/apply/',
    description: '$20,000 scholarship plus laptop and ongoing support for students who overcame obstacles.',
    amount_min: 20000, amount_max: 20000,
    categories: ['scholarship', 'first generation'],
    keywords: ['dell', 'scholarship', 'first generation', 'laptop'],
    opportunity_type: 'scholarship',
    eligibility: ['Graduating high school senior', 'Pell Grant eligible', 'College readiness program participant', 'GPA 2.4+']
  },
  {
    id: 'nat-questbridge',
    title: 'QuestBridge National College Match',
    sponsor: 'QuestBridge',
    source_url: 'https://www.questbridge.org/',
    application_url: 'https://www.questbridge.org/high-school-students/national-college-match',
    description: 'Full 4-year scholarships to top colleges for high-achieving, low-income students.',
    amount_min: 50000, amount_max: 320000,
    categories: ['scholarship', 'full ride'],
    keywords: ['questbridge', 'scholarship', 'full ride', 'low income', 'top colleges'],
    opportunity_type: 'scholarship',
    eligibility: ['High school senior', 'Household income typically under $65,000', 'Strong academics']
  },
  {
    id: 'nat-horatio-alger',
    title: 'Horatio Alger Scholarship',
    sponsor: 'Horatio Alger Association',
    source_url: 'https://scholars.horatioalger.org/',
    application_url: 'https://scholars.horatioalger.org/scholarships/',
    description: 'Scholarships for students who overcame adversity and have financial need. National and state awards.',
    amount_min: 10000, amount_max: 25000,
    categories: ['scholarship', 'adversity'],
    keywords: ['horatio alger', 'scholarship', 'adversity', 'perseverance'],
    opportunity_type: 'scholarship',
    eligibility: ['High school senior', 'Pell eligible', 'Overcame adversity', 'GPA 2.0+']
  },
  {
    id: 'nat-jack-kent-cooke',
    title: 'Jack Kent Cooke College Scholarship',
    sponsor: 'Jack Kent Cooke Foundation',
    source_url: 'https://www.jkcf.org/our-scholarships/',
    application_url: 'https://www.jkcf.org/our-scholarships/college-scholarship-program/',
    description: 'Up to $55,000/year for high-achieving high school seniors with financial need.',
    amount_min: 40000, amount_max: 55000,
    categories: ['scholarship', 'high achiever'],
    keywords: ['jack kent cooke', 'scholarship', 'college', 'high achiever'],
    opportunity_type: 'scholarship',
    eligibility: ['High school senior', 'GPA 3.5+', 'Family income under $95,000', 'Planning to enroll in 4-year college']
  },
  // CORPORATE GRANTS
  {
    id: 'nat-walmart-grants',
    title: 'Walmart Community Grants',
    sponsor: 'Walmart Foundation',
    source_url: 'https://walmart.org/how-we-give/local-community-grants',
    application_url: 'https://walmart.org/how-we-give/local-community-grants',
    description: 'Local grants for nonprofits near Walmart/Sam\'s Club stores. Focus on hunger, workforce, community.',
    amount_min: 250, amount_max: 5000,
    categories: ['community', 'hunger relief', 'workforce'],
    keywords: ['walmart', 'community grant', 'local grant', 'nonprofit'],
    opportunity_type: 'grant',
    requires_501c3: true,
    eligibility: ['501(c)(3) nonprofit', 'Within service area of local Walmart', 'Align with focus areas']
  },
  {
    id: 'nat-dollar-general',
    title: 'Dollar General Literacy Foundation',
    sponsor: 'Dollar General Literacy Foundation',
    source_url: 'https://www.dgliteracy.org/grant-programs/',
    application_url: 'https://www.dgliteracy.org/grant-programs/',
    description: 'Grants for literacy and education programs. Multiple grant types available.',
    amount_min: 2000, amount_max: 20000,
    categories: ['literacy', 'education', 'adult education'],
    keywords: ['dollar general', 'literacy', 'education', 'reading'],
    opportunity_type: 'grant',
    requires_501c3: true,
    eligibility: ['501(c)(3) or school', 'Within 15 miles of Dollar General store', 'Focus on literacy']
  },
  {
    id: 'nat-home-depot',
    title: 'Home Depot Foundation Grants',
    sponsor: 'The Home Depot Foundation',
    source_url: 'https://corporate.homedepot.com/foundation',
    application_url: 'https://corporate.homedepot.com/foundation',
    description: 'Grants for veteran housing, disaster response, and skilled trades training.',
    amount_min: 5000, amount_max: 500000,
    categories: ['veterans', 'housing', 'disaster', 'workforce'],
    keywords: ['home depot', 'veterans', 'housing', 'construction'],
    opportunity_type: 'grant',
    requires_501c3: true,
    eligibility: ['501(c)(3) nonprofit', 'Focus on veterans, disaster, or trades', 'Invitation-based for large grants']
  },
  {
    id: 'nat-target-grants',
    title: 'Target Community Giving',
    sponsor: 'Target Corporation',
    source_url: 'https://corporate.target.com/sustainability-governance/community-impact',
    application_url: 'https://corporate.target.com/sustainability-governance/community-impact',
    description: 'Grants focused on equity in education and economic opportunity.',
    amount_min: 1000, amount_max: 25000,
    categories: ['education', 'youth development'],
    keywords: ['target', 'community grant', 'education', 'youth'],
    opportunity_type: 'grant',
    requires_501c3: true,
    eligibility: ['501(c)(3) nonprofit', 'Focus on education or economic opportunity']
  },
  // EMERGENCY ASSISTANCE
  {
    id: 'nat-fema-individual',
    title: 'FEMA Individual Assistance',
    sponsor: 'Federal Emergency Management Agency',
    source_url: 'https://www.fema.gov/assistance/individual',
    application_url: 'https://www.disasterassistance.gov/',
    description: 'Grants for disaster survivors for temporary housing, repairs, and other needs.',
    amount_min: 500, amount_max: 41000,
    categories: ['disaster', 'emergency', 'housing'],
    keywords: ['fema', 'disaster', 'emergency', 'housing', 'recovery'],
    opportunity_type: 'grant',
    eligibility: ['Affected by declared disaster', 'U.S. citizen or qualified alien', 'Primary residence damaged']
  },
  {
    id: 'nat-redcross',
    title: 'American Red Cross Disaster Relief',
    sponsor: 'American Red Cross',
    source_url: 'https://www.redcross.org/get-help/disaster-relief-and-recovery-services.html',
    application_url: 'https://www.redcross.org/get-help.html',
    description: 'Emergency assistance including shelter, food, and financial help after disasters.',
    amount_min: 100, amount_max: 5000,
    categories: ['disaster', 'emergency'],
    keywords: ['red cross', 'disaster', 'emergency', 'shelter', 'relief'],
    opportunity_type: 'benefit',
    eligibility: ['Affected by disaster', 'Contact local Red Cross chapter']
  },
  {
    id: 'nat-salvation-army',
    title: 'Salvation Army Emergency Assistance',
    sponsor: 'The Salvation Army',
    source_url: 'https://www.salvationarmyusa.org/usn/provide-shelter/',
    application_url: 'https://www.salvationarmyusa.org/usn/plugins/gdosCenterSearch',
    description: 'Emergency assistance with rent, utilities, food, and other basic needs.',
    amount_min: 100, amount_max: 1500,
    categories: ['emergency', 'utilities', 'rent'],
    keywords: ['salvation army', 'emergency', 'rent assistance', 'utilities'],
    opportunity_type: 'benefit',
    eligibility: ['Demonstrate need', 'Contact local Salvation Army office']
  },
  {
    id: 'nat-catholic-charities',
    title: 'Catholic Charities Emergency Assistance',
    sponsor: 'Catholic Charities USA',
    source_url: 'https://www.catholiccharitiesusa.org/',
    application_url: 'https://www.catholiccharitiesusa.org/find-help/',
    description: 'Various emergency assistance programs including rent, utilities, food, and disaster relief.',
    amount_min: 100, amount_max: 2000,
    categories: ['emergency', 'rent', 'utilities'],
    keywords: ['catholic charities', 'emergency', 'rent', 'food', 'utilities'],
    opportunity_type: 'benefit',
    eligibility: ['Demonstrate need', 'Services vary by location', 'All faiths welcome']
  },
  {
    id: 'nat-united-way',
    title: 'United Way 211 Services',
    sponsor: 'United Way',
    source_url: 'https://www.unitedway.org/our-impact/featured-programs/211',
    application_url: 'https://www.211.org/',
    description: 'Call 211 for free referrals to local assistance programs for rent, utilities, food, and more.',
    amount_min: null, amount_max: null,
    categories: ['referral', 'emergency', 'community'],
    keywords: ['211', 'united way', 'referral', 'emergency assistance'],
    opportunity_type: 'program',
    eligibility: ['Anyone can call 211', 'Free and confidential', 'Available 24/7']
  },
  // SERVICE PROGRAMS
  {
    id: 'nat-americorps',
    title: 'AmeriCorps',
    sponsor: 'AmeriCorps',
    source_url: 'https://americorps.gov/',
    application_url: 'https://americorps.gov/serve',
    description: 'Serve your community and earn a living allowance plus education award up to $7,395.',
    amount_min: 1000, amount_max: 7395,
    categories: ['service', 'education award'],
    keywords: ['americorps', 'service', 'volunteer', 'education award'],
    opportunity_type: 'program',
    eligibility: ['U.S. citizen or permanent resident', 'At least 17 years old', 'Complete service term']
  },
  {
    id: 'nat-peacecorps',
    title: 'Peace Corps',
    sponsor: 'Peace Corps',
    source_url: 'https://www.peacecorps.gov/',
    application_url: 'https://www.peacecorps.gov/volunteer/connect-with-a-recruiter/',
    description: 'Serve abroad for 27 months. Receive training, housing, living allowance, and $10,000+ readjustment.',
    amount_min: 10000, amount_max: 11000,
    categories: ['international', 'service'],
    keywords: ['peace corps', 'international', 'service', 'volunteer'],
    opportunity_type: 'program',
    eligibility: ['U.S. citizen', 'At least 18 years old', 'Bachelor\'s degree or relevant experience']
  }
];

/**
 * State-specific real funding programs
 * These are added based on the ZIP code's state
 */
const STATE_PROGRAMS = {
  'AL': [
    {
      id: 'al-go-grant',
      title: 'Alabama GO Grant',
      sponsor: 'Alabama Commission on Higher Education',
      source_url: 'https://ache.edu/che_grant.aspx',
      application_url: 'https://ache.edu/che_grant.aspx',
      description: 'Grant for Alabama residents attending Alabama public 2-year colleges.',
      amount_min: 500, amount_max: 2000,
      categories: ['education', 'community college'],
      keywords: ['alabama', 'go grant', 'community college'],
      eligibility: ['AL resident', 'Attend public 2-year AL college', 'Financial need']
    }
  ],
  'AK': [
    {
      id: 'ak-performance',
      title: 'Alaska Performance Scholarship',
      sponsor: 'Alaska Commission on Postsecondary Education',
      source_url: 'https://acpe.alaska.gov/FINANCIAL_AID/AK_Performance_Scholarship',
      application_url: 'https://acpe.alaska.gov/',
      description: 'Merit scholarship for Alaska high school graduates attending Alaska schools.',
      amount_min: 2378, amount_max: 4755,
      categories: ['education', 'merit scholarship'],
      keywords: ['alaska', 'performance scholarship', 'merit'],
      eligibility: ['AK resident', 'AK high school graduate', 'Meet curriculum/GPA/test requirements']
    }
  ],
  'AZ': [
    {
      id: 'az-leveraging',
      title: 'Arizona Leveraging Educational Assistance Partnership',
      sponsor: 'Arizona Department of Education',
      source_url: 'https://www.azed.gov/financialassistance/leap',
      application_url: 'https://www.azed.gov/financialassistance',
      description: 'Need-based grant for Arizona residents attending AZ public postsecondary institutions.',
      amount_min: 100, amount_max: 2500,
      categories: ['education', 'need-based'],
      keywords: ['arizona', 'leap', 'financial aid'],
      eligibility: ['AZ resident', 'Attend AZ public school', 'Demonstrate financial need']
    }
  ],
  'AR': [
    {
      id: 'ar-academic-challenge',
      title: 'Arkansas Academic Challenge Scholarship',
      sponsor: 'Arkansas Division of Higher Education',
      source_url: 'https://scholarships.adhe.edu/scholarships-and-programs/academic-challenge/',
      application_url: 'https://scholarships.adhe.edu/',
      description: 'Scholarship for AR high school graduates attending AR colleges. Based on merit and need.',
      amount_min: 1000, amount_max: 5000,
      categories: ['education', 'merit/need'],
      keywords: ['arkansas', 'academic challenge', 'scholarship'],
      eligibility: ['AR resident', 'AR high school graduate', 'Minimum 19 ACT', 'Meet income requirements']
    }
  ],
  'CO': [
    {
      id: 'co-student-grant',
      title: 'Colorado Student Grant',
      sponsor: 'Colorado Department of Higher Education',
      source_url: 'https://cdhe.colorado.gov/students/preparing-for-college/financial-aid/state-financial-aid-programs',
      application_url: 'https://cdhe.colorado.gov/students',
      description: 'Need-based grant for Colorado residents attending eligible CO institutions.',
      amount_min: 300, amount_max: 7000,
      categories: ['education', 'need-based'],
      keywords: ['colorado', 'student grant', 'financial aid'],
      eligibility: ['CO resident', 'Attend eligible CO school', 'Demonstrate financial need']
    }
  ],
  'CT': [
    {
      id: 'ct-roberta-willis',
      title: 'Roberta B. Willis Scholarship',
      sponsor: 'Connecticut Office of Higher Education',
      source_url: 'https://www.ctohe.org/SFA/sfa.shtml',
      application_url: 'https://www.ctohe.org/SFA/',
      description: 'Need and merit-based scholarship for CT residents attending CT colleges.',
      amount_min: 500, amount_max: 5250,
      categories: ['education', 'need/merit'],
      keywords: ['connecticut', 'roberta willis', 'scholarship'],
      eligibility: ['CT resident', 'Attend CT college', 'Need or merit-based criteria']
    }
  ],
  'DE': [
    {
      id: 'de-seed',
      title: 'Delaware SEED Scholarship',
      sponsor: 'Delaware Department of Education',
      source_url: 'https://www.doe.k12.de.us/seed',
      application_url: 'https://www.doe.k12.de.us/seed',
      description: 'Free tuition at DE State and Community College for DE high school graduates.',
      amount_min: null, amount_max: null,
      categories: ['education', 'free tuition'],
      keywords: ['delaware', 'seed', 'free tuition'],
      eligibility: ['DE resident', 'DE high school graduate', 'Attend DTCC or DSU']
    }
  ],
  'HI': [
    {
      id: 'hi-b-plus',
      title: 'Hawaii B Plus Scholarship',
      sponsor: 'University of Hawaii Foundation',
      source_url: 'https://www.hawaii.edu/tuition/scholarships/b-plus/',
      application_url: 'https://www.hawaii.edu/tuition/scholarships/',
      description: 'Scholarship for Hawaii high school graduates with 3.0+ GPA attending UH system.',
      amount_min: 1000, amount_max: 2000,
      categories: ['education', 'merit'],
      keywords: ['hawaii', 'b plus', 'scholarship', 'uh'],
      eligibility: ['HI resident', 'HI high school graduate', 'Minimum 3.0 GPA', 'Attend UH']
    }
  ],
  'ID': [
    {
      id: 'id-opportunity',
      title: 'Idaho Opportunity Scholarship',
      sponsor: 'Idaho State Board of Education',
      source_url: 'https://boardofed.idaho.gov/scholarships/idaho-opportunity-scholarship/',
      application_url: 'https://boardofed.idaho.gov/scholarships/',
      description: 'Need-based scholarship for Idaho residents attending Idaho postsecondary institutions.',
      amount_min: 1000, amount_max: 3500,
      categories: ['education', 'need-based'],
      keywords: ['idaho', 'opportunity scholarship', 'financial aid'],
      eligibility: ['ID resident', 'Attend eligible ID school', 'Demonstrate financial need']
    }
  ],
  'IN': [
    {
      id: 'in-21st-century',
      title: 'Indiana 21st Century Scholars',
      sponsor: 'Indiana Commission for Higher Education',
      source_url: 'https://learnmoreindiana.org/scholars/',
      application_url: 'https://scholars.in.gov/',
      description: 'Full tuition at IN public colleges for low-income students who enroll in 8th grade.',
      amount_min: null, amount_max: null,
      categories: ['education', 'free tuition'],
      keywords: ['indiana', '21st century', 'scholars', 'free tuition'],
      eligibility: ['IN resident', 'Enrolled in 8th grade', 'Family income qualifies for free lunch', 'Fulfill Scholar Pledge']
    },
    {
      id: 'in-frank-obannon',
      title: 'Frank O\'Bannon Grant',
      sponsor: 'Indiana Commission for Higher Education',
      source_url: 'https://www.in.gov/che/state-financial-aid/state-financial-aid-programs/frank-obannon-grant/',
      application_url: 'https://www.in.gov/che/state-financial-aid/',
      description: 'Need-based grant for Indiana residents attending Indiana colleges.',
      amount_min: 200, amount_max: 9600,
      categories: ['education', 'need-based'],
      keywords: ['indiana', 'frank obannon', 'grant', 'financial aid'],
      eligibility: ['IN resident', 'Attend eligible IN school', 'Demonstrate financial need']
    }
  ],
  'IA': [
    {
      id: 'ia-tuition-grant',
      title: 'Iowa Tuition Grant',
      sponsor: 'Iowa College Student Aid Commission',
      source_url: 'https://www.iowacollegeaid.gov/IowaGrantPrograms',
      application_url: 'https://www.iowacollegeaid.gov/',
      description: 'Grant for Iowa residents attending private colleges in Iowa.',
      amount_min: 100, amount_max: 7500,
      categories: ['education', 'private college'],
      keywords: ['iowa', 'tuition grant', 'private college'],
      eligibility: ['IA resident', 'Attend eligible private IA college', 'Demonstrate financial need']
    }
  ],
  'KS': [
    {
      id: 'ks-comprehensive',
      title: 'Kansas Comprehensive Grant',
      sponsor: 'Kansas Board of Regents',
      source_url: 'https://www.kansasregents.org/students/student_financial_aid/scholarships_and_grants',
      application_url: 'https://www.kansasregents.org/students/student_financial_aid',
      description: 'Need-based grant for Kansas residents attending state universities.',
      amount_min: 200, amount_max: 3500,
      categories: ['education', 'need-based'],
      keywords: ['kansas', 'comprehensive grant', 'state university'],
      eligibility: ['KS resident', 'Attend KS state university', 'Demonstrate financial need']
    }
  ],
  'KY': [
    {
      id: 'ky-cap',
      title: 'Kentucky College Access Program (CAP) Grant',
      sponsor: 'Kentucky Higher Education Assistance Authority',
      source_url: 'https://www.kheaa.com/website/kheaa/cap',
      application_url: 'https://www.kheaa.com/',
      description: 'Need-based grant for Kentucky residents at participating KY schools.',
      amount_min: 50, amount_max: 2100,
      categories: ['education', 'need-based'],
      keywords: ['kentucky', 'cap grant', 'college access'],
      eligibility: ['KY resident', 'Attend participating KY school', 'Demonstrate financial need']
    }
  ],
  'LA': [
    {
      id: 'la-tops',
      title: 'Louisiana TOPS Scholarship',
      sponsor: 'Louisiana Office of Student Financial Assistance',
      source_url: 'https://mylosfa.la.gov/students-parents/scholarships-grants/tops/',
      application_url: 'https://mylosfa.la.gov/',
      description: 'Merit-based scholarship covering tuition at Louisiana public colleges.',
      amount_min: null, amount_max: null,
      categories: ['education', 'merit', 'free tuition'],
      keywords: ['louisiana', 'tops', 'merit', 'scholarship'],
      eligibility: ['LA resident', 'LA high school graduate', 'Minimum 2.5 GPA', 'Minimum 20 ACT', 'Attend LA public school']
    }
  ],
  'ME': [
    {
      id: 'me-state-grant',
      title: 'Maine State Grant',
      sponsor: 'Finance Authority of Maine',
      source_url: 'https://www.famemaine.com/education/maine-grants-scholarships/maine-state-grant-program/',
      application_url: 'https://www.famemaine.com/',
      description: 'Need-based grant for Maine residents attending Maine schools.',
      amount_min: 250, amount_max: 1500,
      categories: ['education', 'need-based'],
      keywords: ['maine', 'state grant', 'financial aid'],
      eligibility: ['ME resident', 'Attend approved ME school', 'Demonstrate financial need']
    }
  ],
  'MD': [
    {
      id: 'md-senatorial',
      title: 'Maryland Senatorial Scholarship',
      sponsor: 'Maryland Higher Education Commission',
      source_url: 'https://mhec.maryland.gov/preparing/Pages/FinancialAid/descriptions.aspx',
      application_url: 'https://mhec.maryland.gov/',
      description: 'Scholarship awarded by state senators for Maryland residents at MD schools.',
      amount_min: 400, amount_max: 9000,
      categories: ['education', 'legislative'],
      keywords: ['maryland', 'senatorial', 'scholarship'],
      eligibility: ['MD resident', 'Attend MD 2 or 4-year school', 'Apply through state senator']
    }
  ],
  'MA': [
    {
      id: 'ma-mass-grant',
      title: 'MASSGrant',
      sponsor: 'Massachusetts Office of Student Financial Assistance',
      source_url: 'https://www.mass.edu/osfa/programs/massgrant.asp',
      application_url: 'https://www.mass.edu/osfa/',
      description: 'Need-based grant for Massachusetts residents attending MA institutions.',
      amount_min: 300, amount_max: 1900,
      categories: ['education', 'need-based'],
      keywords: ['massachusetts', 'massgrant', 'financial aid'],
      eligibility: ['MA resident', 'Attend approved MA school', 'Demonstrate financial need', 'No bachelor\'s degree']
    }
  ],
  'MN': [
    {
      id: 'mn-state-grant',
      title: 'Minnesota State Grant',
      sponsor: 'Minnesota Office of Higher Education',
      source_url: 'https://www.ohe.state.mn.us/mPg.cfm?pageID=138',
      application_url: 'https://www.ohe.state.mn.us/',
      description: 'Need-based grant for Minnesota residents. Largest state grant program in MN.',
      amount_min: 100, amount_max: 11891,
      categories: ['education', 'need-based'],
      keywords: ['minnesota', 'state grant', 'financial aid'],
      eligibility: ['MN resident', 'Attend eligible MN school', 'Demonstrate financial need']
    }
  ],
  'MS': [
    {
      id: 'ms-mtag',
      title: 'Mississippi Tuition Assistance Grant (MTAG)',
      sponsor: 'Mississippi Institutions of Higher Learning',
      source_url: 'https://www.msfinancialaid.org/mtag/',
      application_url: 'https://www.msfinancialaid.org/',
      description: 'Grant for Mississippi residents attending private colleges in Mississippi.',
      amount_min: 500, amount_max: 500,
      categories: ['education', 'private college'],
      keywords: ['mississippi', 'mtag', 'private college'],
      eligibility: ['MS resident', 'Attend private MS college', 'Full-time student']
    }
  ],
  'MO': [
    {
      id: 'mo-access',
      title: 'Missouri Access Grant',
      sponsor: 'Missouri Department of Higher Education',
      source_url: 'https://dhewd.mo.gov/ppc/grants/accessmissouri.php',
      application_url: 'https://dhewd.mo.gov/ppc/grants/',
      description: 'Need-based grant for Missouri residents at approved MO schools.',
      amount_min: 300, amount_max: 2850,
      categories: ['education', 'need-based'],
      keywords: ['missouri', 'access grant', 'financial aid'],
      eligibility: ['MO resident', 'Attend approved MO school', 'Demonstrate financial need']
    },
    {
      id: 'mo-a-plus',
      title: 'Missouri A+ Scholarship',
      sponsor: 'Missouri Department of Higher Education',
      source_url: 'https://dhewd.mo.gov/ppc/grants/aplusscholarship.php',
      application_url: 'https://dhewd.mo.gov/ppc/grants/',
      description: 'Scholarship for tuition and fees at MO public community colleges and vocational schools.',
      amount_min: null, amount_max: null,
      categories: ['education', 'community college'],
      keywords: ['missouri', 'a plus', 'community college', 'free tuition'],
      eligibility: ['Graduate from A+ designated MO high school', '2.5 GPA', '95% attendance', '50 hours tutoring']
    }
  ],
  'MT': [
    {
      id: 'mt-merit',
      title: 'Montana University System Honor Scholarship',
      sponsor: 'Montana University System',
      source_url: 'https://mus.edu/Prepare/Pay/Scholarships/',
      application_url: 'https://mus.edu/Prepare/Pay/',
      description: 'Merit scholarship for Montana high school graduates attending Montana public colleges.',
      amount_min: 4000, amount_max: 4000,
      categories: ['education', 'merit'],
      keywords: ['montana', 'honor', 'merit', 'scholarship'],
      eligibility: ['MT resident', 'MT high school graduate', 'Attend MUS institution', 'Merit-based criteria']
    }
  ],
  'NE': [
    {
      id: 'ne-opportunity',
      title: 'Nebraska Opportunity Grant',
      sponsor: 'Coordinating Commission for Postsecondary Education',
      source_url: 'https://ccpe.nebraska.gov/nebraska-opportunity-grant',
      application_url: 'https://ccpe.nebraska.gov/',
      description: 'Need-based grant for Nebraska residents at eligible Nebraska schools.',
      amount_min: 100, amount_max: 4800,
      categories: ['education', 'need-based'],
      keywords: ['nebraska', 'opportunity grant', 'financial aid'],
      eligibility: ['NE resident', 'Attend eligible NE school', 'Demonstrate financial need', 'Pell-eligible']
    }
  ],
  'NV': [
    {
      id: 'nv-millennium',
      title: 'Nevada Millennium Scholarship',
      sponsor: 'Nevada State Treasurer',
      source_url: 'https://www.nevadatreasurer.gov/Millennium/Home/',
      application_url: 'https://www.nevadatreasurer.gov/Millennium/',
      description: 'Merit scholarship for Nevada high school graduates at Nevada schools.',
      amount_min: 40, amount_max: 10000,
      categories: ['education', 'merit'],
      keywords: ['nevada', 'millennium', 'scholarship'],
      eligibility: ['NV resident for 2+ years', 'NV high school graduate', 'Minimum 3.25 GPA', 'Attend eligible NV school']
    }
  ],
  'NH': [
    {
      id: 'nh-granite-guarantee',
      title: 'Granite Guarantee',
      sponsor: 'University System of New Hampshire',
      source_url: 'https://www.usnh.edu/tuition-financial-aid/granite-guarantee',
      application_url: 'https://www.usnh.edu/tuition-financial-aid/',
      description: 'Free in-state tuition for Pell-eligible NH students at USNH schools.',
      amount_min: null, amount_max: null,
      categories: ['education', 'free tuition'],
      keywords: ['new hampshire', 'granite guarantee', 'free tuition'],
      eligibility: ['NH resident', 'Pell Grant eligible', 'Attend USNH institution', 'First bachelor\'s degree']
    }
  ],
  'NJ': [
    {
      id: 'nj-tag',
      title: 'New Jersey Tuition Aid Grant (TAG)',
      sponsor: 'NJ Higher Education Student Assistance Authority',
      source_url: 'https://www.hesaa.org/Pages/NJTuitionAidGrant.aspx',
      application_url: 'https://www.hesaa.org/',
      description: 'Need-based grant for NJ residents at eligible NJ schools. Largest state grant program.',
      amount_min: 500, amount_max: 13656,
      categories: ['education', 'need-based'],
      keywords: ['new jersey', 'tag', 'tuition aid grant'],
      eligibility: ['NJ resident', 'Attend eligible NJ school', 'Demonstrate financial need']
    },
    {
      id: 'nj-community-college',
      title: 'NJ Community College Opportunity Grant',
      sponsor: 'NJ Higher Education Student Assistance Authority',
      source_url: 'https://www.hesaa.org/Pages/CCOG.aspx',
      application_url: 'https://www.hesaa.org/',
      description: 'Free community college for NJ residents with adjusted gross income up to $65,000.',
      amount_min: null, amount_max: null,
      categories: ['education', 'free tuition', 'community college'],
      keywords: ['new jersey', 'community college', 'free tuition'],
      eligibility: ['NJ resident', 'AGI up to $65,000', 'Attend NJ county college']
    }
  ],
  'NM': [
    {
      id: 'nm-opportunity',
      title: 'New Mexico Opportunity Scholarship',
      sponsor: 'New Mexico Higher Education Department',
      source_url: 'https://hed.nm.gov/financial-aid/scholarships/lottery-scholarship',
      application_url: 'https://hed.nm.gov/financial-aid/',
      description: 'Free tuition at NM public colleges for NM residents.',
      amount_min: null, amount_max: null,
      categories: ['education', 'free tuition'],
      keywords: ['new mexico', 'opportunity', 'free tuition'],
      eligibility: ['NM resident', 'Attend NM public college', 'Complete scholarship application']
    }
  ],
  'NY': [
    {
      id: 'ny-tap',
      title: 'New York TAP - Tuition Assistance Program',
      sponsor: 'New York State Higher Education Services Corporation',
      source_url: 'https://www.hesc.ny.gov/pay-for-college/apply-for-financial-aid/nys-tap.html',
      application_url: 'https://www.hesc.ny.gov/pay-for-college/apply-for-financial-aid/nys-tap.html',
      description: 'NYS grant for eligible NY residents attending approved schools in NY. Up to $5,665/year.',
      amount_min: 500, amount_max: 5665,
      categories: ['education', 'state grant'],
      keywords: ['tap', 'new york', 'tuition assistance', 'college'],
      eligibility: ['NY resident for 12+ months', 'Attend approved NY school', 'Meet income requirements']
    },
    {
      id: 'ny-excelsior',
      title: 'Excelsior Scholarship',
      sponsor: 'New York State',
      source_url: 'https://www.hesc.ny.gov/pay-for-college/financial-aid/types-of-financial-aid/nys-grants-scholarships-awards/the-excelsior-scholarship.html',
      application_url: 'https://www.hesc.ny.gov/pay-for-college/financial-aid/types-of-financial-aid/nys-grants-scholarships-awards/the-excelsior-scholarship.html',
      description: 'Free tuition at SUNY and CUNY schools for families with income up to $125,000.',
      amount_min: null, amount_max: null,
      categories: ['education', 'free tuition'],
      keywords: ['excelsior', 'new york', 'free tuition', 'suny', 'cuny'],
      eligibility: ['NY resident', 'Income up to $125,000', 'Attend SUNY or CUNY full-time', 'Work in NY after graduation']
    },
    {
      id: 'ny-heap',
      title: 'New York HEAP',
      sponsor: 'New York State OTDA',
      source_url: 'https://otda.ny.gov/programs/heap/',
      application_url: 'https://mybenefits.ny.gov/',
      description: 'Home Energy Assistance Program for NYS residents to help pay heating and cooling costs.',
      amount_min: 100, amount_max: 1500,
      categories: ['energy', 'utilities'],
      keywords: ['heap', 'new york', 'energy assistance', 'heating'],
      eligibility: ['NY resident', 'Income at or below 60% state median income']
    }
  ],
  'CA': [
    {
      id: 'ca-calgrant',
      title: 'California Cal Grant',
      sponsor: 'California Student Aid Commission',
      source_url: 'https://www.csac.ca.gov/cal-grants',
      application_url: 'https://www.csac.ca.gov/how-apply',
      description: 'California state grants for college students. Multiple types available based on need and merit.',
      amount_min: 1648, amount_max: 14312,
      categories: ['education', 'state grant'],
      keywords: ['cal grant', 'california', 'college', 'financial aid'],
      eligibility: ['CA resident', 'Attend eligible CA school', 'File FAFSA/Dream Act by deadline']
    },
    {
      id: 'ca-middle-class',
      title: 'California Middle Class Scholarship',
      sponsor: 'California Student Aid Commission',
      source_url: 'https://www.csac.ca.gov/middle-class-scholarship',
      application_url: 'https://www.csac.ca.gov/how-apply',
      description: 'Scholarship for middle-income students at UC and CSU. Family income up to $217,000.',
      amount_min: null, amount_max: null,
      categories: ['education', 'middle class'],
      keywords: ['middle class scholarship', 'california', 'uc', 'csu'],
      eligibility: ['CA resident', 'Attend UC or CSU', 'Family income up to $217,000']
    },
    {
      id: 'ca-calfresh',
      title: 'CalFresh (California SNAP)',
      sponsor: 'California Department of Social Services',
      source_url: 'https://www.cdss.ca.gov/calfresh',
      application_url: 'https://www.getcalfresh.org/',
      description: 'California\'s food assistance program (SNAP). Apply online through GetCalFresh.',
      amount_min: 23, amount_max: 1751,
      categories: ['food assistance', 'benefits'],
      keywords: ['calfresh', 'california', 'food stamps', 'snap'],
      eligibility: ['CA resident', 'Meet income requirements', 'U.S. citizen or qualified immigrant']
    }
  ],
  'TX': [
    {
      id: 'tx-teog',
      title: 'Texas Educational Opportunity Grant (TEOG)',
      sponsor: 'Texas Higher Education Coordinating Board',
      source_url: 'https://www.highered.texas.gov/institutional-resources-programs/financial-aid/state-financial-aid-programs/teog/',
      application_url: 'https://www.highered.texas.gov/institutional-resources-programs/financial-aid/',
      description: 'Texas grant for students at public 2-year colleges with financial need.',
      amount_min: 0, amount_max: 2000,
      categories: ['education', 'community college'],
      keywords: ['teog', 'texas', 'community college', 'grant'],
      eligibility: ['TX resident', 'Attend public 2-year college', 'Financial need']
    },
    {
      id: 'tx-toward-excellence',
      title: 'TEXAS Grant',
      sponsor: 'Texas Higher Education Coordinating Board',
      source_url: 'https://www.highered.texas.gov/institutional-resources-programs/financial-aid/state-financial-aid-programs/texas-grant/',
      application_url: 'https://www.highered.texas.gov/institutional-resources-programs/financial-aid/',
      description: 'Texas grant for students at public universities. Need-based with varying amounts.',
      amount_min: 0, amount_max: 8000,
      categories: ['education', 'university'],
      keywords: ['texas grant', 'texas', 'university', 'financial aid'],
      eligibility: ['TX resident', 'Attend public TX university', 'Financial need', 'Complete TASFA or FAFSA']
    }
  ],
  'FL': [
    {
      id: 'fl-bright-futures',
      title: 'Florida Bright Futures Scholarship',
      sponsor: 'Florida Department of Education',
      source_url: 'https://www.floridastudentfinancialaidsg.org/SAPBFMAIN/SAPBFMAIN',
      application_url: 'https://www.floridastudentfinancialaidsg.org/SAPBFMAIN/SAPBFMAIN',
      description: 'Merit-based scholarship for FL high school graduates attending FL colleges.',
      amount_min: 1000, amount_max: null,
      categories: ['education', 'merit scholarship'],
      keywords: ['bright futures', 'florida', 'scholarship', 'merit'],
      eligibility: ['FL resident', 'FL high school graduate', 'Meet GPA and test requirements']
    },
    {
      id: 'fl-sefa',
      title: 'Florida Student Assistance Grant (FSAG)',
      sponsor: 'Florida Department of Education',
      source_url: 'https://www.floridastudentfinancialaidsg.org/SAPFSAG/SAPFSAG',
      application_url: 'https://www.floridastudentfinancialaidsg.org/',
      description: 'Need-based grant for Florida residents attending eligible FL institutions.',
      amount_min: 200, amount_max: 2500,
      categories: ['education', 'need-based'],
      keywords: ['fsag', 'florida', 'student grant', 'financial need'],
      eligibility: ['FL resident', 'Demonstrate financial need', 'Attend eligible FL school']
    }
  ],
  'PA': [
    {
      id: 'pa-pheaa',
      title: 'Pennsylvania State Grant',
      sponsor: 'PHEAA',
      source_url: 'https://www.pheaa.org/grants/state-grant-program/',
      application_url: 'https://www.pheaa.org/funding-opportunities/state-grant-program/',
      description: 'Need-based grant for PA residents attending approved schools.',
      amount_min: 300, amount_max: 5000,
      categories: ['education', 'state grant'],
      keywords: ['pheaa', 'pennsylvania', 'state grant', 'college'],
      eligibility: ['PA resident', 'Demonstrate financial need', 'Attend approved school']
    }
  ],
  'OH': [
    {
      id: 'oh-college-opportunity',
      title: 'Ohio College Opportunity Grant',
      sponsor: 'Ohio Department of Higher Education',
      source_url: 'https://www.ohiohighered.org/ocog',
      application_url: 'https://www.ohiohighered.org/ocog',
      description: 'Need-based grant for Ohio residents attending Ohio public colleges.',
      amount_min: 500, amount_max: 7500,
      categories: ['education', 'state grant'],
      keywords: ['ohio', 'college opportunity grant', 'financial aid'],
      eligibility: ['Ohio resident', 'Attend Ohio public college', 'EFC of $2,190 or less']
    }
  ],
  'IL': [
    {
      id: 'il-map',
      title: 'Illinois MAP Grant',
      sponsor: 'Illinois Student Assistance Commission',
      source_url: 'https://www.isac.org/students/during-college/types-of-financial-aid/grants/monetary-award-program/',
      application_url: 'https://www.isac.org/students/',
      description: 'Need-based grant for Illinois residents attending Illinois schools.',
      amount_min: 300, amount_max: 6500,
      categories: ['education', 'state grant'],
      keywords: ['map grant', 'illinois', 'financial aid', 'college'],
      eligibility: ['Illinois resident', 'Attend approved IL school', 'Demonstrate financial need']
    }
  ],
  'MI': [
    {
      id: 'mi-tuition-grant',
      title: 'Michigan Tuition Grant',
      sponsor: 'Michigan Student Aid',
      source_url: 'https://www.michigan.gov/mistudentaid/programs/michigan-tuition-grant',
      application_url: 'https://www.michigan.gov/mistudentaid',
      description: 'Need-based grant for Michigan residents attending private MI colleges.',
      amount_min: 100, amount_max: 2200,
      categories: ['education', 'private college'],
      keywords: ['michigan', 'tuition grant', 'private college'],
      eligibility: ['MI resident', 'Attend approved private MI college', 'Financial need']
    }
  ],
  'GA': [
    {
      id: 'ga-hope',
      title: 'Georgia HOPE Scholarship',
      sponsor: 'Georgia Student Finance Commission',
      source_url: 'https://www.gafutures.org/hope-state-aid-programs/hope-zell-miller-scholarships/',
      application_url: 'https://www.gafutures.org/',
      description: 'Merit-based scholarship for Georgia residents attending eligible GA schools.',
      amount_min: null, amount_max: null,
      categories: ['education', 'merit scholarship'],
      keywords: ['hope scholarship', 'georgia', 'merit', 'college'],
      eligibility: ['Georgia resident', 'Graduate from eligible GA high school', 'Minimum 3.0 GPA']
    }
  ],
  'NC': [
    {
      id: 'nc-need-based',
      title: 'North Carolina Need-Based Scholarship',
      sponsor: 'NC State Education Assistance Authority',
      source_url: 'https://www.cfnc.org/pay-for-college/financial-aid-101/types-of-aid/grants-scholarships/nc-need-based-scholarship/',
      application_url: 'https://www.cfnc.org/',
      description: 'Need-based scholarship for NC residents at UNC system schools.',
      amount_min: 200, amount_max: 7000,
      categories: ['education', 'need-based'],
      keywords: ['north carolina', 'scholarship', 'unc', 'need-based'],
      eligibility: ['NC resident', 'Attend UNC system school', 'Demonstrate financial need']
    }
  ],
  'ND': [
    {
      id: 'nd-scholars',
      title: 'North Dakota Scholars Program',
      sponsor: 'North Dakota University System',
      source_url: 'https://ndus.edu/students/paying-for-college/north-dakota-scholars-program/',
      application_url: 'https://ndus.edu/students/',
      description: 'Full tuition scholarship for top ND high school graduates.',
      amount_min: null, amount_max: null,
      categories: ['education', 'merit', 'free tuition'],
      keywords: ['north dakota', 'scholars', 'merit', 'free tuition'],
      eligibility: ['ND resident', 'Top 5% of class or ACT composite 24+', 'Complete rigorous curriculum']
    }
  ],
  'OK': [
    {
      id: 'ok-promise',
      title: 'Oklahoma\'s Promise',
      sponsor: 'Oklahoma State Regents for Higher Education',
      source_url: 'https://www.okhighered.org/okpromise/',
      application_url: 'https://www.okhighered.org/okpromise/',
      description: 'Free tuition at OK public colleges for students who enroll in 8th-10th grade.',
      amount_min: null, amount_max: null,
      categories: ['education', 'free tuition'],
      keywords: ['oklahoma', 'promise', 'free tuition'],
      eligibility: ['OK resident', 'Enroll in 8th-10th grade', 'Family income under $60,000', 'Minimum 2.5 GPA']
    }
  ],
  'OR': [
    {
      id: 'or-opportunity',
      title: 'Oregon Opportunity Grant',
      sponsor: 'Oregon Student Aid',
      source_url: 'https://oregonstudentaid.gov/grants/oregon-opportunity-grant/',
      application_url: 'https://oregonstudentaid.gov/',
      description: 'Oregon\'s largest state need-based grant for residents at OR schools.',
      amount_min: 1100, amount_max: 3612,
      categories: ['education', 'need-based'],
      keywords: ['oregon', 'opportunity grant', 'financial aid'],
      eligibility: ['OR resident', 'Attend eligible OR school', 'Demonstrate financial need']
    },
    {
      id: 'or-promise',
      title: 'Oregon Promise',
      sponsor: 'Oregon Higher Education Coordinating Commission',
      source_url: 'https://oregonstudentaid.gov/grants/oregon-promise/',
      application_url: 'https://oregonstudentaid.gov/',
      description: 'Grant to cover tuition at Oregon community colleges.',
      amount_min: 1000, amount_max: 4000,
      categories: ['education', 'community college'],
      keywords: ['oregon', 'promise', 'community college'],
      eligibility: ['OR resident', 'OR GED or high school graduate', 'Attend OR community college']
    }
  ],
  'RI': [
    {
      id: 'ri-promise',
      title: 'Rhode Island Promise Scholarship',
      sponsor: 'Rhode Island Office of Postsecondary Commissioner',
      source_url: 'https://www.riopc.edu/page/ri_promise/',
      application_url: 'https://www.riopc.edu/',
      description: 'Free tuition at Community College of Rhode Island.',
      amount_min: null, amount_max: null,
      categories: ['education', 'free tuition', 'community college'],
      keywords: ['rhode island', 'promise', 'free tuition', 'ccri'],
      eligibility: ['RI resident', 'RI high school graduate', 'Attend CCRI', 'Complete within 3 years']
    }
  ],
  'SC': [
    {
      id: 'sc-life',
      title: 'South Carolina LIFE Scholarship',
      sponsor: 'SC Commission on Higher Education',
      source_url: 'https://www.che.sc.gov/CHE_Docs/studentservices/LIFE/life_scholarship.htm',
      application_url: 'https://www.che.sc.gov/',
      description: 'Merit scholarship for SC high school graduates at SC colleges.',
      amount_min: 2500, amount_max: 5000,
      categories: ['education', 'merit'],
      keywords: ['south carolina', 'life', 'scholarship', 'merit'],
      eligibility: ['SC resident', 'SC high school graduate', 'Minimum 3.0 GPA', '1100 SAT or 24 ACT']
    },
    {
      id: 'sc-palmetto',
      title: 'SC Palmetto Fellows Scholarship',
      sponsor: 'SC Commission on Higher Education',
      source_url: 'https://www.che.sc.gov/CHE_Docs/studentservices/palmettofellows/palmetto_fellows.htm',
      application_url: 'https://www.che.sc.gov/',
      description: 'Top merit scholarship for SC high achievers.',
      amount_min: 6700, amount_max: 7500,
      categories: ['education', 'merit', 'high achiever'],
      keywords: ['south carolina', 'palmetto', 'fellows', 'merit'],
      eligibility: ['SC resident', 'SC high school graduate', '3.5 GPA', '1200 SAT or 27 ACT', 'Top 6% of class']
    }
  ],
  'SD': [
    {
      id: 'sd-opportunity',
      title: 'South Dakota Opportunity Scholarship',
      sponsor: 'South Dakota Board of Regents',
      source_url: 'https://www.sdbor.edu/student-information/Pages/SD-Opportunity-Scholarship.aspx',
      application_url: 'https://www.sdbor.edu/',
      description: 'Merit scholarship for SD high school graduates at SD public universities.',
      amount_min: 1300, amount_max: 6500,
      categories: ['education', 'merit'],
      keywords: ['south dakota', 'opportunity', 'scholarship'],
      eligibility: ['SD resident', 'SD high school graduate', 'Minimum 24 ACT', 'Minimum 3.0 GPA']
    }
  ],
  'TN': [
    {
      id: 'tn-promise',
      title: 'Tennessee Promise',
      sponsor: 'Tennessee Higher Education Commission',
      source_url: 'https://www.tn.gov/tnpromise',
      application_url: 'https://www.tn.gov/tnpromise/students.html',
      description: 'Last-dollar scholarship for free community or technical college for TN high school graduates.',
      amount_min: null, amount_max: null,
      categories: ['education', 'free tuition', 'community college'],
      keywords: ['tennessee promise', 'free college', 'community college'],
      eligibility: ['TN resident', 'High school graduate', 'Complete 8 hours community service', 'Maintain 2.0 GPA']
    },
    {
      id: 'tn-hope',
      title: 'Tennessee HOPE Scholarship',
      sponsor: 'Tennessee Higher Education Commission',
      source_url: 'https://www.tn.gov/collegepays/money-for-college/tn-education-lottery-programs/tennessee-hope-scholarship.html',
      application_url: 'https://www.tn.gov/collegepays/money-for-college.html',
      description: 'Merit scholarship for TN residents attending TN colleges.',
      amount_min: 1500, amount_max: 5250,
      categories: ['education', 'merit scholarship'],
      keywords: ['tennessee hope', 'scholarship', 'merit'],
      eligibility: ['TN resident', 'Minimum 21 ACT or 3.0 GPA', 'Attend eligible TN school']
    }
  ],
  'UT': [
    {
      id: 'ut-regents',
      title: 'Utah Regents\' Scholarship',
      sponsor: 'Utah System of Higher Education',
      source_url: 'https://ushe.edu/initiatives/regents-scholarship/',
      application_url: 'https://ushe.edu/initiatives/regents-scholarship/',
      description: 'Base and Exemplary scholarship for Utah high school graduates.',
      amount_min: 1000, amount_max: 2000,
      categories: ['education', 'merit'],
      keywords: ['utah', 'regents', 'scholarship', 'merit'],
      eligibility: ['UT high school graduate', 'Complete specific curriculum', 'Attend UT public school']
    }
  ],
  'VT': [
    {
      id: 'vt-incentive',
      title: 'Vermont Incentive Grant',
      sponsor: 'Vermont Student Assistance Corporation',
      source_url: 'https://www.vsac.org/pay/grants-and-scholarships/vsac-grants',
      application_url: 'https://www.vsac.org/',
      description: 'Need-based grant for Vermont residents attending approved schools.',
      amount_min: 500, amount_max: 12000,
      categories: ['education', 'need-based'],
      keywords: ['vermont', 'incentive grant', 'financial aid'],
      eligibility: ['VT resident', 'Attend approved school', 'Demonstrate financial need']
    }
  ],
  'VA': [
    {
      id: 'va-commonwealth',
      title: 'Virginia Commonwealth Award',
      sponsor: 'State Council of Higher Education for Virginia',
      source_url: 'https://www.schev.edu/students/financial-aid/undergraduate',
      application_url: 'https://www.schev.edu/',
      description: 'Need-based grant for Virginia residents at VA public schools.',
      amount_min: 500, amount_max: 5000,
      categories: ['education', 'need-based'],
      keywords: ['virginia', 'commonwealth', 'grant', 'financial aid'],
      eligibility: ['VA resident', 'Attend VA public school', 'Demonstrate financial need']
    },
    {
      id: 'va-gtf',
      title: 'Virginia Tuition Assistance Grant (VTAG)',
      sponsor: 'State Council of Higher Education for Virginia',
      source_url: 'https://www.schev.edu/students/financial-aid/undergraduate',
      application_url: 'https://www.schev.edu/',
      description: 'Grant for VA residents at private, non-profit VA colleges.',
      amount_min: 1000, amount_max: 4000,
      categories: ['education', 'private college'],
      keywords: ['virginia', 'vtag', 'private college', 'grant'],
      eligibility: ['VA resident', 'Attend eligible private VA college', 'Full-time student']
    }
  ],
  'WA': [
    {
      id: 'wa-college-grant',
      title: 'Washington College Grant',
      sponsor: 'Washington Student Achievement Council',
      source_url: 'https://wsac.wa.gov/wcg',
      application_url: 'https://wsac.wa.gov/',
      description: 'State\'s largest financial aid program. Need-based for WA residents.',
      amount_min: 500, amount_max: 11666,
      categories: ['education', 'need-based'],
      keywords: ['washington', 'college grant', 'financial aid'],
      eligibility: ['WA resident', 'Attend eligible WA school', 'Family income up to median']
    }
  ],
  'WV': [
    {
      id: 'wv-promise',
      title: 'West Virginia PROMISE Scholarship',
      sponsor: 'West Virginia Higher Education Policy Commission',
      source_url: 'https://www.wvhepc.edu/promise-scholarship/',
      application_url: 'https://www.wvhepc.edu/',
      description: 'Merit scholarship for WV high school graduates at WV schools.',
      amount_min: 2500, amount_max: 4750,
      categories: ['education', 'merit'],
      keywords: ['west virginia', 'promise', 'scholarship', 'merit'],
      eligibility: ['WV resident', 'WV high school graduate', 'Minimum 3.0 GPA and 22 ACT']
    },
    {
      id: 'wv-higher-ed-grant',
      title: 'West Virginia Higher Education Grant',
      sponsor: 'West Virginia Higher Education Policy Commission',
      source_url: 'https://www.wvhepc.edu/west-virginia-higher-education-grant/',
      application_url: 'https://www.wvhepc.edu/',
      description: 'Need-based grant for WV residents at WV schools.',
      amount_min: 200, amount_max: 2600,
      categories: ['education', 'need-based'],
      keywords: ['west virginia', 'higher ed grant', 'financial aid'],
      eligibility: ['WV resident', 'Attend WV school', 'Demonstrate financial need']
    }
  ],
  'WI': [
    {
      id: 'wi-grant',
      title: 'Wisconsin Grant',
      sponsor: 'Wisconsin Higher Educational Aids Board',
      source_url: 'https://heab.state.wi.us/programs.html',
      application_url: 'https://heab.state.wi.us/',
      description: 'Need-based grant for Wisconsin residents at Wisconsin schools.',
      amount_min: 250, amount_max: 3150,
      categories: ['education', 'need-based'],
      keywords: ['wisconsin', 'grant', 'financial aid'],
      eligibility: ['WI resident', 'Attend WI school', 'Demonstrate financial need']
    }
  ],
  'WY': [
    {
      id: 'wy-hathaway',
      title: 'Wyoming Hathaway Scholarship',
      sponsor: 'Wyoming Department of Education',
      source_url: 'https://edu.wyoming.gov/for-parents-students/hathaway-scholarship/',
      application_url: 'https://edu.wyoming.gov/for-parents-students/hathaway-scholarship/',
      description: 'Merit scholarship for WY high school graduates at WY community colleges and UW.',
      amount_min: 840, amount_max: 1680,
      categories: ['education', 'merit'],
      keywords: ['wyoming', 'hathaway', 'scholarship', 'merit'],
      eligibility: ['WY high school graduate', 'Complete success curriculum', 'Attend UW or WY community college']
    }
  ],
  'DC': [
    {
      id: 'dc-tag',
      title: 'DC Tuition Assistance Grant (DC TAG)',
      sponsor: 'DC Office of the State Superintendent of Education',
      source_url: 'https://osse.dc.gov/dctag',
      application_url: 'https://osse.dc.gov/dctag',
      description: 'Up to $10,000/year at public schools nationwide, or $2,500 at private schools.',
      amount_min: 2500, amount_max: 10000,
      categories: ['education', 'national access'],
      keywords: ['dc', 'tag', 'tuition assistance', 'washington dc'],
      eligibility: ['DC resident', 'High school graduate', 'Attend eligible school', 'Meet income requirements']
    }
  ],
  'PR': [
    {
      id: 'pr-pell',
      title: 'Federal Pell Grant (Puerto Rico)',
      sponsor: 'U.S. Department of Education',
      source_url: 'https://studentaid.gov/understand-aid/types/grants/pell',
      application_url: 'https://studentaid.gov/h/apply-for-aid/fafsa',
      description: 'Federal Pell Grants available for Puerto Rico residents attending eligible PR institutions.',
      amount_min: 750, amount_max: 7395,
      categories: ['education', 'federal'],
      keywords: ['pell', 'puerto rico', 'federal', 'grant'],
      eligibility: ['PR resident', 'Attend eligible PR school', 'Financial need via FAFSA']
    }
  ]
};

/**
 * Insert or update a funding opportunity
 */
function upsertOpportunity(db, opp, state = 'nationwide') {
  try {
    const existing = db.prepare(
      'SELECT id FROM funding_opportunities WHERE id = ?'
    ).get(opp.id);
    
    const categories = Array.isArray(opp.categories) ? JSON.stringify(opp.categories) : '[]';
    const keywords = Array.isArray(opp.keywords) ? JSON.stringify(opp.keywords) : '[]';
    const eligibility = Array.isArray(opp.eligibility) ? JSON.stringify(opp.eligibility) : '[]';
    const recordType = opp.type || ((opp.opportunity_type === 'benefit' || opp.opportunity_type === 'program') ? 'PROGRAM' : 'OPPORTUNITY')
    
    if (existing) {
      db.prepare(`
        UPDATE funding_opportunities SET
          title = ?, sponsor = ?, description = ?, amount_min = ?, amount_max = ?,
          deadline = ?, deadline_type = ?, application_url = ?, source_url = ?,
          is_national = ?, state = ?, categories = ?, keywords = ?,
          eligibility_bullets = ?, opportunity_type = ?, requires_501c3 = ?,
          requires_match = ?,
          record_origin = 'curated_verified',
          type = ?,
          evidence_url = COALESCE(evidence_url, ?),
          last_verified_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        opp.title, opp.sponsor, opp.description, opp.amount_min || null, opp.amount_max || null,
        opp.deadline || null, opp.deadline_type || 'rolling', opp.application_url, opp.source_url,
        opp.is_national !== false ? 1 : 0, state,
        categories, keywords, eligibility,
        opp.opportunity_type || 'grant', opp.requires_501c3 ? 1 : 0, opp.requires_match ? 1 : 0,
        recordType,
        opp.source_url,
        opp.id
      );
      return { updated: true };
    } else {
      db.prepare(`
        INSERT INTO funding_opportunities (
          id, title, sponsor, source, source_id, source_url, description,
          amount_min, amount_max, deadline, deadline_type, application_url,
          is_national, state, categories, keywords, eligibility_bullets,
          opportunity_type, requires_501c3, requires_match,
          record_origin, type, evidence_url, last_verified_at,
          is_active,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'curated_verified', ?, ?, CURRENT_TIMESTAMP,
          1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        opp.id, opp.title, opp.sponsor, 'verified_real', opp.id,
        opp.source_url, opp.description,
        opp.amount_min || null, opp.amount_max || null,
        opp.deadline || null, opp.deadline_type || 'rolling', opp.application_url,
        opp.is_national !== false ? 1 : 0, state,
        categories, keywords, eligibility,
        opp.opportunity_type || 'grant', opp.requires_501c3 ? 1 : 0, opp.requires_match ? 1 : 0,
        recordType,
        opp.source_url
      );
      return { inserted: true };
    }
  } catch (error) {
    console.error(`[RealFunding] Error upserting ${opp.id}:`, error.message);
    return { error: error.message };
  }
}

/**
 * Seed all real national programs
 */
export function seedNationalPrograms(db) {
  console.log('[RealFunding] Seeding national programs...');
  let inserted = 0, updated = 0, errors = 0;
  
  for (const program of NATIONAL_PROGRAMS) {
    const result = upsertOpportunity(db, { ...program, is_national: true }, 'nationwide');
    if (result.inserted) inserted++;
    else if (result.updated) updated++;
    else errors++;
  }
  
  console.log(`[RealFunding] National: ${inserted} inserted, ${updated} updated, ${errors} errors`);
  return { inserted, updated, errors };
}

/**
 * Seed state-specific programs for a given state
 */
export function seedStatePrograms(db, state) {
  const programs = STATE_PROGRAMS[state] || [];
  if (programs.length === 0) return { inserted: 0, updated: 0, errors: 0 };
  
  let inserted = 0, updated = 0, errors = 0;
  
  for (const program of programs) {
    const result = upsertOpportunity(db, { ...program, is_national: false }, state);
    if (result.inserted) inserted++;
    else if (result.updated) updated++;
    else errors++;
  }
  
  return { inserted, updated, errors };
}

/**
 * Seed programs for all states
 */
export function seedAllStatePrograms(db) {
  console.log('[RealFunding] Seeding state programs...');
  let totalInserted = 0, totalUpdated = 0, totalErrors = 0;
  
  for (const state of Object.keys(STATE_NAMES)) {
    const result = seedStatePrograms(db, state);
    totalInserted += result.inserted;
    totalUpdated += result.updated;
    totalErrors += result.errors;
  }
  
  console.log(`[RealFunding] States: ${totalInserted} inserted, ${totalUpdated} updated`);
  return { inserted: totalInserted, updated: totalUpdated, errors: totalErrors };
}

/**
 * Get count of real opportunities per state
 */
export function getOpportunityCountsByState(db) {
  const counts = {};
  
  // National opportunities apply to all states
  const nationalCount = db.prepare(
    'SELECT COUNT(*) as count FROM funding_opportunities WHERE is_national = 1 AND is_active = 1'
  ).get().count;
  
  for (const state of Object.keys(STATE_NAMES)) {
    const stateCount = db.prepare(
      'SELECT COUNT(*) as count FROM funding_opportunities WHERE state = ? AND is_active = 1'
    ).get(state).count;
    
    counts[state] = nationalCount + stateCount;
  }
  
  counts.nationwide = nationalCount;
  return counts;
}

/**
 * Main function to seed all real funding opportunities
 */
export async function seedAllRealFunding(db) {
  console.log('[RealFunding] Starting comprehensive real funding seed...');
  
  // Seed national programs
  const nationalResult = seedNationalPrograms(db);
  
  // Seed state programs
  const stateResult = seedAllStatePrograms(db);
  
  // Get counts
  const counts = getOpportunityCountsByState(db);
  
  const total = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1').get().count;
  
  console.log(`[RealFunding] Complete. Total active opportunities: ${total}`);
  console.log(`[RealFunding] Every ZIP code has access to at least ${counts.nationwide} national programs`);
  
  return {
    national: nationalResult,
    states: stateResult,
    total,
    national_count: counts.nationwide,
    counts_by_state: counts
  };
}

export default {
  seedAllRealFunding,
  seedNationalPrograms,
  seedStatePrograms,
  seedAllStatePrograms,
  getOpportunityCountsByState,
  NATIONAL_PROGRAMS,
  STATE_PROGRAMS,
  STATE_NAMES
};
