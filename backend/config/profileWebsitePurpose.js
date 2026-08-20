/**
 * profileWebsitePurpose.js — derive what a profile IS from its own website URL
 * (and any stored website text), then refuse opportunities locked to unrelated
 * purposes.
 *
 * OWNER RULE (2026-08-20): GrantFlow must look at the profile's URL to see what
 * the profile is. Axiom BioLabs (axiombiolabs.org) is CAR-T / transplant /
 * genomics / diagnostics — not Title X, CACFP food programs, law-enforcement
 * wellness, Alzheimer's state respite, specialty crops, or fishing safety.
 * Those rows were filling Hamilton's "Working on now" queue (87 items) while
 * almost none matched the lab.
 *
 * MISSING = NEUTRAL: no website URL / no readable purpose → this gate says
 * nothing. Silence never invents a denial.
 *
 * The matchEngine remains the sole decision authority; this module only names
 * a conflict or null.
 */

import { hostnameOf } from './opportunityJurisdiction.js'

const URL_FIELDS = Object.freeze([
  ['basic_information', 'website'],
  ['organization_details', 'website'],
  ['organization_details', 'website_url'],
  ['small_business_details', 'website'],
])

const TEXT_FIELDS = Object.freeze([
  ['organization_details', 'website_excerpt'],
  ['organization_details', 'website_about'],
  ['organization_details', 'about'],
  ['organization_details', 'mission'],
  ['programs_services', 'description'],
  ['narrative', 'organization_overview'],
])

function obj(v) {
  if (!v) return {}
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v)
      return p && typeof p === 'object' ? p : {}
    } catch {
      return {}
    }
  }
  return typeof v === 'object' ? v : {}
}

function asStr(v) {
  return String(v ?? '').trim()
}

