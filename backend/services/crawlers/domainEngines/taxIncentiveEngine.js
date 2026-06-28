/**
 * Tax incentive domain engine. Funding-focused credits and relief programs.
 */
import { normalizeAndFilter } from './engineHelper.js'
import { createLogger } from '../../../utils/logger.js'
const qualityLog = createLogger('services:crawlers:domainEngines:taxIncentiveEngine')

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
    // Build an inclusive set: start with base resources, then UNION in profile-relevant resources
    const profileMatched = new Set()

    if (profile.income && profile.income < 30000) {
      DIRECTORY_RESOURCES.forEach(r => {
        if (r.keywords.includes('EITC') || r.title.includes('Low Income') || r.categories.includes('tax')) {
          profileMatched.add(r)
        }
      })
    }

    if (profile.hasChildren) {
      DIRECTORY_RESOURCES.forEach(r => {
        if (r.keywords.some(k => k === 'child') || r.categories.includes('family')) {
          profileMatched.add(r)
        }
      })
    }

    if (profile.businessType === 'small_business') {
      DIRECTORY_RESOURCES.forEach(r => {
        if (r.keywords.includes('small business') || r.categories.includes('business')) {
          profileMatched.add(r)
        }
      })
    }

    // If no profile signals matched, pass full directory to preserve recall
    const relevantResources = profileMatched.size > 0
      ? Array.from(profileMatched)
      : DIRECTORY_RESOURCES
    
    return normalizeAndFilter(relevantResources, ENGINE_ID, { strict_no_loans: false, strict_no_matching: false })
  } catch (error) {
    qualityLog.error(`Tax incentive engine error: ${error.message}`);
    return []
  }
}
