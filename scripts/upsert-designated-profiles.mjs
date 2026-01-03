#!/usr/bin/env node

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

const db = new Database('backend/data/grantflow.db')

const now = new Date().toISOString()

const profiles = [
  {
    id: 'profile-brian-client',
    display_name: 'Brian Client',
    primary_type: 'individual_need',
    status: 'active',
    tags: [],
    sections: {
      basic_information: {
        full_name: 'Brian',
        email: 'isawstars08@yahoo.com',
      },
      financial_information: {
        financial_need_level: 'High',
      },
      narrative: {
        mission: 'Profile imported from Brian.pdf.',
      },
    },
  },
  {
    id: 'profile-olivia-beltran',
    display_name: 'Olivia Beltran / Hybrid Healing',
    primary_type: 'small_business',
    status: 'active',
    tags: ['wellness', 'holistic', 'small business'],
    sections: {
      basic_information: {
        full_name: 'Hybrid Healing Wellness Collective',
        email: 'Oliviadbeltran@gmail.com',
        phone: '7245449650',
        website: 'https://mysite.vagaro.com/hybridhealingllc/',
        address: '196 James Street\nBeaver Falls, PA 15010',
      },
      organization_details: {
        organization_type: 'Holistic wellness collective',
        ein: '88-4291655',
        mission:
          'Provide integrative wellness services led by a nurse practitioner and trauma-informed massage therapist.',
      },
      financial_information: {
        financial_need_level: 'High',
        household_income: 36000,
        household_size: 6,
        notes:
          'Seeking $50,000 to expand services, purchase equipment, and complete facility build-out.',
      },
      demographics: {
        hispanic_latino: true,
        white_caucasian: true,
      },
      family_life: {
        family_caregiver: true,
        first_time_parent: true,
      },
      location_focus: {
        appalachian_region: true,
        geographic_focus: 'Beaver County, Pennsylvania',
      },
      narrative: {
        primary_goal:
          'Expand Hybrid Healing wellness services, upgrade facilities, and stabilize operations.',
        funding_amount_needed: '$50,000 for equipment, renovations, staffing, and marketing.',
        mission:
          'Create a holistic sanctuary that integrates nursing care, trauma-informed bodywork, and community wellness.',
      },
    },
  },
  {
    id: 'profile-hollie-knox',
    display_name: 'Hollie Machelle Knox',
    primary_type: 'family',
    status: 'active',
    tags: ['family', 'single parent', 'domestic violence survivor'],
    sections: {
      basic_information: {
        full_name: 'Hollie Machelle Knox',
        email: 'HollieT52@gmail.com',
        phone: '4403965688',
        address: '120 Middle St\nWellington, OH 44090',
      },
      financial_information: {
        financial_need_level: 'High',
        household_income: 30000,
        household_size: 3,
        low_income: true,
        notes: 'Seeking $5,000 for housing stability and small business start-up costs.',
      },
      government_assistance: {
        medicaid_enrolled: true,
      },
      health_medical: {
        chronic_illness: true,
        neurodivergent: true,
      },
      demographics: {
        white_caucasian: true,
        us_citizen: true,
      },
      family_life: {
        single_parent: true,
        family_caregiver: true,
        domestic_violence_survivor: true,
      },
      narrative: {
        primary_goal:
          'Provide a stable home for her children and launch an apothecary business for generational wealth.',
        mission:
          'Overcome financial hardships and build a safe, loving family environment with sustainable income.',
        funding_amount_needed: '$5,000 for housing costs and initial business inventory.',
      },
    },
  },
]

const upsertProfile = db.prepare(`
  INSERT INTO profiles (id, display_name, primary_type, status, tags, updated_at)
  VALUES (@id, @display_name, @primary_type, @status, @tags, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    display_name = excluded.display_name,
    primary_type = excluded.primary_type,
    status = excluded.status,
    tags = excluded.tags,
    updated_at = excluded.updated_at
`)

const deleteSections = db.prepare(`DELETE FROM profile_sections WHERE profile_id = ?`)

const insertSection = db.prepare(`
  INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by)
  VALUES (?, ?, ?, ?, 'system-sync')
`)

const transaction = db.transaction(() => {
  for (const profile of profiles) {
    upsertProfile.run({
      id: profile.id,
      display_name: profile.display_name,
      primary_type: profile.primary_type,
      status: profile.status,
      tags: JSON.stringify(profile.tags ?? []),
      updated_at: now,
    })

    deleteSections.run(profile.id)

    if (profile.sections) {
      for (const [sectionKey, sectionData] of Object.entries(profile.sections)) {
        insertSection.run(randomUUID(), profile.id, sectionKey, JSON.stringify(sectionData ?? {}))
      }
    }
  }
})

transaction()
db.close()

console.log('[sync] Profiles upserted:', profiles.map((p) => p.id).join(', '))