/** Normalize a bare or https website into an https URL, or null. */
export function normalizeWebsiteUrl(raw) {
  const s = asStr(raw)
  if (!s) return null
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`
    const u = new URL(withProto)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname || u.hostname === 'localhost') return null
    return u.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/**
 * Resolve the profile's public website from sections / profile row / org row.
 * Prefers basic_information.website, then organization_details, then email domain.
 */
export function resolveProfileWebsiteUrl({ profile = null, sections = {}, organization = null } = {}) {
  const s = sections || {}
  for (const [sectionKey, field] of URL_FIELDS) {
    const url = normalizeWebsiteUrl(obj(s[sectionKey])[field])
    if (url) return url
  }
  for (const key of ['website', 'website_url', 'url', 'homepage']) {
    const url = normalizeWebsiteUrl(profile?.[key] || organization?.[key])
    if (url) return url
  }
  const email = asStr(
    obj(s.basic_information).email
    || profile?.email
    || organization?.email,
  )
  const at = email.indexOf('@')
  if (at > 0) {
    const domain = email.slice(at + 1).toLowerCase()
    if (domain && !/^(gmail|yahoo|hotmail|outlook|icloud|aol|protonmail|live|msn)\./i.test(domain)
        && !/^(gmail|yahoo|hotmail|outlook|icloud|aol|proton)\.com$/i.test(domain)) {
      return normalizeWebsiteUrl(domain)
    }
  }
  return null
}

/** Collect stored website / about / mission prose for purpose mining. */
export function collectWebsitePurposeText({ sections = {}, organization = null, extraText = '' } = {}) {
  const parts = []
  const s = sections || {}
  for (const [sectionKey, field] of TEXT_FIELDS) {
    const v = asStr(obj(s[sectionKey])[field])
    if (v) parts.push(v)
  }
  if (organization?.mission) parts.push(asStr(organization.mission))
  if (organization?.website_excerpt) parts.push(asStr(organization.website_excerpt))
  if (extraText) parts.push(asStr(extraText))
  return parts.filter(Boolean).join('\n')
}

/**
 * Multi-word purpose phrases mined from website prose / host. These feed
 * derived interest terms (query breadth) AND the conflict gate.
 */
export const WEBSITE_PURPOSE_PHRASE_RX = Object.freeze([
  { term: 'car-t transplant', rx: /\bcar[- ]?t\b.{0,40}\btransplant|\btransplant\b.{0,40}\bcar[- ]?t\b/i },
  { term: 'immune tolerance', rx: /\bimmune tolerance\b|\bdonor[- ]specific tolerance\b/i },
  { term: 'cell therapy', rx: /\bcell therap(?:y|ies)\b|\bcar[- ]?treg\b|\bfoxp3\b/i },
  { term: 'solid organ transplant', rx: /\bsolid organ\b|\borgan transplantation\b/i },
  { term: 'cancer immunotherapy', rx: /\bcancer\b.{0,30}\b(?:immunotherapy|cell therapy)|\bimmuno[- ]?oncology\b/i },
  { term: 'autoimmune research', rx: /\bautoimmune\b/i },
  { term: 'genomic diagnostics', rx: /\bgenomic(?:s)?\b|\bmolecular diagnostics?\b|\bcrispr\b/i },
  { term: 'biomedical research', rx: /\bbiomedical\b|\btranslational research\b|\blife sciences?\b/i },
  { term: 'biotechnology research', rx: /\bbiotech(?:nology)?\b|\bbiopharma(?:ceutical)?\b/i },
  { term: 'environmental dna testing', rx: /\benvironmental (?:testing|dna)\b|\bfood authentication\b/i },
])

/** Hosts whose public site already states a known research purpose (verified live). */
export const KNOWN_WEBSITE_PURPOSE_BY_HOST = Object.freeze({
  'axiombiolabs.org': Object.freeze([
    'car-t transplant',
    'immune tolerance',
    'cell therapy',
    'solid organ transplant',
    'genomic diagnostics',
    'biomedical research',
    'biotechnology research',
  ]),
})

const RESEARCH_PURPOSE_RX = /\b(car-t transplant|immune tolerance|cell therapy|solid organ transplant|cancer immunotherapy|autoimmune research|genomic diagnostics|biomedical research|biotechnology research|environmental dna testing)\b/i

/**
 * Opportunity identity locks that are exclusive to a DIFFERENT purpose class
 * than a biotech / translational research lab. Title + funder only.
 */
export const UNRELATED_PURPOSE_LOCKS = Object.freeze([
  { key: 'cacfp_child_adult_food', rx: /\bcacfp\b|\bchild and adult care food\b|\bfood program integrity\b/i },
  { key: 'title_x_family_planning', rx: /\btitle x\b|\bfamily planning services\b/i },
  { key: 'law_enforcement_wellness', rx: /\blaw enforcement mental health\b|\blemhwa\b/i },
  { key: 'alzheimers_state_program', rx: /\balzheimer'?s disease programs?\b|\bdementia specific respite\b|\badpi\b/i },
  { key: 'outdoor_recreation', rx: /\boutdoor recreation legacy\b|\breadiness and recreation\b|\borlp\b/i },
  { key: 'healthy_homes_housing', rx: /\bhealthy homes\b|\blead[- ]safe\b|\bpro housing\b|\bpathways to removing obstacles to housing\b/i },
  { key: 'kinship_grandfamilies', rx: /\bkinship and grandfamilies\b/i },
  { key: 'mine_safety_state', rx: /\bmine health and safety state\b/i },
  { key: 'specialty_crop_ag', rx: /\bspecialty crop\b|\bemerging markets program\b|\bfdpir\b|\bfood for peace\b|\bagriculture and food research initiative\b|\brcpp\b|\brural cooperative development\b/i },
  { key: 'commercial_fishing', rx: /\bcommercial fishing occupational\b/i },
  { key: 'coral_reef', rx: /\bcoral reef conservation\b/i },
  { key: 'great_lakes_wildlife', rx: /\baquatic invasive species\b|\bgreat lakes fish and wildlife\b/i },
  { key: 'falls_prevention', rx: /\bfalls prevention programs?\b/i },
  { key: 'mass_violence_center', rx: /\bnational mass violence center\b/i },
  { key: 'model_systems_data_center', rx: /\bmodel systems national data\b/i },
  { key: 'homeschool_compassion', rx: /\bhslda\b|\bhomeschool families\b/i },
  { key: 'pesticide_desiccation', rx: /\balternatives to conventional pesticides\b|\bcrop desiccation\b/i },
  { key: 'vet_lirn_capacity', rx: /\bvet[- ]?lirn\b/i },
  { key: 'information_collection_notice', rx: /\binformation collection (?:activities|request)\b|\bpublic comment request\b|\bsolicitation of input from stakeholder\b|\bnotice of availability\b/i },
  { key: 'faa_aviation', rx: /\bfaa aviation research\b/i },
  { key: 'nuclear_isotopes', rx: /\brecycled nuclear isotopes\b|\bhornig\b/i },
  { key: 'able_accounts', rx: /\bable accounts\b/i },
  { key: 'combustion_fire', rx: /\bcombustion and fire systems\b/i },
  { key: 'aerospace_pacer', rx: /\bpioneering aerospace\b|\bpacer\b/i },
  { key: 'delta_rural_network', rx: /\bdelta states rural development\b/i },
  { key: 'eda_planning_local', rx: /\beda planning and local technical assistance\b/i },
  { key: 'atmospheric_facilities', rx: /\bfacilities for atmospheric research\b/i },
  { key: 'infrastructure_systems_people', rx: /\binfrastructure systems and people\b/i },
  { key: 'public_health_crisis_coop', rx: /\bpublic health crisis response cooperative\b/i },
  { key: 'rrtc_community_living', rx: /\brehabilitation research and training center\b|\brrtc\b.{0,40}\bcommunity living\b/i },
  { key: 'nrl_long_range_baa', rx: /\bnrl long range broad agency\b/i },
  { key: 'next_ai_hubs', rx: /\bnovel experiential technologies\b|\bnext ai hubs\b/i },
  { key: 'growing_research_access_economic', rx: /\bgrowing research access for nationally transformative economic\b/i },
  { key: 'environmental_sustainability_nsf', rx: /^environmental sustainability$/i },
  { key: 'formation_of_engineers', rx: /\bresearch in the formation of engineers\b/i },
  { key: 'particulate_multiphase', rx: /\bparticulate and multiphase processes\b/i },
  { key: 'genesis_mission_ai', rx: /\bgenesis mission\b/i },
  { key: 'info_referral_support_center', rx: /\bnational information and referral support center\b/i },
  { key: 'science_of_organizations', rx: /\bscience of organizations\b/i },
  { key: 'counter_wmd', rx: /\bcounter weapons of mass destruction\b/i },
  { key: 'cheers_human_enabling', rx: /\bcontinuing human enabling enhancing restoring\b/i },
  { key: 'oral_systemic_behaviors', rx: /\boral[- ]systemic health\b/i },
  { key: 'psychiatric_first_in_human', rx: /\bfirst in human.{0,40}\bpsychiatric\b|\bpsychiatric disorders\b/i },
  { key: 'substance_use_overdose', rx: /\bsubstance use disorders and overdose\b/i },
  { key: 'nidcr_observational', rx: /\bnidcr prospective observational\b/i },
  { key: 'ncmrr_early_career', rx: /\bncmrr early career\b/i },
  { key: 'women_children_network', rx: /\bwomen, children, pregnant and lactating\b|\bleveraging network infrastructure to conduct innovative research for women\b/i },
  { key: 'shared_instrumentation_sig', rx: /\bshared instrumentation grant\b|\b\(s10 clinical trial not allowed\)\b/i },
  { key: 'limited_comp_k_award', rx: /\blimited competition: small grant program for (?:mentored research|nhlbi)\b/i },
  { key: 'modern_equipment_shared_facilities', rx: /\bmodern equipment for shared-use biomedical\b|\b\(s15 clinical trial not allowed\)\b/i },
  { key: 'brain_initiative_resource', rx: /\bbrain initiative: research resource grants\b/i },
  { key: 'biotech_exporter_farmers', rx: /\benhancing biotechnology market opportunities for u\.?s\.? exporters\b/i },
  { key: 'usda_nutrition_education', rx: /\bfdpir nutrition education\b/i },
])

/** Identity phrases that ARE on-mission for a biotech / translational lab.
 *  Deliberately NARROW — bare "NIH" / "biomedical" alone would keep every
 *  institutional S10/S15/Title-adjacent NOFO that merely shares a word. */
export const RESEARCH_ALIGNED_LOCK_RX = Object.freeze([
  /\bsbir\b/i,
  /\bsttr\b/i,
  /\bsmall business technology transfer\b/i,
  /\bcommercialization readiness\b/i,
  /\bcar[- ]?t\b/i,
  /\bcell therap/i,
  /\bimmune tolerance\b/i,
  /\btransplant immune\b/i,
  /\bgenomic/i,
  /\bcrispr\b/i,
  /\bpeer reviewed medical\b/i,
  /\bcatalyze\b.{0,80}\b(?:biologics?|product definition|small molecules)\b/i,
  /\b(?:biologics?|small molecules).{0,80}\bcatalyze\b/i,
  /\bextramural medical research\b/i,
  /\bengineering (?:of )?biomedical systems\b/i,
  /\bengineering biological and biomedical systems\b/i,
  /\bblueprint neurotherapeutics\b/i,
  /\bignite\b.{0,40}\bneurotherapeutic\b/i,
  /\btechnology\/therapeutic development award\b/i,
])

export function extractPurposeTermsFromText(text) {
  const blob = asStr(text)
  if (!blob) return []
  const out = []
  const seen = new Set()
  for (const entry of WEBSITE_PURPOSE_PHRASE_RX) {
    if (!entry.rx.test(blob)) continue
    if (seen.has(entry.term)) continue
    seen.add(entry.term)
    out.push(entry.term)
  }
  return out
}

export function purposeTermsForHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  if (!host) return []
  if (KNOWN_WEBSITE_PURPOSE_BY_HOST[host]) return [...KNOWN_WEBSITE_PURPOSE_BY_HOST[host]]
  const bare = host.replace(/^www\./, '')
  if (KNOWN_WEBSITE_PURPOSE_BY_HOST[bare]) return [...KNOWN_WEBSITE_PURPOSE_BY_HOST[bare]]
  if (KNOWN_WEBSITE_PURPOSE_BY_HOST[`www.${bare}`]) {
    return [...KNOWN_WEBSITE_PURPOSE_BY_HOST[`www.${bare}`]]
  }
  return []
}

/**
 * Derive purpose terms from the profile website URL + any stored website text.
 * Returns { url, host, terms, evidence, isResearchPurpose }.
 */
export function deriveWebsitePurpose({ profile = null, sections = {}, organization = null, extraText = '' } = {}) {
  const url = resolveProfileWebsiteUrl({ profile, sections, organization })
  const text = collectWebsitePurposeText({ sections, organization, extraText })
  const host = url ? hostnameOf(url) : null
  const fromHost = purposeTermsForHost(host)
  const fromText = extractPurposeTermsFromText(`${text}\n${url || ''}`)
  const terms = [...new Set([...fromHost, ...fromText])]
  const evidence = []
  if (url) evidence.push('profile.website_url')
  if (fromHost.length) evidence.push(`known_host:${host}`)
  if (fromText.length) evidence.push('website_or_mission_text')
  return Object.freeze({
    url,
    host,
    terms: Object.freeze(terms),
    evidence: Object.freeze(evidence),
    isResearchPurpose: terms.some((t) => RESEARCH_PURPOSE_RX.test(t)),
  })
}

function opportunityIdentity(row = {}) {
  return [row.title, row.funder, row.sponsor]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ')
}

export function opportunityHasResearchAlignedIdentity(row = {}) {
  const identity = opportunityIdentity(row)
  if (!identity.trim()) return false
  return RESEARCH_ALIGNED_LOCK_RX.some((rx) => rx.test(identity))
}

export function detectUnrelatedPurposeLock(row = {}) {
  const identity = opportunityIdentity(row)
  if (!identity.trim()) return null
  for (const entry of UNRELATED_PURPOSE_LOCKS) {
    if (entry.rx.test(identity)) return entry.key
  }
  return null
}

/**
 * Conflict when a research-purpose profile (from its website) faces an
 * opportunity locked to an unrelated exclusive purpose class.
 * @returns {{ reason: string, lock: string } | null}
 */
export function websitePurposeConflict({ purpose = null, opportunity = null } = {}) {
  if (!purpose?.isResearchPurpose) return null
  if (!opportunity || typeof opportunity !== 'object') return null
  if (opportunityHasResearchAlignedIdentity(opportunity)) return null
  const lock = detectUnrelatedPurposeLock(opportunity)
  if (!lock) return null
  return {
    lock,
    reason:
      `Website purpose mismatch: this profile's site describes biomedical / `
      + `translational research (${(purpose.terms || []).slice(0, 4).join(', ') || 'research'}), `
      + `but this opportunity is locked to unrelated purpose "${lock}"`,
  }
}

/**
 * Score a list of opportunity titles for a purpose object — used by audits /
 * owner reports. Returns { matched, rejected, plausible }.
 */
export function classifyOpportunitiesAgainstWebsitePurpose(purpose, opportunities = []) {
  const matched = []
  const rejected = []
  const plausible = []
  for (const opp of opportunities) {
    const row = typeof opp === 'string' ? { title: opp } : opp
    const conflict = websitePurposeConflict({ purpose, opportunity: row })
    if (conflict) {
      rejected.push({ title: row.title, lock: conflict.lock })
      continue
    }
    if (opportunityHasResearchAlignedIdentity(row)) {
      matched.push({ title: row.title })
      continue
    }
    plausible.push({ title: row.title })
  }
  return { matched, rejected, plausible }
}
