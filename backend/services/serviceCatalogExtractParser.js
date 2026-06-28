import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../utils/logger.js'
const qualityLog = createLogger('services:serviceCatalogExtractParser')

function repoRootFromHere() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.resolve(__dirname, '..', '..')
}

// Canonical extract version. Bump this in lock-step with
// `PRICING_CATALOG_VERSION` in `pricing/pricingTypes.js`.
export const CANONICAL_EXTRACT_VERSION = '2026-06-15'
export const CANONICAL_EXTRACT_FILENAME = `Payment_sheet_Grantflow_${CANONICAL_EXTRACT_VERSION}_EXTRACT.md`
// Older extracts are kept on disk for archival/forensic use only — they
// must not seed the live catalog.
export const LEGACY_EXTRACT_FILENAMES = Object.freeze([
  'Payment_sheet_Grantflow_2025-11-13_EXTRACT.md',
])

export function getCanonicalServiceCatalogExtractPath() {
  return path.join(repoRootFromHere(), 'docs', CANONICAL_EXTRACT_FILENAME)
}

function stripDisplayQualifiers(title) {
  // Strip parenthetical price/qualifier clauses (e.g. "(<$5K)" or "($5K-$250K)")
  // from titles before computing the canonical slug. The full title is still
  // stored as the display name; only the slug ignores the qualifier.
  return String(title || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim()
}

function normalizeSlug(value) {
  return stripDisplayQualifiers(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function parseMoneyToCents(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  // Accept: $1,250 or $85/hr
  const cleaned = s
    .replace(/\*\*/g, '')
    .replace(/\/hr\b/i, '')
    .replace(/\$/g, '')
    .replace(/,/g, '')
    .trim()
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[serviceCatalogExtractParser] invalid_price skipped: ${raw}`)
    return null
  }
  return Math.round(n * 100)
}

export function parsePaymentSheetExtract(markdown) {
  const text = String(markdown || '')
  if (!text.trim()) throw new Error('extract_empty')

  // Active GrantFlow pricing catalog. Drift from `PRICING_CATALOG_VERSION`
  // is treated as a Sam-critical finding (`stale_catalog`).
  const version = CANONICAL_EXTRACT_VERSION

  const serviceSectionHeadings = new Map([
    ['Service Catalog (Discovery & Assessment Services)', 'Discovery & Assessment Services'],
    ['Service Catalog (Grant Writing & Application Services)', 'Grant Writing & Application Services'],
    ['Service Catalog (Support & Compliance Services)', 'Support & Compliance Services'],
    ['Service Catalog (Hourly Services)', 'Hourly Services'],
  ])

  const lines = text.split(/\r?\n/)

  const services = []
  let currentCategory = null
  let currentService = null
  let currentDescLines = []

  function flushCurrent() {
    if (!currentService) return
    const description = currentDescLines
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    const next = {
      slug: normalizeSlug(currentService.title),
      name: currentService.title,
      description,
      category: currentCategory,
      prices: currentService.prices,
      pricing_model: currentService.pricing_model,
    }
    services.push(next)
    currentService = null
    currentDescLines = []
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const h2 = line.match(/^##\s+(.*)\s*$/)
    if (h2) {
      const label = h2[1].trim()
      if (serviceSectionHeadings.has(label)) {
        flushCurrent()
        currentCategory = serviceSectionHeadings.get(label)
      }
      continue
    }

    const h3 = line.match(/^###\s+(.*)\s*$/)
    if (h3 && currentCategory) {
      flushCurrent()
      const title = h3[1].trim()
      currentService = {
        title,
        prices: {},
        pricing_model: 'one_time',
      }
      if (currentCategory === 'Hourly Services') currentService.pricing_model = 'hourly'
      continue
    }

    if (!currentService) continue

    // Price bullets:
    // - Individual: **$149**
    // - Flat: **$450** (all categories)
    const priceMatch = line.match(/^-\s*(Individual|Small|Mid-Size|Large|Flat)\s*:\s*\*\*\s*(\$\s*[^*]+)\s*\*\*/i)
    if (priceMatch) {
      const label = priceMatch[1].toLowerCase()
      const amountRaw = priceMatch[2]
      const cents = parseMoneyToCents(amountRaw)
      if (cents === null) {
        console.warn(
          `[serviceCatalogExtractParser] skipping price tier '${label}' for '${currentService.title}' â could not parse: ${amountRaw}`
        )
      } else if (label === 'flat') {
        currentService.prices = {
          individual: cents,
          small: cents,
          mid: cents,
          large: cents,
        }
      } else if (label === 'individual') {
        currentService.prices.individual = cents
      } else if (label === 'small') {
        currentService.prices.small = cents
      } else if (label === 'mid-size') {
        currentService.prices.mid = cents
      } else if (label === 'large') {
        currentService.prices.large = cents
      }
      continue
    }

    // Description lines (non-empty, non-bullets)
    const trimmed = String(line || '').trim()
    if (!trimmed) continue
    if (trimmed.startsWith('- ')) continue
    if (trimmed.startsWith('---')) continue
    if (/^Rules:\s*$/i.test(trimmed)) continue
    currentDescLines.push(trimmed)
  }

  flushCurrent()

  // Validate expected set (must not silently drop). These are the canonical
  // service titles for the 2026-06-15 catalog. The "Micro-Grant Application
  // (<$5K)" parenthetical is intentional — it identifies the service tier
  // and survives slug normalization to `micro-grant-application`.
  const expectedNames = new Set([
    'Quick Eligibility Scan',
    'Comprehensive Funding Dossier',
    'Application Strategy Session',
    'Micro-Grant Application (<$5K)',
    'Standard Foundation Application',
    'Complex/Federal Application',
    'Transfer Scholarship Pack',
    'Editing & Redraft Service',
    'Budget & Logic Model Development',
    'Compliance Reporting & Management',
    'Grant Calendar Setup & Management',
    'Hourly Consultation & Advisory',
  ])
  const gotNames = new Set(services.map((s) => s.name))
  for (const n of expectedNames) {
    if (!gotNames.has(n)) {
      throw new Error(`extract_missing_service:${n}`)
    }
  }

  // Terms: store everything from "IMPORTANT NOTE" onward (human-readable, canonical)
  const idx = text.indexOf('## IMPORTANT NOTE')
  const fullText = idx >= 0 ? text.slice(idx).trim() : text.trim()
  const policySnippet = [
    'Milestone-based payments: 40% kickoff, 40% draft delivery, 20% submission/handoff.',
    'Standard terms: Net 15. Late fees: 1.5% monthly interest.',
    'Hourly: 15-minute minimum, billed in 6-minute increments.',
  ].join(' ')

  return {
    version,
    services,
    terms: {
      version,
      policy_snippet: policySnippet,
      full_text: fullText,
    },
  }
}

export function loadPaymentSheetExtractFromDisk() {
  const p = getCanonicalServiceCatalogExtractPath()
  if (!fs.existsSync(p)) {
    qualityLog.error(`Service catalog extract not found: ${p}`)
    throw new Error(`extract_not_found:${p}`)
  }
  return fs.readFileSync(p, 'utf8')
}

