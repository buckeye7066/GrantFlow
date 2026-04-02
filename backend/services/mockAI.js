/**
 * Mock AI Service
 * DEPRECATED: Only for development/testing when OpenAI is not available
 * Production code should NEVER use these mock responses
 * 
 * @deprecated Use real AI service instead
 */

const isDevelopment = process.env.NODE_ENV === 'development' || process.env.ALLOW_MOCK_AI === 'true';

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_MOCK_AI !== 'true') {
  throw new Error('mockAI must not be loaded in production — set ALLOW_MOCK_AI=true to override');
}

export function getMockFieldSuggestion(fieldName, fieldLabel) {
  // Remove redundant check since module-level check exists
  
  console.warn('[MOCK AI] Using mock suggestion for:', fieldName);
  
  const mockSuggestions = {
    mission: 'To empower underserved communities through comprehensive support services, educational programs, and sustainable resource development.',
    primary_goal: 'Increase access to essential services and opportunities for low-income families, with a focus on education, healthcare, and economic mobility.',
    funding_amount_needed: '$50,000 for program expansion and operational support',
    timeline: '12-month implementation period with quarterly milestones and reporting',
    past_experience: 'Successfully managed 5 federal grants totaling $500,000 over the past 3 years, serving over 1,000 beneficiaries.',
    unique_qualities: 'Deep community roots with 15+ years of local engagement, culturally competent staff, and proven track record of sustainable program delivery.',
    collaboration_partners: 'Local school district, regional health system, community action agency, and three faith-based organizations.',
    sustainability_plan: 'Diversified funding strategy including government grants, corporate partnerships, individual donations, and earned revenue through fee-for-service programs.',
    organization_type: 'nonprofit',
    staff_count: '15',
    annual_budget: '250000'
  }
  
  return mockSuggestions[fieldName] || `Sample content for ${fieldLabel}. This demonstrates the type of information that would be helpful for grant applications.`
}

export function getMockSectionSuggestion(sectionKey) {
  // Remove redundant check since module-level check exists
  
  console.warn('[MOCK AI] Using mock section suggestion for:', sectionKey);
  
  const suggestions = {
    basic_information: {
      full_name: 'Community Support Organization',
      email: 'info@example-org.org',
      phone: '555-0100',
      website: 'https://example-org.org',
      address: '123 Main Street, Anytown, OH 45000'
    },
    financial_information: {
      household_income: 45000,
      household_size: 4,
      financial_need_level: 'moderate',
      low_income: true
    },
    narrative: {
      mission: 'Empowering communities through sustainable development',
      primary_goal: 'Expand services to reach 500+ families annually',
      funding_amount_needed: '$75,000'
    }
  }
  
  return suggestions[sectionKey] || {}
}

export default { getMockFieldSuggestion, getMockSectionSuggestion }
