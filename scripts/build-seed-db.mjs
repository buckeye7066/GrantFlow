#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { baselineProfiles } from './seed-data/baselineProfiles.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const expectedSections = [
  'basic_information',
  'organization_details',
  'financial_information',
  'government_assistance',
  'health_medical',
  'demographics',
  'family_life',
  'military_service',
  'occupation',
  'location_focus',
  'narrative',
  'university_applications',
]

function resolveDbPath() {
  const envPath = process.env.DB_PATH
  if (envPath && envPath.trim().length > 0) {
    return path.resolve(process.cwd(), envPath.trim())
  }
  return path.resolve(__dirname, '../backend/data/grantflow.db')
}

const dbPath = resolveDbPath()
const dbDir = path.dirname(dbPath)

if (fs.existsSync(dbPath)) {
  if (process.env.FORCE === 'true') {
    fs.unlinkSync(dbPath)
    console.log(`[seed] Existing database removed at ${dbPath}`)
  } else {
    console.error(
      `[seed] Database already exists at ${dbPath}. Set FORCE=true to overwrite or provide a different DB_PATH.`,
    )
    process.exit(1)
  }
}

fs.mkdirSync(dbDir, { recursive: true })

const schemaPath = path.resolve(__dirname, '../backend/db/schema.sql')
if (!fs.existsSync(schemaPath)) {
  console.error(`[seed] Unable to locate schema at ${schemaPath}`)
  process.exit(1)
}

const schemaSql = fs.readFileSync(schemaPath, 'utf8')
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.exec(schemaSql)

const insertOrganization = db.prepare(`
  INSERT INTO organizations (
    id, name, email, phone, website, address, city, state, zip, applicant_type,
    annual_budget, staff_count, mission, keywords, focus_areas, program_areas, funding_amount_needed
  ) VALUES (
    @id, @name, @email, @phone, @website, @address, @city, @state, @zip, @applicant_type,
    @annual_budget, @staff_count, @mission, @keywords, @focus_areas, @program_areas, @funding_amount_needed
  )
`)

const insertProfile = db.prepare(`
  INSERT INTO profiles (
    id, display_name, primary_type, status, organization_id, tags
  ) VALUES (
    @id, @display_name, @primary_type, @status, @organization_id, @tags
  )
`)

const insertSection = db.prepare(`
  INSERT INTO profile_sections (
    id, profile_id, section_key, data, updated_by
  ) VALUES (
    @id, @profile_id, @section_key, @data, @updated_by
  )
`)

const seed = db.transaction(() => {
  baselineProfiles.forEach((profile) => {
    const organization = profile.organization ?? null

    if (organization) {
      insertOrganization.run({
        id: organization.id,
        name: organization.name,
        email: organization.email ?? null,
        phone: organization.phone ?? null,
        website: organization.website ?? null,
        address: organization.address ?? null,
        city: organization.city ?? null,
        state: organization.state ?? null,
        zip: organization.zip ?? null,
        applicant_type: organization.applicant_type ?? profile.primary_type ?? null,
        annual_budget: organization.annual_budget ?? null,
        staff_count: organization.staff_count ?? null,
        mission: organization.mission ?? null,
        keywords: JSON.stringify(organization.keywords ?? []),
        focus_areas: JSON.stringify(organization.focus_areas ?? []),
        program_areas: JSON.stringify(organization.program_areas ?? []),
        funding_amount_needed: organization.funding_amount_needed ?? null,
      })
    }

    const missingSections = expectedSections.filter(
      (sectionKey) => !(profile.sections ?? {})[sectionKey],
    )
    if (missingSections.length > 0) {
      throw new Error(
        `Profile ${profile.id} is missing section data for: ${missingSections.join(', ')}`,
      )
    }

    insertProfile.run({
      id: profile.id,
      display_name: profile.display_name,
      primary_type: profile.primary_type ?? organization?.applicant_type ?? null,
      status: profile.status ?? 'active',
      organization_id: organization?.id ?? null,
      tags: JSON.stringify(profile.tags ?? []),
    })

    Object.entries(profile.sections ?? {}).forEach(([sectionKey, data]) => {
      insertSection.run({
        id: crypto.randomUUID(),
        profile_id: profile.id,
        section_key: sectionKey,
        data: JSON.stringify(data ?? {}),
        updated_by: 'seed-script',
      })
    })
  })
})

seed()
db.close()

console.log(`[seed] Seeded ${baselineProfiles.length} profiles into ${dbPath}`)
