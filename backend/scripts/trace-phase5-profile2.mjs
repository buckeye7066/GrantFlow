import { computeMatchDecision } from '../services/matchEngine.js'
import { normalizeOpportunity } from '../services/opportunityNormalizer.js'

// Mirror profile 2 from the phase5 test
const profile = {
  id: 'phase5-profile2',
  primary_type: 'small_business',
  state: 'CA',
  city: 'San Francisco',
  postal_code: '94105',
  display_name: 'Profile Two',
  tags: ['community', 'small business', 'entrepreneurship'],
  needs: '["business"]',
}

const profileSections = {
  basic_information: {
    full_name: 'Profile Two',
    city: 'San Francisco',
    state: 'CA',
    zip: '94105',
    profile_category: 'small_business',
  },
  narrative: {
    primary_goal: 'Seeking small business startup grants and community impact funding',
    target_population: 'Small businesses in California',
    geographic_focus: 'San Francisco CA',
  },
}

// Common opps the local crawler might insert
const opps = [
  {
    title: 'Community Development Block Grant',
    description: 'Community development funding for projects benefiting low-to-moderate income communities in California.',
    application_url: 'https://www.hud.gov/cdbg',
    state: 'CA',
    is_national: 0,
    categories: '["community"]',
    keywords: '["community", "development"]',
  },
  {
    title: 'California Small Business Loan Guarantee Program',
    description: 'Small businesses can apply for loan guarantees to access growth capital.',
    application_url: 'https://www.ibank.ca.gov/sbfc/sblgp/',
    state: 'CA',
    is_national: 0,
    is_loan: 1,
    categories: '["business"]',
    keywords: '["small business", "loan"]',
  },
  {
    title: 'SBA 7(a) Loan',
    description: 'SBA-backed loan program for small businesses.',
    application_url: 'https://sba.gov/funding-programs/loans/7a-loans',
    is_national: 1,
    is_loan: 1,
    categories: '["business"]',
    keywords: '["small business"]',
  },
  {
    title: 'California Dream Fund Grant',
    description: 'Microgrants of up to $10,000 for new small businesses started by underserved entrepreneurs in California.',
    application_url: 'https://business.ca.gov/dreamfund',
    state: 'CA',
    is_national: 0,
    categories: '["business"]',
    keywords: '["small business", "microgrant"]',
  },
  {
    title: 'Small Business Innovation Research (SBIR)',
    description: 'Federal grant program funding R&D at small businesses across the United States.',
    application_url: 'https://sbir.gov/',
    is_national: 1,
    categories: '["business", "research"]',
    keywords: '["small business", "research"]',
  },
]

for (const opp of opps) {
  const norm = normalizeOpportunity(opp)
  const result = computeMatchDecision(profile, opp, { profileSections })
  console.log('---')
  console.log('TITLE:', opp.title)
  console.log(' isLoan:', norm.isLoan, 'requiresBusiness:', norm.requiresBusiness, 'requiresNonprofit:', norm.requiresNonprofit, 'isInstitutionalOnly:', norm.isInstitutionalOnly, 'isResearchOnly:', norm.isResearchOnly)
  console.log(' decision:', result.decision, 'score:', result.score, 'eligible:', result.eligible)
  if ((result.ineligibilityReasons ?? []).length > 0) {
    console.log(' ineligibilityReasons:', result.ineligibilityReasons)
  }
  if ((result.match_explain?.scoreCaps ?? []).length > 0) {
    console.log(' scoreCaps:', result.match_explain.scoreCaps)
  }
}
