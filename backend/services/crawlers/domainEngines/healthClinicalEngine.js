/**
 * Health and clinical support domain engine. Grants and assistance for medical, mental health, prescription.
 */

import { normalizeAndFilter } from './engineHelper.js'
import { createLogger } from '../../../utils/logger.js'
const qualityLog = createLogger('services:crawlers:domainEngines:healthClinicalEngine')

const ENGINE_ID = 'health_clinical'

const DIRECTORY_RESOURCES = [
  { title: 'HRSA Health Centers', description: 'Federally qualified health centers and sliding-scale care', url: 'https://www.hrsa.gov/health-centers', categories: ['health'], keywords: ['health center', 'FQHC'] },
  { title: 'Medicaid Coverage', description: 'State Medicaid programs and eligibility', url: 'https://www.medicaid.gov/', categories: ['health'], keywords: ['Medicaid', 'coverage'] },
  { title: 'Medicare Extra Help', description: 'Prescription drug cost assistance for Medicare', url: 'https://www.ssa.gov/medicare/part-d-extra-help', categories: ['health'], keywords: ['Medicare', 'prescription'] },
  { title: 'NeedyMeds', description: 'Prescription and medical cost assistance programs', url: 'https://www.needymeds.org/', categories: ['health'], keywords: ['prescription', 'assistance'] },
  { title: 'SAMHSA Behavioral Health', description: 'Substance use and mental health treatment grants', url: 'https://www.samhsa.gov/grants', categories: ['health', 'mental health'], keywords: ['SAMHSA', 'mental health'] },
  { title: 'NIH Clinical Trials', description: 'Clinical trials and research participant support', url: 'https://clinicaltrials.gov/', categories: ['health'], keywords: ['clinical trial'] },
  { title: 'Cancer Financial Assistance', description: 'CancerCare and other cancer cost assistance', url: 'https://www.cancercare.org/financial_assistance', categories: ['health'], keywords: ['cancer', 'financial'] },
  { title: 'Patient Advocate Foundation', description: 'Financial assistance for chronic illness', url: 'https://www.patientadvocate.org/', categories: ['health'], keywords: ['patient', 'assistance'] },
  { title: 'Rural Health Programs', description: 'HRSA rural health grants and services', url: 'https://www.hrsa.gov/rural-health', categories: ['health', 'rural'], keywords: ['rural', 'health'] },
]

export async function runHealthClinicalEngine(profile, options = {}) {
  try {
    const needs = profile.needs || []
    const conditions = profile.health?.conditions || []

    const HEALTH_NEED_SIGNALS = ['health', 'medical', 'mental_health', 'prescription', 'behavioral_health', 'clinical']
    const hasHealthNeed = needs.length === 0 || needs.some(n => HEALTH_NEED_SIGNALS.includes(n))

    let candidates = DIRECTORY_RESOURCES

    if (!hasHealthNeed) {
      console.warn(`[${ENGINE_ID}] profile has no health need signals — returning empty candidate set`)
      return []
    }

    // Retain all general health resources; only exclude disease-specific when no matching condition
    const DISEASE_SPECIFIC = ['cancer']
    candidates = candidates.filter(resource => {
      const resourceKeywords = resource.keywords.map(k => k.toLowerCase())
      const isDiseaseSpecific = DISEASE_SPECIFIC.some(d => resourceKeywords.includes(d))
      if (isDiseaseSpecific) {
        return conditions.some(c => DISEASE_SPECIFIC.includes(c.toLowerCase()))
      }
      return true
    })

    if (candidates.length === 0) {
      console.warn(`[${ENGINE_ID}] zero candidates after profile filtering for profile needs: ${JSON.stringify(needs)}`)
    }

    return normalizeAndFilter(candidates, ENGINE_ID, { strict_no_loans: false, strict_no_matching: false })
  } catch (error) {
    qualityLog.error(`[${ENGINE_ID}] engine error: ${error.message}`)
    return []
  }
}
