/**
 * prescriptionAssistance.js
 *
 * Curated prescription drug assistance programs (PAPs) available to individuals.
 * Includes pharmaceutical manufacturer PAPs, national clearinghouses, drug discount
 * programs, and government assistance for prescription costs.
 *
 * Most PAPs require: no insurance OR insurance does not cover the drug,
 * and income below a threshold (typically 200–400% FPL).
 * Discount card programs (GoodRx, NeedyMeds card) have NO income requirement.
 *
 * NO loans. Direct assistance only. Every URL is real and current.
 */

export const PRESCRIPTION_ASSISTANCE_PROGRAMS = [

  // ════════════════════════════════════════
  // NATIONAL CLEARINGHOUSES & DIRECTORIES
  // ════════════════════════════════════════
  {
    id: 'pap-needymeds',
    name: 'NeedyMeds — Patient Assistance Program Directory',
    description: 'Free national clearinghouse listing thousands of patient assistance programs, drug discount cards, free clinics, and disease-based assistance. Search by drug name or condition to find PAPs you may qualify for. Completely free to use.',
    url: 'https://www.needymeds.org/',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'referral',
    fundingType: 'referral_service',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['any_condition'],
    eligibility: {
      incomeLimit: 'Varies by program listed',
      requiresInsuranceGap: false,
      note: 'Directory — individual programs have their own eligibility requirements',
    },
    recurring: true,
  },

  {
    id: 'pap-rxassist',
    name: 'RxAssist — Pharmaceutical Assistance Directory',
    description: 'Comprehensive online directory of pharmaceutical manufacturer patient assistance programs. Search by medication name to find the manufacturer PAP, eligibility criteria, and application instructions. Free resource for patients, caregivers, and healthcare providers.',
    url: 'https://www.rxassist.org/',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'referral',
    fundingType: 'referral_service',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['any_condition'],
    eligibility: {
      incomeLimit: 'Varies by program listed',
      requiresInsuranceGap: false,
      note: 'Directory — individual PAPs have their own eligibility rules',
    },
    recurring: true,
  },

  {
    id: 'pap-medicine-assistance-tool',
    name: 'Medicine Assistance Tool (MAT) — formerly Partnership for Prescription Assistance',
    description: 'Free resource from PhRMA that helps patients find the right manufacturer patient assistance programs. The Partnership for Prescription Assistance merged into this tool. Enter your medication and income information to see programs you may qualify for.',
    url: 'https://www.medicineassistancetool.org/',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'referral',
    fundingType: 'referral_service',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['any_condition'],
    eligibility: {
      incomeLimit: 'Varies by manufacturer program',
      requiresInsuranceGap: true,
      note: 'Typically for those without adequate insurance coverage',
    },
    recurring: true,
  },

  // ════════════════════════════════════════
  // DRUG DISCOUNT CARDS (NO INCOME REQUIREMENT)
  // ════════════════════════════════════════
  {
    id: 'pap-needymeds-card',
    name: 'NeedyMeds Drug Discount Card',
    description: 'Free drug discount card with no income requirement, no enrollment, and no expiration. Accepted at over 70,000 pharmacies nationwide. Saves an average of 45% on brand and generic medications. Print, text, or download the card for instant use.',
    url: 'https://www.needymeds.org/drug-discount-card',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['any_condition'],
    eligibility: {
      incomeLimit: 'None — available to anyone',
      requiresInsuranceGap: false,
      note: 'Can be used by insured patients when discount is lower than copay',
    },
    recurring: true,
  },

  {
    id: 'pap-goodrx',
    name: 'GoodRx — Prescription Drug Discount Program',
    description: 'Free discount card and app that reduces prescription costs by up to 80% at over 70,000 pharmacies. No income requirement, no enrollment fee, no insurance required. Compare prices at different pharmacies. GoodRx Gold membership offers additional savings for a monthly fee.',
    url: 'https://www.goodrx.com/',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['any_condition'],
    eligibility: {
      incomeLimit: 'None — open to everyone',
      requiresInsuranceGap: false,
      note: 'Works for insured and uninsured patients; discount often beats insurance copay',
    },
    recurring: true,
  },

  // ════════════════════════════════════════
  // MANUFACTURER PATIENT ASSISTANCE PROGRAMS
  // ════════════════════════════════════════
  {
    id: 'pap-pfizer-rxpathways',
    name: 'Pfizer RxPathways — Patient Assistance Program',
    description: 'Pfizer\'s patient assistance program providing free or reduced-cost Pfizer medicines to eligible patients. RxPathways connects patients to co-pay assistance, Medicare assistance, and free medicine programs. Income thresholds typically up to 400% FPL depending on medication.',
    url: 'https://www.pfizerrxpathways.com/',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['any_condition'],
    eligibility: {
      incomeLimit: 'Typically up to 400% FPL; varies by medication',
      requiresInsuranceGap: true,
      note: 'For uninsured or underinsured patients; must be prescribed a Pfizer medication',
    },
    recurring: true,
  },

  {
    id: 'pap-lilly-cares',
    name: 'Lilly Cares Foundation / Eli Lilly Insulin Value Program',
    description: 'Lilly Cares Foundation provides free Eli Lilly medicines (including insulin) to qualifying patients who lack insurance or adequate coverage. The Insulin Value Program caps out-of-pocket insulin costs at $35/month for eligible patients. Covers Humalog, Basaglar, Trulicity, and other Lilly medications.',
    url: 'https://www.lillycares.com/',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['diabetes', 'insulin_dependent'],
    eligibility: {
      incomeLimit: 'Up to 400% FPL for most programs; no income limit for Insulin Value Program cap',
      requiresInsuranceGap: true,
      note: 'Must be prescribed a Lilly medication; separate applications for each program',
    },
    recurring: true,
  },

  {
    id: 'pap-azandme',
    name: 'AZ&Me Prescription Savings (AstraZeneca)',
    description: 'AstraZeneca\'s patient assistance program offering free AstraZeneca medicines to qualifying patients. AZ&Me covers medications for heart disease, diabetes, respiratory conditions, cancer, and more. Patients with no insurance or who are underinsured may receive medications at no cost.',
    url: 'https://www.azandme.com/',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['heart_disease', 'diabetes', 'respiratory', 'cancer', 'any_condition'],
    eligibility: {
      incomeLimit: 'Up to 400% FPL (up to 600% for some medications)',
      requiresInsuranceGap: true,
      note: 'Uninsured or underinsured patients; must use an AstraZeneca medication',
    },
    recurring: true,
  },

  {
    id: 'pap-novo-nordisk',
    name: 'Novo Nordisk Patient Assistance Program',
    description: 'Novo Nordisk provides free diabetes and obesity medications (Ozempic, Victoza, NovoLog, Levemir, Saxenda, and others) to patients who cannot afford them. Separate programs exist for uninsured patients and those who are underinsured. The Patient Assistance Program provides medications at no charge to eligible patients.',
    url: 'https://www.novonordisk-us.com/patients/patient-assistance-programs.html',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['diabetes', 'obesity', 'insulin_dependent'],
    eligibility: {
      incomeLimit: 'Typically up to 400% FPL',
      requiresInsuranceGap: true,
      note: 'For uninsured or underinsured patients prescribed Novo Nordisk medications',
    },
    recurring: true,
  },

  {
    id: 'pap-jjpaf',
    name: 'Johnson & Johnson Patient Assistance Foundation',
    description: 'The Johnson & Johnson Patient Assistance Foundation provides free J&J prescription medicines to low-income patients who are uninsured or underinsured. Covers a range of medications including those for mental health, immunology, and oncology. Applications reviewed on a case-by-case basis.',
    url: 'https://www.jjpaf.org/',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['mental_health', 'cancer', 'any_condition'],
    eligibility: {
      incomeLimit: 'Up to 200% FPL for most programs',
      requiresInsuranceGap: true,
      note: 'Must be uninsured or have insurance that does not cover the medication',
    },
    recurring: true,
  },

  {
    id: 'pap-myabbvie-assist',
    name: 'myAbbVie Assist — AbbVie Patient Assistance Foundation',
    description: 'AbbVie\'s patient assistance program providing free AbbVie medications (Humira, Skyrizi, Rinvoq, Imbruvica, Mavyret, and others) to qualifying patients who are uninsured or whose insurance does not cover these medications. Income-based eligibility with application reviewed by program staff.',
    url: 'https://www.myabbvieassist.com/',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['autoimmune', 'hepatitis_c', 'cancer', 'any_condition'],
    eligibility: {
      incomeLimit: 'Up to 400% FPL depending on medication',
      requiresInsuranceGap: true,
      note: 'Must be uninsured or underinsured; must use an AbbVie medication',
    },
    recurring: true,
  },

  {
    id: 'pap-bms-foundation',
    name: 'Bristol Myers Squibb Patient Assistance Foundation',
    description: 'The Bristol Myers Squibb Patient Assistance Foundation provides free BMS medications to patients who meet income and insurance eligibility requirements. Covers oncology drugs, immunology medications, cardiovascular treatments, and others. Applications processed through the foundation\'s program office.',
    url: 'https://www.bms.com/patient-and-caregiver-support/patient-assistance-foundation.html',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['cancer', 'cardiovascular', 'autoimmune', 'any_condition'],
    eligibility: {
      incomeLimit: 'Up to 200-400% FPL depending on medication',
      requiresInsuranceGap: true,
      note: 'Uninsured or underinsured patients prescribed BMS medications',
    },
    recurring: true,
  },

  {
    id: 'pap-merckhelps',
    name: 'MerckHelps — Merck Patient Assistance Program',
    description: 'MerckHelps provides free Merck prescription medications to qualifying low-income patients who are uninsured or underinsured. Covers medications for diabetes, heart disease, asthma, HIV, and other conditions. Patients can apply online or through their healthcare provider.',
    url: 'https://www.merckhelps.com/',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['diabetes', 'heart_disease', 'hiv', 'respiratory', 'any_condition'],
    eligibility: {
      incomeLimit: 'Up to 400% FPL depending on medication',
      requiresInsuranceGap: true,
      note: 'Must be a US resident, uninsured or underinsured, and prescribed a Merck medication',
    },
    recurring: true,
  },

  // ════════════════════════════════════════
  // GOVERNMENT PRESCRIPTION ASSISTANCE
  // ════════════════════════════════════════
  {
    id: 'pap-medicare-extra-help',
    name: 'Medicare Extra Help (Low-Income Subsidy) for Part D',
    description: 'Federal program that helps Medicare beneficiaries with limited income and resources pay for prescription drug (Part D) costs including premiums, deductibles, and copays. Beneficiaries with full Extra Help pay no more than $4.50 for generics and $11.20 for brand-name drugs in 2024. Apply through Social Security Administration.',
    url: 'https://www.ssa.gov/medicare/part-d-low-income-subsidy',
    categories: ['healthcare', 'prescription_assistance', 'senior'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance', 'senior'],
    healthMatch: ['any_condition'],
    eligibility: {
      incomeLimit: 'Up to 150% FPL for full subsidy; graduated assistance up to ~185% FPL',
      requiresInsuranceGap: false,
      note: 'Must be enrolled in Medicare Part A or Part B; income and resource limits apply',
      requiresMedicare: true,
    },
    recurring: true,
  },

  {
    id: 'pap-spap',
    name: 'State Pharmaceutical Assistance Programs (SPAP)',
    description: 'Many states operate their own pharmaceutical assistance programs for low-income residents, especially seniors and people with disabilities. SPAPs may help with Medicare Part D costs, specific high-cost drugs, or general prescription expenses. Eligibility and benefits vary significantly by state. Search benefits.gov for your state\'s SPAP.',
    url: 'https://www.benefits.gov/categories/Health%20Care',
    categories: ['healthcare', 'prescription_assistance', 'senior'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance', 'senior'],
    healthMatch: ['any_condition'],
    eligibility: {
      incomeLimit: 'Varies by state; typically up to 200-400% FPL',
      requiresInsuranceGap: false,
      note: 'State-specific; some target seniors 65+, others disabled individuals of any age',
    },
    recurring: true,
  },

  {
    id: 'pap-340b',
    name: '340B Drug Pricing Program — Discounted Drugs at Qualifying Health Centers',
    description: 'The federal 340B program requires drug manufacturers to provide significantly discounted medications to eligible healthcare organizations, including federally qualified health centers (FQHCs), rural health clinics, and safety-net hospitals. Patients receiving care at 340B-covered entities can access medications at much lower prices. To access 340B pricing, get care at a participating FQHC or covered entity.',
    url: 'https://www.hrsa.gov/opa/index.html',
    categories: ['healthcare', 'prescription_assistance'],
    type: 'assistance',
    fundingType: 'direct_benefit',
    intentMatch: ['healthcare', 'prescription_assistance'],
    healthMatch: ['any_condition'],
    eligibility: {
      incomeLimit: 'No direct income limit — access through participating health centers (which serve low-income patients)',
      requiresInsuranceGap: false,
      note: 'Must receive care at a 340B-covered entity such as a Federally Qualified Health Center (FQHC). Find FQHCs at findahealthcenter.hrsa.gov',
    },
    recurring: true,
  },
];
