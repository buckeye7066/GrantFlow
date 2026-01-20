#!/usr/bin/env node
/**
 * Initialize the GrantFlow database with schema and seed data
 */

import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import crypto from 'crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DB_PATH = join(__dirname, '../seed/grantflow.db')
const SCHEMA_PATH = join(__dirname, '../backend/db/schema.sql')

console.log('🔧 GrantFlow Database Initialization')
console.log('====================================')

// Ensure seed directory exists
const seedDir = dirname(DB_PATH)
if (!existsSync(seedDir)) {
  mkdirSync(seedDir, { recursive: true })
  console.log('✓ Created seed directory')
}

// Open database (creates if not exists)
const db = new Database(DB_PATH)
console.log(`✓ Database opened: ${DB_PATH}`)

// Read and execute schema
console.log('⏳ Applying schema...')
const schema = readFileSync(SCHEMA_PATH, 'utf8')
db.exec(schema)
console.log('✓ Schema applied')

// Check tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
console.log(`✓ Created ${tables.length} tables`)

// Seed baseline profiles if none exist
const profileCount = db.prepare('SELECT COUNT(*) as count FROM profiles').get()
if (profileCount.count === 0) {
  console.log('\n⏳ Seeding baseline profiles...')
  
  const baselineProfiles = [
    {
      id: crypto.randomUUID(),
      display_name: 'Community Health Initiative',
      primary_type: 'nonprofit',
      status: 'active',
      state: 'Ohio',
      organization_type: 'nonprofit',
      categories: JSON.stringify(['healthcare', 'community', 'public health']),
      mission: 'Providing accessible healthcare services to underserved communities',
      serves_veterans: true,
      serves_disabled: true,
    },
    {
      id: crypto.randomUUID(),
      display_name: 'Youth Education Foundation',
      primary_type: 'nonprofit',
      status: 'active',
      state: 'California',
      organization_type: 'nonprofit',
      categories: JSON.stringify(['education', 'youth', 'STEM']),
      mission: 'Empowering youth through educational programs and scholarships',
      serves_veterans: false,
      serves_disabled: false,
    },
    {
      id: crypto.randomUUID(),
      display_name: 'Veterans Support Network',
      primary_type: 'nonprofit',
      status: 'active',
      state: 'Texas',
      organization_type: 'nonprofit',
      categories: JSON.stringify(['veterans', 'housing', 'employment']),
      mission: 'Supporting veterans with housing, employment, and mental health services',
      serves_veterans: true,
      serves_disabled: true,
    },
    {
      id: crypto.randomUUID(),
      display_name: 'Senior Care Alliance',
      primary_type: 'nonprofit',
      status: 'active',
      state: 'Florida',
      organization_type: 'nonprofit',
      categories: JSON.stringify(['seniors', 'healthcare', 'community']),
      mission: 'Providing comprehensive care and support services for seniors',
      serves_veterans: true,
      serves_disabled: true,
    },
    {
      id: crypto.randomUUID(),
      display_name: 'Environmental Conservation Trust',
      primary_type: 'nonprofit',
      status: 'active',
      state: 'Colorado',
      organization_type: 'nonprofit',
      categories: JSON.stringify(['environment', 'conservation', 'sustainability']),
      mission: 'Protecting natural resources through conservation and education',
      serves_veterans: false,
      serves_disabled: false,
    },
  ]
  
  const insertProfile = db.prepare(`
    INSERT INTO profiles (id, display_name, primary_type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)
  
  // Also need to create the extended profile fields - let's add them to profile_sections
  const insertSection = db.prepare(`
    INSERT INTO profile_sections (id, profile_id, section_key, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)
  
  // Also create organizations for each profile
  const insertOrg = db.prepare(`
    INSERT INTO organizations (id, name, state, organization_type, mission, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)
  
  const updateProfileOrg = db.prepare(`
    UPDATE profiles SET organization_id = ? WHERE id = ?
  `)
  
  for (const profile of baselineProfiles) {
    // Create organization first
    const orgId = crypto.randomUUID()
    insertOrg.run(orgId, profile.display_name, profile.state, profile.organization_type, profile.mission)
    
    // Create profile
    insertProfile.run(profile.id, profile.display_name, profile.primary_type, profile.status)
    
    // Link profile to organization
    updateProfileOrg.run(orgId, profile.id)
    
    // Add profile sections with extended data
    const locationSection = {
      state: profile.state,
      city: '',
      zip: '',
    }
    insertSection.run(crypto.randomUUID(), profile.id, 'location', JSON.stringify(locationSection))
    
    const organizationSection = {
      organization_type: profile.organization_type,
      categories: JSON.parse(profile.categories),
      mission: profile.mission,
      serves_veterans: profile.serves_veterans,
      serves_disabled: profile.serves_disabled,
    }
    insertSection.run(crypto.randomUUID(), profile.id, 'organization', JSON.stringify(organizationSection))
  }
  
  console.log(`✓ Created ${baselineProfiles.length} profiles with organizations`)
}

// Seed real funding opportunities
const oppCount = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get()
if (oppCount.count < 50) {
  console.log('\n⏳ Seeding funding opportunities...')
  
  const realOpportunities = [
    // Federal Grants
    {
      title: 'Community Development Block Grant (CDBG)',
      sponsor: 'U.S. Department of Housing and Urban Development',
      source: 'federal',
      description: 'Flexible funding for community development activities',
      eligibility_bullets: JSON.stringify(['State and local governments', 'Nonprofit organizations with 501(c)(3) status']),
      amount_min: 100000,
      amount_max: 5000000,
      deadline_type: 'rolling',
      application_url: 'https://www.hud.gov/program_offices/comm_planning/cdbg',
      is_national: true,
      state: 'nationwide',
      categories: JSON.stringify(['community', 'housing', 'economic development']),
      keywords: JSON.stringify(['community development', 'housing', 'infrastructure']),
      opportunity_type: 'grant',
      requires_501c3: false,
      requires_match: false,
    },
    {
      title: 'Social Services Block Grant (SSBG)',
      sponsor: 'Administration for Children and Families',
      source: 'federal',
      description: 'Funding for social services to help communities achieve self-sufficiency',
      eligibility_bullets: JSON.stringify(['State governments', 'Nonprofit human services organizations']),
      amount_min: 50000,
      amount_max: 2000000,
      deadline_type: 'ongoing',
      application_url: 'https://www.acf.hhs.gov/ocs/programs/ssbg',
      is_national: true,
      state: 'nationwide',
      categories: JSON.stringify(['social services', 'community', 'healthcare']),
      keywords: JSON.stringify(['social services', 'self-sufficiency', 'community support']),
      opportunity_type: 'grant',
      requires_501c3: false,
      requires_match: false,
    },
    {
      title: 'Veterans Affairs Supportive Housing (VASH)',
      sponsor: 'U.S. Department of Veterans Affairs',
      source: 'federal',
      description: 'Housing vouchers and case management for homeless veterans',
      eligibility_bullets: JSON.stringify(['Public housing authorities', 'Veteran service organizations', '501(c)(3) nonprofits serving veterans']),
      amount_min: 25000,
      amount_max: 500000,
      deadline_type: 'rolling',
      application_url: 'https://www.va.gov/homeless/hud-vash.asp',
      is_national: true,
      state: 'nationwide',
      categories: JSON.stringify(['veterans', 'housing', 'homeless services']),
      keywords: JSON.stringify(['veterans', 'housing', 'homeless', 'case management']),
      opportunity_type: 'grant',
      requires_501c3: true,
      requires_match: false,
    },
    {
      title: 'Older Americans Act Title III - Supportive Services',
      sponsor: 'Administration for Community Living',
      source: 'federal',
      description: 'Services to help older adults remain independent in their communities',
      eligibility_bullets: JSON.stringify(['Area agencies on aging', 'Nonprofit organizations serving seniors']),
      amount_min: 10000,
      amount_max: 1000000,
      deadline_type: 'ongoing',
      application_url: 'https://acl.gov/programs/aging-and-disability-networks/older-americans-act',
      is_national: true,
      state: 'nationwide',
      categories: JSON.stringify(['seniors', 'healthcare', 'community']),
      keywords: JSON.stringify(['seniors', 'aging', 'supportive services', 'independence']),
      opportunity_type: 'grant',
      requires_501c3: true,
      requires_match: false,
    },
    {
      title: 'SNAP Employment and Training Program',
      sponsor: 'USDA Food and Nutrition Service',
      source: 'federal',
      description: 'Job training and employment services for SNAP recipients',
      eligibility_bullets: JSON.stringify(['State agencies', 'Nonprofit workforce development organizations']),
      amount_min: 50000,
      amount_max: 3000000,
      deadline_type: 'ongoing',
      application_url: 'https://www.fns.usda.gov/snap/et',
      is_national: true,
      state: 'nationwide',
      categories: JSON.stringify(['employment', 'training', 'food assistance']),
      keywords: JSON.stringify(['employment', 'job training', 'SNAP', 'workforce']),
      opportunity_type: 'grant',
      requires_501c3: false,
      requires_match: false,
    },
    // Foundation Grants
    {
      title: 'Community Foundation General Operating Support',
      sponsor: 'The Cleveland Foundation',
      source: 'foundation',
      description: 'General operating support for nonprofits serving Greater Cleveland',
      eligibility_bullets: JSON.stringify(['501(c)(3) organizations', 'Serving Greater Cleveland area']),
      amount_min: 5000,
      amount_max: 50000,
      deadline_type: 'rolling',
      application_url: 'https://www.clevelandfoundation.org/grants/',
      is_national: false,
      state: 'Ohio',
      categories: JSON.stringify(['community', 'general operating']),
      keywords: JSON.stringify(['Cleveland', 'Ohio', 'community', 'nonprofit']),
      opportunity_type: 'grant',
      requires_501c3: true,
      requires_match: false,
    },
    {
      title: 'Health Equity Initiative',
      sponsor: 'Robert Wood Johnson Foundation',
      source: 'foundation',
      description: 'Building a culture of health that provides everyone a fair and just opportunity',
      eligibility_bullets: JSON.stringify(['501(c)(3) organizations', 'Focus on health equity']),
      amount_min: 50000,
      amount_max: 500000,
      deadline_type: 'rolling',
      application_url: 'https://www.rwjf.org/en/how-we-work/submit-a-proposal.html',
      is_national: true,
      state: 'nationwide',
      categories: JSON.stringify(['healthcare', 'equity', 'public health']),
      keywords: JSON.stringify(['health equity', 'public health', 'healthcare access']),
      opportunity_type: 'grant',
      requires_501c3: true,
      requires_match: false,
    },
    {
      title: 'Education Innovation Fund',
      sponsor: 'Bill & Melinda Gates Foundation',
      source: 'foundation',
      description: 'Supporting innovative approaches to improve educational outcomes',
      eligibility_bullets: JSON.stringify(['501(c)(3) organizations', 'Educational institutions', 'Focus on underserved students']),
      amount_min: 100000,
      amount_max: 2000000,
      deadline_type: 'ongoing',
      application_url: 'https://www.gatesfoundation.org/about/how-we-work/grant-process',
      is_national: true,
      state: 'nationwide',
      categories: JSON.stringify(['education', 'innovation', 'youth']),
      keywords: JSON.stringify(['education', 'STEM', 'underserved students', 'innovation']),
      opportunity_type: 'grant',
      requires_501c3: true,
      requires_match: false,
    },
    // State Programs
    {
      title: 'Ohio Disability Services Program',
      sponsor: 'Ohio Department of Developmental Disabilities',
      source: 'state',
      description: 'Services and support for individuals with developmental disabilities',
      eligibility_bullets: JSON.stringify(['Ohio residents with disabilities', 'Nonprofit disability service providers']),
      amount_min: 10000,
      amount_max: 250000,
      deadline_type: 'rolling',
      application_url: 'https://dodd.ohio.gov/',
      is_national: false,
      state: 'Ohio',
      categories: JSON.stringify(['disability', 'healthcare', 'social services']),
      keywords: JSON.stringify(['disability', 'Ohio', 'developmental disabilities', 'support services']),
      opportunity_type: 'grant',
      requires_501c3: true,
      requires_match: false,
    },
    {
      title: 'California Veterans Affairs Grant Program',
      sponsor: 'California Department of Veterans Affairs',
      source: 'state',
      description: 'Support services for California veterans and their families',
      eligibility_bullets: JSON.stringify(['California veterans', 'Veteran service organizations']),
      amount_min: 5000,
      amount_max: 100000,
      deadline_type: 'ongoing',
      application_url: 'https://www.calvet.ca.gov/',
      is_national: false,
      state: 'California',
      categories: JSON.stringify(['veterans', 'healthcare', 'housing']),
      keywords: JSON.stringify(['veterans', 'California', 'military', 'support services']),
      opportunity_type: 'grant',
      requires_501c3: false,
      requires_match: false,
    },
    // Additional opportunities
    {
      title: 'Community Health Center Expansion',
      sponsor: 'Health Resources and Services Administration',
      source: 'federal',
      description: 'Expanding access to primary healthcare in underserved areas',
      eligibility_bullets: JSON.stringify(['Federally Qualified Health Centers', '501(c)(3) health organizations']),
      amount_min: 100000,
      amount_max: 1000000,
      deadline_type: 'rolling',
      application_url: 'https://bphc.hrsa.gov/',
      is_national: true,
      state: 'nationwide',
      categories: JSON.stringify(['healthcare', 'community', 'primary care']),
      keywords: JSON.stringify(['healthcare', 'community health', 'primary care', 'underserved']),
      opportunity_type: 'grant',
      requires_501c3: true,
      requires_match: false,
    },
    {
      title: 'Rural Development Grant',
      sponsor: 'USDA Rural Development',
      source: 'federal',
      description: 'Economic development and essential services for rural communities',
      eligibility_bullets: JSON.stringify(['Rural communities', 'Nonprofit organizations in rural areas']),
      amount_min: 25000,
      amount_max: 500000,
      deadline_type: 'rolling',
      application_url: 'https://www.rd.usda.gov/programs-services',
      is_national: true,
      state: 'nationwide',
      categories: JSON.stringify(['rural', 'economic development', 'community']),
      keywords: JSON.stringify(['rural', 'economic development', 'agriculture', 'community']),
      opportunity_type: 'grant',
      requires_501c3: false,
      requires_match: false,
    },
    {
      title: 'Youth Mentoring Grant',
      sponsor: 'Office of Juvenile Justice and Delinquency Prevention',
      source: 'federal',
      description: 'Evidence-based mentoring programs for at-risk youth',
      eligibility_bullets: JSON.stringify(['501(c)(3) organizations', 'Educational institutions', 'Faith-based organizations']),
      amount_min: 50000,
      amount_max: 750000,
      deadline_type: 'fixed',
      application_url: 'https://ojjdp.ojp.gov/',
      is_national: true,
      state: 'nationwide',
      categories: JSON.stringify(['youth', 'mentoring', 'education']),
      keywords: JSON.stringify(['youth', 'mentoring', 'at-risk', 'juvenile justice']),
      opportunity_type: 'grant',
      requires_501c3: true,
      requires_match: false,
    },
    {
      title: 'Environmental Justice Small Grants',
      sponsor: 'Environmental Protection Agency',
      source: 'federal',
      description: 'Supporting community-based organizations addressing environmental justice',
      eligibility_bullets: JSON.stringify(['501(c)(3) organizations', 'Community-based organizations', 'Tribal governments']),
      amount_min: 25000,
      amount_max: 75000,
      deadline_type: 'fixed',
      application_url: 'https://www.epa.gov/environmentaljustice/environmental-justice-small-grants-program',
      is_national: true,
      state: 'nationwide',
      categories: JSON.stringify(['environment', 'justice', 'community']),
      keywords: JSON.stringify(['environmental justice', 'community', 'sustainability']),
      opportunity_type: 'grant',
      requires_501c3: true,
      requires_match: false,
    },
    {
      title: 'Arts and Culture Community Grant',
      sponsor: 'National Endowment for the Arts',
      source: 'federal',
      description: 'Supporting arts projects that benefit communities',
      eligibility_bullets: JSON.stringify(['501(c)(3) arts organizations', 'Cultural institutions']),
      amount_min: 10000,
      amount_max: 100000,
      deadline_type: 'fixed',
      application_url: 'https://www.arts.gov/grants',
      is_national: true,
      state: 'nationwide',
      categories: JSON.stringify(['arts', 'culture', 'community']),
      keywords: JSON.stringify(['arts', 'culture', 'community engagement']),
      opportunity_type: 'grant',
      requires_501c3: true,
      requires_match: true,
      match_percentage: 50,
    },
  ]
  
  const insertOpp = db.prepare(`
    INSERT INTO funding_opportunities (
      id, title, sponsor, source, description, eligibility_bullets,
      amount_min, amount_max, deadline_type, application_url,
      is_national, state, categories, keywords, opportunity_type,
      requires_501c3, requires_match, match_percentage, is_active,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)
  
  for (const opp of realOpportunities) {
    insertOpp.run(
      crypto.randomUUID(),
      opp.title,
      opp.sponsor,
      opp.source,
      opp.description,
      opp.eligibility_bullets,
      opp.amount_min,
      opp.amount_max,
      opp.deadline_type,
      opp.application_url,
      opp.is_national ? 1 : 0,
      opp.state,
      opp.categories,
      opp.keywords,
      opp.opportunity_type,
      opp.requires_501c3 ? 1 : 0,
      opp.requires_match ? 1 : 0,
      opp.match_percentage || null
    )
  }
  
  console.log(`✓ Created ${realOpportunities.length} funding opportunities`)
}

// Final stats
console.log('\n📊 Database Statistics')
console.log('======================')

const stats = {
  profiles: db.prepare('SELECT COUNT(*) as count FROM profiles').get().count,
  organizations: db.prepare('SELECT COUNT(*) as count FROM organizations').get().count,
  funding_opportunities: db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get().count,
  grants: db.prepare('SELECT COUNT(*) as count FROM grants').get().count,
}

for (const [table, count] of Object.entries(stats)) {
  console.log(`  ${table}: ${count}`)
}

db.close()
console.log('\n✅ Database initialization complete!')
