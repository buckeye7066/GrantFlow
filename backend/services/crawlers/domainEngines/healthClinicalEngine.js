/**
 * Health and clinical support domain engine. Grants and assistance for medical, mental health, prescription.
 */

import { normalizeAndFilter } from './engineHelper.js'

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
    return normalizeAndFilter(DIRECTORY_RESOURCES, ENGINE_ID, { strict_no_loans: false, strict_no_matching: false })
  } catch {
    return []
  }
}
