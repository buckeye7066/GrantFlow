/**
 * Canonical Need Categories — single source of truth.
 *
 * Each entry maps a canonical need ID to display metadata used by the
 * frontend browse-by-category UI and the backend need taxonomy.
 *
 * `id`    — matches the canonical key in NEED_ALIAS_MAP / NEED_TEXT_PATTERNS
 * `label` — human-readable display name
 * `icon`  — emoji for the browse UI
 * `query` — search keywords sent to the matching endpoint when browsed
 * `group` — UI grouping key (see NEED_CATEGORY_GROUPS)
 */

export const NEED_CATEGORY_GROUPS = [
  { key: 'basic_needs', label: 'Basic Needs' },
  { key: 'health_wellness', label: 'Health & Wellness' },
  { key: 'education_career', label: 'Education & Career' },
  { key: 'population', label: 'Population-Specific' },
  { key: 'organization', label: 'Organization Types' },
  { key: 'specialized', label: 'Specialized' },
]

export const CANONICAL_NEED_CATEGORIES = [
  // ── Basic Needs ──────────────────────────────────────────────────────────
  { id: 'housing',              label: 'Housing & Rent',           icon: '\u{1F3E0}', query: 'housing rent eviction mortgage homeless',              group: 'basic_needs' },
  { id: 'food',                 label: 'Food Assistance',          icon: '\u{1F957}', query: 'food snap nutrition groceries hunger',                 group: 'basic_needs' },
  { id: 'utilities',            label: 'Energy & Utilities',       icon: '\u{26A1}',  query: 'utility energy liheap heating electric water',        group: 'basic_needs' },
  { id: 'green_home',           label: 'No-Cost Green Home Upgrades', icon: '\u{1F3E1}', query: 'no-cost free weatherization insulation air sealing heat pump hvac geothermal solar battery small residential wind direct installation', group: 'basic_needs' },
  { id: 'transportation',       label: 'Transportation',           icon: '\u{1F68C}', query: 'transportation vehicle car transit bus',               group: 'basic_needs' },
  { id: 'clothing_goods',       label: 'Clothing & Household',     icon: '\u{1F45A}', query: 'clothing furniture household goods appliances',        group: 'basic_needs' },
  { id: 'cash_assistance',      label: 'Cash Assistance',          icon: '\u{1F4B5}', query: 'cash assistance financial aid tanf ssi ssdi',          group: 'basic_needs' },
  { id: 'emergency',            label: 'Emergency & Disaster',     icon: '\u{1F6A8}', query: 'emergency crisis disaster fema relief',                group: 'basic_needs' },
  { id: 'legal',                label: 'Legal Services',           icon: '\u{2696}\u{FE0F}',  query: 'legal aid attorney lawyer legal services',            group: 'basic_needs' },

  // ── Health & Wellness ────────────────────────────────────────────────────
  { id: 'health_medical',       label: 'Healthcare & Medical',     icon: '\u{1F48A}', query: 'healthcare medicaid health insurance medical',         group: 'health_wellness' },
  { id: 'mental_health',        label: 'Mental Health',            icon: '\u{1F9E0}', query: 'mental health therapy counseling behavioral',          group: 'health_wellness' },
  { id: 'disability',           label: 'Disability Services',      icon: '\u{267F}',  query: 'disability adaptive assistive technology wheelchair',  group: 'health_wellness' },
  { id: 'substance_recovery',   label: 'Substance Recovery',       icon: '\u{1F49A}', query: 'substance abuse recovery addiction treatment rehab',   group: 'health_wellness' },

  // ── Education & Career ───────────────────────────────────────────────────
  { id: 'education',            label: 'Education & Scholarships', icon: '\u{1F393}', query: 'education scholarship college tuition financial aid',  group: 'education_career' },
  { id: 'employment',           label: 'Job Training & Workforce', icon: '\u{1F6E0}\u{FE0F}', query: 'job training workforce employment career vocational', group: 'education_career' },
  { id: 'technology_equipment', label: 'Technology & Digital',     icon: '\u{1F4BB}', query: 'computer laptop internet broadband digital access',    group: 'education_career' },
  { id: 'business',             label: 'Small Business',           icon: '\u{1F4BC}', query: 'small business grant entrepreneur startup',            group: 'education_career' },

  // ── Population-Specific ──────────────────────────────────────────────────
  { id: 'veteran',              label: 'Veterans & Military',      icon: '\u{1F396}\u{FE0F}', query: 'veteran military armed forces service member',       group: 'population' },
  { id: 'senior',               label: 'Seniors & Aging',          icon: '\u{1F9D3}', query: 'senior elderly aging older adult 65+',                 group: 'population' },
  { id: 'children_youth',       label: 'Children & Youth',         icon: '\u{1F476}', query: 'children youth at-risk youth juvenile young people',   group: 'population' },
  { id: 'family_life',          label: 'Family & Caregivers',      icon: '\u{1F46A}', query: 'family childcare caregiver foster parenting kinship',  group: 'population' },
  { id: 'women',                label: 'Women',                    icon: '\u{1F469}', query: 'women female women-owned domestic violence',           group: 'population' },
  { id: 'minority',             label: 'BIPOC & Minority',         icon: '\u{1F91D}', query: 'minority bipoc african american hispanic latino native',group: 'population' },
  { id: 'immigrant_refugee',    label: 'Immigrants & Refugees',    icon: '\u{1F30D}', query: 'immigrant refugee resettlement asylum asylee',         group: 'population' },
  { id: 'tribal',               label: 'Tribal & Native',          icon: '\u{1F3DC}\u{FE0F}', query: 'tribal native american indigenous indian nation',     group: 'population' },

  // ── Organization Types ───────────────────────────────────────────────────
  { id: 'nonprofit_ministry',   label: 'Nonprofits & Churches',    icon: '\u{26EA}',  query: 'nonprofit church faith-based ministry 501c3',         group: 'organization' },
  { id: 'public_safety',        label: 'Fire & EMS',               icon: '\u{1F692}', query: 'fire department ems volunteer fire first responder',   group: 'organization' },
  { id: 'municipality',         label: 'Municipalities & Govt',    icon: '\u{1F3DB}\u{FE0F}', query: 'municipality county city government local govt',      group: 'organization' },

  // ── Specialized ──────────────────────────────────────────────────────────
  { id: 'research_arts',        label: 'Research & Arts',          icon: '\u{1F3A8}', query: 'research arts artist creative culture scientific',     group: 'specialized' },
  { id: 'environment',          label: 'Environment & Conservation', icon: '\u{1F33F}', query: 'environment conservation climate sustainability',    group: 'specialized' },
  { id: 'agriculture',          label: 'Agriculture & Farming',    icon: '\u{1F33E}', query: 'agriculture farming ranch rural usda',                 group: 'specialized' },
  { id: 'community_development',label: 'Community Development',    icon: '\u{1F3D7}\u{FE0F}', query: 'community development economic revitalization hud',   group: 'specialized' },
  { id: 'rural',                label: 'Rural Communities',        icon: '\u{1F304}', query: 'rural appalachian small town underserved remote',      group: 'specialized' },
]
