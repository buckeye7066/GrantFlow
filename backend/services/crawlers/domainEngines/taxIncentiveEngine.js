/**
 * Tax incentive domain engine. Funding-focused credits and relief programs.
 */
import { normalizeAndFilter } from './engineHelper.js'

const ENGINE_ID = 'tax_incentive'

const DIRECTORY_RESOURCES = [
  { title: 'IRS Tax Credits and Deductions', description: 'Federal tax credits for individuals and families', url: 'https://www.irs.gov/credits-deductions', categories: ['tax'], keywords: ['tax credit'] },
  { title: 'Earned Income Tax Credit', description: 'EITC for low- to moderate-income workers', url: 'https://www.irs.gov/credits-deductions/individuals/earned-income-tax-credit', categories: ['tax'], keywords: ['EITC'] },
  { title: 'Child Tax Credit', description: 'Child tax credit and additional child tax credit', url: 'https://www.irs.gov/credits-deductions/individuals/child-tax-credit', categories: ['tax', 'family'], keywords: ['child', 'tax credit'] },
  { title: 'State Tax Credits', description: 'State-by-state tax credit programs', url: 'https://www.usa.gov/tax-credits-deductions', categories: ['tax', 'state'], keywords: ['state', 'tax'] },
  { title: 'Low Income Housing Tax Credit', description: 'LIHTC for affordable housing', url: 'https://www.hud.gov/program_offices/housing/mfh/lihtc', categories: ['tax', 'housing'], keywords: ['LIHTC'] },
  { title: 'Small Business Tax Credits', description: 'IRS credits for small businesses', url: 'https://www.irs.gov/businesses/small-businesses-self-employed', categories: ['tax', 'business'], keywords: ['small business'] },
  { title: 'Energy Efficiency Tax Incentives', description: 'Federal tax credits for energy improvements', url: 'https://www.energy.gov/save/energy-efficiency-tax-credits', categories: ['tax', 'energy'], keywords: ['energy'] },
  { title: 'VITA Free Tax Preparation', description: 'Free tax filing for qualifying taxpayers', url: 'https://www.irs.gov/individuals/free-tax-return-preparation-for-qualifying-taxpayers', categories: ['tax'], keywords: ['VITA'] },
]

export async function runTaxIncentiveEngine(profile, options = {}) {
  try {
    // Filter tax incentives based on profile eligibility
    let relevantResources = DIRECTORY_RESOURCES;
    
    if (profile.income && profile.income < 30000) {
      relevantResources = relevantResources.filter(r => 
        r.keywords.includes('EITC') || r.title.includes('Low Income')
      );
    }
    
    if (profile.hasChildren) {
      relevantResources = relevantResources.filter(r => 
        r.keywords.includes('child') || r.categories.includes('family')
      );
    }
    
    if (profile.businessType === 'small_business') {
      relevantResources = relevantResources.filter(r => 
        r.keywords.includes('small business') || r.categories.includes('business')
      );
    }
    
    return normalizeAndFilter(relevantResources, ENGINE_ID, { strict_no_loans: false, strict_no_matching: false })
  } catch (error) {
    console.error(`Tax incentive engine error: ${error.message}`);
    return []
  }
}
