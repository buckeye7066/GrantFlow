/**
 * stateBase.js
 *
 * Generates baseline state programs for ANY US state using registry data.
 * Every state gets: benefits portal, SNAP, TANF, Medicaid, LIHEAP,
 * weatherization, HCBS waiver (ECF CHOICES equivalent), I/DD agency,
 * state housing authority, vocational rehab, and 211 service.
 *
 * States with dedicated files (WV.js, TN.js) use their own richer data;
 * this generator is the fallback for all other states.
 */

import { STATE_REGISTRY } from './stateRegistry.js';

/**
 * Generate baseline programs for a state.
 * @param {string} stateCode — 2-letter state code
 * @returns {{ benefits: Array, meta: Object|null, countyResources: Object }}
 */
export function generateStatePrograms(stateCode) {
  const reg = STATE_REGISTRY[stateCode];
  if (!reg) return { benefits: [], meta: { code: stateCode, name: 'Unknown State', benefitsPortal: null, benefitsPortalName: null, dhsPhone: null, is211Available: false }, countyResources: {} };

  const sc = stateCode.toLowerCase();
  const meta = {
    code: stateCode,
    name: reg.name,
    benefitsPortal: reg.benefitsPortal,
    benefitsPortalName: reg.benefitsPortalName,
    dhsPhone: reg.dhsPhone,
    is211Available: true,
  };

  const benefits = [
    // ── Combined Benefits Portal ──
    {
      id: `${sc}-benefits-portal`,
      name: `${reg.benefitsPortalName} — ${reg.name} Benefits Application`,
      description: `${reg.name}'s online portal for applying to SNAP (food), ${reg.tanfName}, Medicaid, and other state assistance programs in a single application.`,
      url: reg.benefitsPortal,
      categories: ['food', 'cash_assistance', 'healthcare', 'utilities', 'childcare'],
      eligibility: { incomeLimit: 'Varies by program' },
      type: 'portal',
      fundingType: 'direct_benefit',
      priority: 1,
      intentMatch: ['food', 'cash_assistance', 'healthcare', 'utilities', 'childcare'],
    },

    // ── SNAP ──
    {
      id: `${sc}-snap`,
      name: `${reg.name} SNAP (Food Assistance)`,
      description: `Monthly food benefits on an EBT card for eligible ${reg.name} households. Gross income limit is typically 130% FPL. Apply through ${reg.benefitsPortalName}.`,
      url: reg.benefitsPortal,
      categories: ['food'],
      eligibility: { incomeLimit: '130% FPL gross' },
      type: 'benefit',
      fundingType: 'direct_benefit',
      recurring: true,
      intentMatch: ['food'],
    },

    // ── TANF / Cash Assistance ──
    {
      id: `${sc}-tanf`,
      name: `${reg.tanfName} — ${reg.name} Cash Assistance`,
      description: `Monthly cash assistance for low-income families with children in ${reg.name}. Includes job training, education support, and emergency assistance. Apply through ${reg.benefitsPortalName}.`,
      url: reg.benefitsPortal,
      categories: ['cash_assistance', 'employment'],
      eligibility: { incomeLimit: 'Very low income', requiresChildren: true },
      type: 'benefit',
      fundingType: 'direct_benefit',
      recurring: true,
      familyMatch: ['has_children', 'single_parent'],
      intentMatch: ['cash_assistance', 'employment'],
    },

    // ── Medicaid ──
    {
      id: `${sc}-medicaid`,
      name: `${reg.medicaidName || (reg.name + ' Medicaid')}`,
      description: `${reg.medicaidExpanded ? 'Free or low-cost' : 'Health'} coverage for qualifying ${reg.name} residents. ${reg.medicaidExpanded ? `${reg.name} expanded Medicaid — adults up to 138% FPL qualify.` : `Coverage for children, pregnant women, elderly, and disabled. ${reg.name} has not expanded Medicaid for all adults.`} Covers medical, dental, vision, mental health, prescriptions, and more.`,
      url: reg.medicaidUrl || reg.benefitsPortal,
      categories: ['healthcare'],
      eligibility: { incomeLimit: reg.medicaidExpanded ? '138% FPL for adults' : 'Varies by category' },
      type: 'benefit',
      fundingType: 'direct_benefit',
      recurring: true,
      intentMatch: ['healthcare'],
    },

    // ── LIHEAP ──
    {
      id: `${sc}-liheap`,
      name: `${reg.name} LIHEAP (Home Energy Assistance)`,
      description: `Helps pay heating and cooling bills for low-income ${reg.name} households. Administered through local community action agencies. Apply through ${reg.benefitsPortalName} or your local CAA.`,
      url: reg.benefitsPortal,
      categories: ['utilities'],
      eligibility: { incomeLimit: '150% FPL (varies)' },
      type: 'benefit',
      fundingType: 'direct_benefit',
      recurring: true,
      intentMatch: ['utilities'],
    },

    // ── Weatherization ──
    {
      id: `${sc}-weatherization`,
      name: `${reg.name} Weatherization Assistance Program`,
      description: `Free home energy improvements for low-income ${reg.name} homeowners and renters: insulation, air sealing, furnace repair/replacement. Priority for elderly, disabled, and families with children.`,
      url: `https://www.energy.gov/scep/wap/weatherization-assistance-program`,
      categories: ['utilities', 'weatherization', 'housing'],
      eligibility: { incomeLimit: '200% FPL' },
      type: 'grant',
      fundingType: 'direct_service',
      recurring: false,
      intentMatch: ['utilities', 'housing'],
    },

    // ── HCBS Waiver (ECF CHOICES equivalent) ──
    {
      id: `${sc}-hcbs-idd`,
      name: `${reg.hcbsWaiver.name} — ${reg.name} I/DD Services`,
      description: reg.hcbsWaiver.description,
      url: reg.hcbsWaiver.url,
      categories: ['disability', 'employment', 'healthcare', 'housing'],
      eligibility: { requiresDisability: true, requiresMedicaid: true, stateResident: stateCode },
      type: 'benefit',
      fundingType: 'direct_service',
      recurring: true,
      healthMatch: ['disability', 'physical_disability', 'developmental_disability', 'intellectual_disability'],
      intentMatch: ['disability', 'healthcare'],
    },

    // ── I/DD Agency Portal ──
    {
      id: `${sc}-idd-agency`,
      name: `${reg.hcbsWaiver.agencyName}`,
      description: `State agency providing and coordinating services for ${reg.name} residents with intellectual and developmental disabilities. Gateway to all I/DD programs in the state.`,
      url: reg.hcbsWaiver.agencyUrl,
      categories: ['disability', 'employment', 'housing'],
      eligibility: { requiresDisability: true },
      type: 'portal',
      fundingType: 'direct_service',
      healthMatch: ['disability', 'developmental_disability', 'intellectual_disability'],
      intentMatch: ['disability'],
    },

    // ── State Housing Authority ──
    {
      id: `${sc}-housing-authority`,
      name: `${reg.housingName}`,
      description: `${reg.name}'s state housing finance agency. Provides programs for affordable housing, homebuyer assistance, homelessness prevention, emergency repair, and rental assistance.`,
      url: reg.housingUrl || reg.benefitsPortal || null,
      categories: ['housing'],
      eligibility: { incomeLimit: 'Varies by program' },
      type: 'portal',
      fundingType: 'direct_service',
      intentMatch: ['housing'],
    },

    // ── Vocational Rehabilitation ──
    {
      id: `${sc}-voc-rehab`,
      name: `${reg.name} Vocational Rehabilitation`,
      description: `Employment services for ${reg.name} residents with disabilities: job training, education, job placement, assistive technology, and support services.`,
      url: reg.vocRehabUrl && /^https?:\/\//i.test(reg.vocRehabUrl.trim()) ? reg.vocRehabUrl : null,
      categories: ['employment', 'disability', 'education'],
      eligibility: { requiresDisability: true },
      type: 'benefit',
      fundingType: 'direct_service',
      recurring: true,
      healthMatch: ['disability', 'physical_disability', 'visual_impairment', 'hearing_impairment', 'mental_health', 'developmental_disability'],
      intentMatch: ['employment', 'disability', 'education'],
    },

    // ── Childcare Assistance ──
    {
      id: `${sc}-childcare`,
      name: `${reg.name} Child Care Assistance`,
      description: `Subsidized child care for low-income working families in ${reg.name}. Helps pay for licensed child care so parents can work or attend school/training.`,
      url: reg.benefitsPortal,
      categories: ['childcare'],
      eligibility: { incomeLimit: '85% state median income (varies)', requiresChildren: true },
      type: 'benefit',
      fundingType: 'direct_benefit',
      recurring: true,
      familyMatch: ['has_children', 'single_parent'],
      intentMatch: ['childcare'],
    },

    // ── 211 Referral Service ──
    {
      id: `${sc}-211`,
      name: `${reg.name} 211 — Connect to Help`,
      description: `Free referral service connecting ${reg.name} residents to local assistance for utilities, food, housing, healthcare, employment, and more. Available 24/7.`,
      url: 'https://www.211.org/',
      applicationNote: 'Dial 2-1-1 from any phone',
      categories: ['utilities', 'housing', 'food', 'healthcare', 'cash_assistance', 'employment', 'mental_health', 'legal', 'transportation', 'childcare', 'disability'],
      type: 'referral',
      fundingType: 'referral_service',
      recurring: true,
      intentMatch: ['utilities', 'housing', 'food', 'healthcare', 'cash_assistance', 'employment'],
    },
  ];

  // Append state-specific enrichment programs when present
  if (Array.isArray(reg.extraPrograms)) {
    for (const ep of reg.extraPrograms) {
      // Goal 1: skip extra programs that have no valid application URL at source
      if (!ep.url || typeof ep.url !== 'string' || !/^https?:\/\//i.test(ep.url.trim())) {
        console.warn(`[stateBase] ${stateCode}: extraProgram '${ep.id || ep.name}' skipped — missing or invalid URL`);
        continue;
      }
      benefits.push({
        ...ep,
        id: ep.id || `${sc}-extra-${benefits.length}`,
        stateRestriction: stateCode,
      });
    }
  }

  // Goal 1 + Goal 3: strip any entry whose URL is missing or non-HTTP before returning
  const validBenefits = [];
  const droppedBenefits = [];
  for (const b of benefits) {
    if (typeof b.url === 'string' && /^https?:\/\//i.test(b.url.trim())) {
      validBenefits.push(b);
    } else {
      droppedBenefits.push({ id: b.id, reason: 'missing_or_invalid_url', url: b.url, categories: b.categories ?? [] });
    }
  }
  if (droppedBenefits.length > 0) {
    // Goal 8: log suppressed entries so pipeline observers know why recall was reduced
    console.warn(
      `[stateBase] ${stateCode}: ${droppedBenefits.length} baseline program(s) dropped — no valid application URL`,
      droppedBenefits
    );
  }
  return { benefits: validBenefits, meta, countyResources: {}, droppedCount: droppedBenefits.length };
}

/**
 * Check if a state has a dedicated file or needs auto-generation.
 * @param {string} stateCode
 * @returns {boolean}
 */
export function isStateInRegistry(stateCode) {
  return stateCode in STATE_REGISTRY;
}

export default { generateStatePrograms, isStateInRegistry };
