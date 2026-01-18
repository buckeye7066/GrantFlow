/**
 * Item-Specific Funding Crawler
 * Finds funding for specific items like vehicles, equipment, or supplies
 * Matches both the item request AND profile criteria
 */

import axios from 'axios'
import * as cheerio from 'cheerio'
import { buildProfileSignals } from '../profileHelpers.js'

const ITEM_FUNDING_SOURCES = [
  {
    name: 'Vehicles for Change',
    baseUrl: 'https://www.vehiclesforchange.org',
    itemTypes: ['vehicle', 'van', 'car', 'truck'],
    type: 'vehicle_donation'
  },
  {
    name: 'Good360',
    baseUrl: 'https://good360.org',
    itemTypes: ['equipment', 'supplies', 'furniture', 'technology'],
    type: 'product_donation'
  },
  {
    name: 'TechSoup',
    baseUrl: 'https://www.techsoup.org',
    itemTypes: ['software', 'hardware', 'technology', 'computers'],
    type: 'tech_donation'
  },
  {
    name: 'GrantWatch Equipment Grants',
    baseUrl: 'https://www.grantwatch.com/cat/3/equipment-grants.html',
    itemTypes: ['equipment', 'machinery', 'tools'],
    type: 'equipment_grant'
  }
]

export async function crawlItemFunding(profile, options = {}) {
  const results = []
  const itemRequest = options.item_request
  
  if (!itemRequest) {
    console.log('[ItemFundingCrawler] No item request specified')
    return results
  }
  
  console.log(`[ItemFundingCrawler] Searching for funding for: ${itemRequest}`)
  console.log(`[ItemFundingCrawler] Profile: ${profile.display_name || profile.name}`)
  
  // Parse the item request
  const itemInfo = parseItemRequest(itemRequest)
  console.log(`[ItemFundingCrawler] Parsed item type: ${itemInfo.type}, quantity: ${itemInfo.quantity}`)
  
  // Find relevant sources for this item type
  const relevantSources = ITEM_FUNDING_SOURCES.filter(source =>
    source.itemTypes.some(type => 
      itemInfo.type.toLowerCase().includes(type) ||
      type.includes(itemInfo.type.toLowerCase())
    )
  )
  
  console.log(`[ItemFundingCrawler] Found ${relevantSources.length} relevant sources`)
  
  // IMPORTANT:
  // We do NOT fabricate opportunities here. Each returned record must map to a real, clickable URL.
  // Deeper per-source scraping can be added incrementally without ever returning placeholders.
  for (const source of relevantSources) {
    try {
      const opportunities = await buildItemSourceLinks(source, itemInfo, profile)
      
      for (const opp of opportunities) {
        if (isLoan(opp)) continue
        
        results.push({
          ...opp,
          crawler_type: 'item_funding',
          item_requested: itemRequest,
          source: source.name,
        })
      }
    } catch (error) {
      console.error(`[ItemFundingCrawler] Error searching ${source.name}:`, error.message)
    }
  }
  
  console.log(`[ItemFundingCrawler] Found ${results.length} real item funding sources (links)`)
  return results
}

function parseItemRequest(request) {
  const info = {
    type: '',
    quantity: 1,
    purpose: '',
    specifications: []
  }
  
  // Extract quantity
  const quantityMatch = request.match(/(\d+)\s*(passenger|seat|person|item|unit)/i)
  if (quantityMatch) {
    info.quantity = parseInt(quantityMatch[1])
  }
  
  // Identify item type
  const vehicleKeywords = ['van', 'bus', 'vehicle', 'car', 'truck', 'automobile']
  const techKeywords = ['computer', 'laptop', 'software', 'printer', 'technology']
  const equipmentKeywords = ['equipment', 'machine', 'tool', 'device', 'appliance']
  const furnitureKeywords = ['furniture', 'desk', 'chair', 'table', 'cabinet']
  
  const lowerRequest = request.toLowerCase()
  
  if (vehicleKeywords.some(keyword => lowerRequest.includes(keyword))) {
    info.type = 'vehicle'
    if (lowerRequest.includes('15 passenger') || lowerRequest.includes('15-passenger')) {
      info.specifications.push('15-passenger')
    }
  } else if (techKeywords.some(keyword => lowerRequest.includes(keyword))) {
    info.type = 'technology'
  } else if (equipmentKeywords.some(keyword => lowerRequest.includes(keyword))) {
    info.type = 'equipment'
  } else if (furnitureKeywords.some(keyword => lowerRequest.includes(keyword))) {
    info.type = 'furniture'
  } else {
    info.type = 'general'
  }
  
  // Extract purpose
  if (lowerRequest.includes('mission')) {
    info.purpose = 'mission'
  } else if (lowerRequest.includes('transport')) {
    info.purpose = 'transportation'
  } else if (lowerRequest.includes('education')) {
    info.purpose = 'education'
  }
  
  return info
}

