/**
 * familyPrograms.js
 *
 * Curated assistance programs specifically for families — parents, children,
 * single parents, foster families, and families in crisis. Covers childcare,
 * food assistance, health coverage, financial support, safety, and referral
 * services available nationally.
 *
 * All programs verified active 2024–2025. No loans. Direct assistance only.
 * Every URL is real and current.
 */

export const FAMILY_PROGRAMS = [

  // ════════════════════════════════════════
  // CHILDCARE & EARLY CHILDHOOD
  // ════════════════════════════════════════
  {
    id: 'family-ccdf-subsidy',
    name: 'Child Care and Development Fund (CCDF) — Child Care Subsidy',
    description: 'Federally funded child care subsidy program that helps low- and moderate-income families pay for child care while parents work, attend school, or participate in job training. States administer CCDF and set income limits (typically 85% State Median Income). Eligible families receive subsidized rates at licensed child care providers, including centers and family day care homes.',
    url: 'https://www.acf.hhs.gov/occ/ccdf-reauthorization',
    applicant_types: ['individual', 'family'],
    categories: ['childcare', 'family_support'],
    type: 'program',
    fundingType: 'direct_benefit',
    intentMatch: ['childcare', 'working_parent', 'family', 'daycare'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: true,
    eligibility: {
      incomeLimit: 'Up to 85% State Median Income (varies by state)',
      note: 'Must be working, in school, or in job training; child must be under 13',
    },
  },

  {
    id: 'family-head-start',
    name: 'Head Start / Early Head Start',
    description: 'Federally funded comprehensive early childhood program serving children from birth to age 5, pregnant women, and their families. Head Start (ages 3–5) and Early Head Start (birth–3) provide education, health, nutrition, and family support services at no cost to eligible families. Income limit is 100% of the federal poverty level, with up to 10% of slots for children above the poverty line.',
    url: 'https://www.acf.hhs.gov/ohs',
    applicant_types: ['individual', 'family'],
    categories: ['childcare', 'education', 'family_support'],
    type: 'program',
    fundingType: 'direct_benefit',
    intentMatch: ['early_childhood', 'preschool', 'family', 'low_income'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: true,
    eligibility: {
      incomeLimit: '100% FPL (10% of slots may exceed limit)',
      note: 'Children with disabilities may be enrolled regardless of income; serves birth through age 5',
    },
  },

  // ════════════════════════════════════════
  // FINANCIAL ASSISTANCE FOR FAMILIES
  // ════════════════════════════════════════
  {
    id: 'family-tanf',
    name: 'Temporary Assistance for Needy Families (TANF)',
    description: 'Federal block grant program providing time-limited cash assistance and supportive services to low-income families with children. TANF helps families achieve self-sufficiency through cash benefits, job preparation, work opportunities, and child care support. States administer TANF with flexibility in benefit levels and eligibility rules. Income limits and benefit amounts vary significantly by state.',
    url: 'https://www.acf.hhs.gov/ofa/programs/tanf',
    applicant_types: ['individual', 'family'],
    categories: ['financial_assistance', 'family_support'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['family', 'single_parent', 'financial_hardship', 'below_poverty_line'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: true,
    eligibility: {
      incomeLimit: 'Very low income; varies by state',
      requiresChildren: true,
      note: 'Must have dependent children; subject to work requirements and 60-month lifetime federal limit',
    },
    familyMatch: ['has_children', 'single_parent'],
  },

  {
    id: 'family-eitc-ctc',
    name: 'Earned Income Tax Credit (EITC) / Child Tax Credit (CTC)',
    description: 'The Earned Income Tax Credit is a refundable federal tax credit for low- to moderate-income working families. Families with three or more children can receive up to $7,830 (2024). The Child Tax Credit provides up to $2,000 per qualifying child under 17, with up to $1,700 refundable as the Additional Child Tax Credit. Both credits directly reduce taxes owed and can result in a refund even if no taxes are owed.',
    url: 'https://www.irs.gov/credits-deductions/individuals/earned-income-tax-credit-eitc',
    applicant_types: ['individual', 'family'],
    categories: ['tax_benefit', 'financial_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['family', 'working_parent', 'low_income', 'tax_credit'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: true,
    eligibility: {
      incomeLimit: 'Up to $66,819 (2024, three or more children, married filing jointly)',
      note: 'Must have earned income; investment income limit applies; claim annually via federal tax return',
    },
  },

  // ════════════════════════════════════════
  // FOOD ASSISTANCE FOR FAMILIES
  // ════════════════════════════════════════
  {
    id: 'family-wic',
    name: 'Special Supplemental Nutrition Program for Women, Infants, and Children (WIC)',
    description: 'Federal nutrition program providing healthy foods, nutrition education, breastfeeding support, and health care referrals to income-eligible pregnant women, new mothers, infants, and children up to age 5. WIC participants receive monthly food benefits (via EBT card or vouchers) for specific nutritious foods including fruits, vegetables, whole grains, dairy, eggs, beans, and infant formula. Income limit is typically 185% of the federal poverty level.',
    url: 'https://www.fns.usda.gov/wic',
    applicant_types: ['individual', 'family'],
    categories: ['food_assistance', 'health', 'family_support'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['pregnant', 'infant', 'young_children', 'nutrition', 'family'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: true,
    eligibility: {
      incomeLimit: '185% FPL',
      note: 'Must be pregnant, recently gave birth, breastfeeding, or have a child under age 5; categorical eligibility if enrolled in Medicaid/SNAP/TANF',
    },
  },

  {
    id: 'family-nslp',
    name: 'National School Lunch Program (NSLP)',
    description: 'Federally assisted meal program providing nutritionally balanced, low-cost or no-cost lunches to children in public and non-profit private schools and residential child care institutions. Children from households at or below 130% of the poverty level receive free meals; those between 130–185% of the poverty level receive reduced-price meals (no more than $0.40). Apply through your child\'s school at the start of each school year.',
    url: 'https://www.fns.usda.gov/nslp',
    applicant_types: ['individual', 'family'],
    categories: ['food_assistance', 'education'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['school_age_children', 'lunch', 'family', 'low_income'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: true,
    eligibility: {
      incomeLimit: '185% FPL for reduced-price; 130% FPL for free meals',
      note: 'Apply through your child\'s school; automatic eligibility if enrolled in SNAP, TANF, or FDPIR',
    },
  },

  {
    id: 'family-sfsp',
    name: 'Summer Food Service Program (SFSP)',
    description: 'Federally funded program that ensures children 18 and younger continue to receive nutritious meals during the summer when school is not in session. Free meals are served at approved community sites such as schools, parks, community centers, and other locations in low-income areas. No income verification required — any child 18 or under can eat for free at a SFSP site. Find a site at meals4kids.usda.gov.',
    url: 'https://www.fns.usda.gov/sfsp/summer-food-service-program',
    applicant_types: ['individual', 'family'],
    categories: ['food_assistance', 'children'],
    type: 'program',
    fundingType: 'direct_benefit',
    intentMatch: ['summer', 'children', 'food_assistance', 'family'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: true,
    eligibility: {
      incomeLimit: 'None — open to all children 18 and under at participating sites',
      note: 'Sites are located in low-income areas; no application needed — just visit a site',
    },
  },

  // ════════════════════════════════════════
  // HEALTH COVERAGE FOR FAMILIES & CHILDREN
  // ════════════════════════════════════════
  {
    id: 'family-chip',
    name: "Children's Health Insurance Program (CHIP)",
    description: "Federal-state partnership providing low-cost or free health insurance to children up to age 19 in families who earn too much to qualify for Medicaid but cannot afford private insurance. CHIP covers doctor visits, immunizations, hospitalizations, dental and vision care, prescriptions, and more. Income limits vary by state but typically cover families up to 200–300% of the federal poverty level. Apply through your state's Medicaid agency.",
    url: 'https://www.medicaid.gov/chip/index.html',
    applicant_types: ['individual', 'family'],
    categories: ['health', 'insurance', 'children'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['children_health', 'uninsured', 'family', 'healthcare'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: true,
    eligibility: {
      incomeLimit: 'Typically 200–300% FPL (varies by state)',
      note: 'For uninsured children under 19; some states also cover pregnant women and parents',
    },
  },

  {
    id: 'family-mchb-block-grant',
    name: 'Maternal and Child Health Block Grant (Title V)',
    description: 'Federal block grant program that funds state and community health programs for mothers, children, and families with special health care needs. Title V funds support prenatal care, newborn screenings, well-child visits, immunizations, dental care, and services for children with special health care needs. Services are often provided at reduced or no cost at local health departments and community health centers.',
    url: 'https://mchb.hrsa.gov/programs-impact/programs/maternal-child-health-block-grant',
    applicant_types: ['individual', 'family'],
    categories: ['health', 'family_support', 'maternal_health'],
    type: 'program',
    fundingType: 'direct_benefit',
    intentMatch: ['maternal_health', 'newborn', 'infant', 'family', 'prenatal'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: true,
    eligibility: {
      incomeLimit: 'Varies by state and specific program',
      note: 'Services delivered through state health departments and local health centers; contact your state MCH program for availability',
    },
  },

  {
    id: 'family-healthy-start',
    name: 'Healthy Start Initiative (Prenatal Care for High-Risk Communities)',
    description: 'HRSA-funded program providing community-based prenatal and infant health services in communities with high rates of infant mortality. Healthy Start offers case management, prenatal care coordination, interconception care, home visiting, substance use treatment, mental health services, and support for fathers and families. Programs are located in communities disproportionately impacted by infant mortality and maternal health disparities.',
    url: 'https://mchb.hrsa.gov/programs-impact/programs/healthy-start',
    applicant_types: ['individual', 'family'],
    categories: ['health', 'maternal_health'],
    type: 'program',
    fundingType: 'direct_benefit',
    intentMatch: ['prenatal', 'infant_mortality', 'family', 'high_risk_pregnancy'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: true,
    eligibility: {
      incomeLimit: 'Varies by local Healthy Start program',
      note: 'Serves women before, during, and after pregnancy and infants up to 18–24 months; find a program at findahealthcenter.hrsa.gov',
    },
  },

  // ════════════════════════════════════════
  // EMERGENCY & CRISIS SUPPORT
  // ════════════════════════════════════════
  {
    id: 'family-community-action-emergency',
    name: 'Emergency Assistance for Families (Community Action Agencies)',
    description: 'Community Action Agencies (CAAs) provide emergency financial assistance to families in crisis, including help with rent, utilities, food, clothing, transportation, and other urgent needs. Funded through the Community Services Block Grant (CSBG) and other sources, CAAs serve low-income individuals and families in every US county. Services and eligibility vary by location; most serve households at or below 200% FPL. Find your local CAA at communityactionpartnership.com.',
    url: 'https://communityactionpartnership.com/find-a-cap/',
    applicant_types: ['individual', 'family'],
    categories: ['emergency', 'financial_assistance', 'family_support'],
    type: 'referral',
    fundingType: 'referral_service',
    intentMatch: ['emergency', 'crisis', 'family', 'eviction', 'utility'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: false,
    eligibility: {
      incomeLimit: 'Typically up to 200% FPL; varies by agency and program',
      note: 'Emergency assistance is often first-come, first-served; contact your local CAA for available programs',
    },
  },

  {
    id: 'family-fvpsa-dv-shelter',
    name: 'Family Violence Prevention and Services Act (FVPSA) — Domestic Violence Shelter & Services',
    description: 'Federal law funding emergency shelter, safety planning, legal advocacy, counseling, and support services for survivors of domestic violence and their children. FVPSA-funded programs operate in every state through a network of local domestic violence shelters and service organizations. Services are free and confidential. Contact the National Domestic Violence Hotline at 1-800-799-SAFE (7233) to find services near you.',
    url: 'https://www.acf.hhs.gov/fysb/programs/family-violence-prevention-services',
    applicant_types: ['individual', 'family'],
    categories: ['safety', 'family_support', 'housing'],
    type: 'program',
    fundingType: 'direct_benefit',
    intentMatch: ['domestic_violence', 'family', 'safety', 'shelter'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: false,
    eligibility: {
      incomeLimit: 'None — open to all survivors of domestic violence',
      note: 'Services are free and confidential; children are typically welcome; hotline: 1-800-799-7233',
    },
  },

  {
    id: 'family-211-helpline',
    name: '211 Family Helpline — Emergency Referrals & Local Resources',
    description: 'Free, confidential information and referral service connecting families to local health and human services. Dial or text 2-1-1 to reach a trained specialist who can connect you to food banks, housing assistance, utility help, childcare, health care, crisis counseling, and more. Available 24/7 in most areas. Also searchable online at 211.org. Serves families in crisis and those with ongoing needs regardless of income.',
    url: 'https://www.211.org',
    applicant_types: ['individual', 'family'],
    categories: ['emergency', 'family_support', 'referral'],
    type: 'referral',
    fundingType: 'referral_service',
    intentMatch: ['family', 'crisis', 'emergency', 'referral'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'national',
    recurring: true,
    eligibility: {
      incomeLimit: 'None — open to everyone',
      note: 'Free and confidential; available by phone (dial 211), text, or online; available 24/7 in most regions',
    },
  },

  // ════════════════════════════════════════
  // FOSTER CARE, ADOPTION & KINSHIP CARE
  // ════════════════════════════════════════
  {
    id: 'family-adoption-assistance-iv-e',
    name: 'Adoption Assistance Program (Title IV-E)',
    description: 'Federal program providing ongoing financial and medical assistance to families who adopt children with special needs from foster care. Adoption assistance payments help offset the costs of caring for a child with physical, mental, emotional, or developmental challenges. Eligible adoptive families receive monthly maintenance payments and Medicaid coverage for the child. Amount varies by state and child\'s needs; contact your state child welfare agency.',
    url: 'https://www.childwelfare.gov/topics/adoption/adopt-assistance/',
    applicant_types: ['individual', 'family'],
    categories: ['family_support', 'financial_assistance'],
    type: 'benefit',
    fundingType: 'direct_benefit',
    intentMatch: ['adoption', 'adoptive_parent', 'foster_parent', 'family'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: true,
    eligibility: {
      incomeLimit: 'No income limit for the family; child must meet special needs criteria',
      note: 'Child must have been in foster care and meet the state\'s "special needs" definition; negotiated with your state child welfare agency prior to finalization',
    },
  },

  {
    id: 'family-foster-kinship-iv-e',
    name: 'Foster Care & Kinship Care Support (Title IV-E)',
    description: 'Federal funding supporting foster parents and kinship caregivers who provide safe, stable homes for children removed from unsafe environments. Title IV-E funds foster care maintenance payments, Medicaid coverage for foster children, training for foster parents, and support services. Kinship caregivers (relatives caring for children) may also qualify. Contact your state\'s child welfare agency or local Department of Children and Families to become a licensed foster or kinship caregiver.',
    url: 'https://www.childwelfare.gov/topics/foster-care/',
    applicant_types: ['individual', 'family'],
    categories: ['family_support', 'financial_assistance'],
    type: 'program',
    fundingType: 'direct_benefit',
    intentMatch: ['foster_care', 'kinship_care', 'family', 'children'],
    isGrant: false,
    isProgram: true,
    is_active: true,
    source: 'federal',
    recurring: true,
    eligibility: {
      incomeLimit: 'No income limit; must be licensed or approved foster/kinship caregiver',
      note: 'Must work with your state or county child welfare agency; foster care reimbursement rates vary by state',
    },
  },

];
