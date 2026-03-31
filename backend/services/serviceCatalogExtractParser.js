import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function repoRootFromHere() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.resolve(__dirname, '..', '..')
}

export function getCanonicalServiceCatalogExtractPath() {
  return path.join(repoRootFromHere(), 'docs', 'Payment_sheet_Grantflow_2025-11-13_EXTRACT.md')
}

function normalizeSlug(value) {
  return String(value || '')
    .trim()
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
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid_price:${raw}`)
  return Math.round(n * 100)
}

export function parsePaymentSheetExtract(markdown) {
  const text = String(markdown || '')
  if (!text.trim()) throw new Error('extract_empty')

  const version = '2025-11-13'

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
      // cents will throw if invalid, no need to check null

      if (label === 'flat') {
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

  // Validate expected set (must not silently drop)
  const expectedNames = new Set([
    'Quick Eligibility Scan',
    'Comprehensive Funding Dossier',
    'Application Strategy Session',
    'Micro-Grant Application (<$5K)',
    'Standard Foundation Application ($5K–$250K)',
    'Complex/Federal Application ($250K+)',
    'Transfer Scholarship Pack (flat pricing)',
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
    console.error(`Service catalog extract not found: ${p}`)
    throw new Error(`extract_not_found:${p}`)
  }
  return fs.readFileSync(p, 'utf8')
}