async function buildItemSourceLinks(source, itemInfo, profile) {
  const opportunities = []
  const itemTokens = Array.isArray(itemInfo?.specifications) ? itemInfo.specifications : []

  const base = {
    sponsor: source.name,
    url: source.baseUrl,
    source_url: source.baseUrl,
    application_url: source.baseUrl,
    deadline: null,
    deadline_type: 'rolling',
    is_national: true,
    state: null,
    opportunity_type: 'program',
  }

  switch (source.type) {
    case 'vehicle_donation': {
      opportunities.push({
        ...base,
        title: `${source.name} — Vehicle assistance / donation programs`,
        description:
          'Vehicle assistance and related programs (see website for eligibility and local coverage).',
        keywords: ['vehicle', 'transportation', ...itemTokens],
        categories: ['vehicle', 'transportation'],
        eligibility: 'Varies by program and location; see source site.',
      })
      break
    }
    case 'product_donation': {
      opportunities.push({
        ...base,
        title: `${source.name} — Product philanthropy / donated goods`,
        description:
          'Donated goods and product philanthropy programs (see website for nonprofit eligibility requirements).',
        keywords: ['equipment', 'supplies', 'donation', ...itemTokens],
        categories: ['equipment', 'supplies'],
        eligibility: 'Typically nonprofit-focused; see source site.',
      })
      break
    }
    case 'tech_donation': {
      opportunities.push({
        ...base,
        title: `${source.name} — Discounted and donated technology`,
        description:
          'Discounted/donated technology and services (see website for eligibility and catalog).',
        keywords: ['technology', 'software', 'hardware', 'computers', ...itemTokens],
        categories: ['technology'],
        eligibility: 'Typically nonprofit-focused; see source site.',
      })
      break
    }
    case 'equipment_grant': {
      opportunities.push({
        ...base,
        title: `${source.name} — Equipment grant listings`,
        description:
          'Curated equipment-grant listings. Availability and access may vary; verify directly via listing links.',
        keywords: ['equipment', 'grants', ...itemTokens],
        categories: ['equipment', 'grants'],
        eligibility: 'Varies by listing; verify directly.',
      })
      break
    }
    default: {
      // Unknown source type: return nothing rather than fabricate.
      break
    }
  }

  return opportunities
}

function calculateItemMatchScore(opportunity, itemInfo, profile) {
  let score = 50 // Base score for item funding

  const signals =
    profile?.signals ??
    buildProfileSignals({
      profile,
      sections: profile?.sections ?? {},
    })
  
  // Item type match (critical - 30 points)
  const oppCategories = opportunity.item_categories || []
  if (oppCategories.some(cat => cat.toLowerCase().includes(itemInfo.type.toLowerCase()))) {
    score += 30
  } else if (itemInfo.type === 'general' && oppCategories.includes('general')) {
    score += 20
  } else {
    // If item type doesn't match, unlikely to be good fit
    return 0
  }
  
  // Profile type match (20 points)
  const eligText = (opportunity.eligibility || '').toLowerCase()
  const profileType =
    (profile.organization_type || profile.profile_type || profile.primary_type || '').toLowerCase()
  
  if (profileType === 'nonprofit' && eligText.includes('nonprofit')) {
    score += 20
  } else if (profileType === 'individual' && eligText.includes('individual')) {
    score += 20
  } else if (!eligText.includes('nonprofit') && !eligText.includes('501c3')) {
    // Generic eligibility
    score += 10
  }
  
  // Purpose alignment (15 points)
  if (itemInfo.purpose && opportunity.description?.toLowerCase().includes(itemInfo.purpose)) {
    score += 15
  }
  
  // Mission alignment for mission-minded orgs (15 points)
  const hasMissionSignal =
    Boolean(profile.mission) ||
    Boolean(profile?.sections?.narrative?.mission) ||
    Boolean(profile?.sections?.organization_details?.mission)
  if (hasMissionSignal && opportunity.title?.toLowerCase().includes('mission')) {
    score += 15
  }

  // Cross-signal alignment (up to +15)
  // Treat *any* profile data point as a potential match signal by leveraging the signals keyword set.
  const oppText = `${opportunity.title || ''} ${opportunity.description || ''} ${opportunity.eligibility || ''}`.toLowerCase()
  const keywordList = Array.from(signals?.keywordSet ?? [])
  let keywordMatches = 0
  for (const kw of keywordList) {
    if (!kw || kw.length < 4) continue
    if (oppText.includes(kw)) {
      keywordMatches += 1
      if (keywordMatches >= 10) break
    }
  }
  if (keywordMatches > 0) {
    score += Math.min(15, keywordMatches * 2)
  }
  
  // Specification match (10 points)
  if (itemInfo.specifications.length > 0) {
    const oppText2 = `${opportunity.title} ${opportunity.description}`.toLowerCase()
    const matchedSpecs = itemInfo.specifications.filter(spec => 
      oppText2.includes(spec.toLowerCase())
    )
    if (matchedSpecs.length > 0) {
      score += 10
    }
  }
  
  // Amount adequacy (10 points)
  // For vehicles, need higher amounts
  if (itemInfo.type === 'vehicle' && opportunity.amount_max >= 20000) {
    score += 10
  } else if (itemInfo.type !== 'vehicle' && opportunity.amount_max >= 5000) {
    score += 10
  }
  
  return Math.min(100, Math.round(score))
}

function isLoan(opportunity) {
  const loanKeywords = ['loan', 'financing', 'lease', 'payment plan', 'interest rate']
  const text = `${opportunity.title} ${opportunity.description}`.toLowerCase()
  return loanKeywords.some(keyword => text.includes(keyword))
}

export default { crawlItemFunding }