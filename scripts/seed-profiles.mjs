#!/usr/bin/env node
import { initDb, createProfile } from '../backend/db/index.js'
import { v4 as uuidv4 } from 'uuid'

// Initialize database
initDb()

// Create some seed profiles
const profiles = [
  {
    id: uuidv4(),
    profile_type: 'organization',
    display_name: 'River Valley Education Fund',
    notes: 'Focus on STEM education initiatives. Next application deadline: Q1 2025.',
  },
  {
    id: uuidv4(),
    profile_type: 'organization',
    display_name: 'Community Health Partners',
    notes: 'Healthcare access programs. Rolling applications.',
  },
  {
    id: uuidv4(),
    profile_type: 'individual',
    display_name: 'Jane Smith - Student Profile',
    notes: 'Scholarship applicant. Currently attending State University.',
  },
]

console.log('Seeding profiles...')
for (const profileData of profiles) {
  try {
    const profile = createProfile(profileData)
    console.log(`✓ Created profile: ${profile.display_name} (${profile.id})`)
  } catch (error) {
    console.error(`✗ Failed to create profile ${profileData.display_name}:`, error.message)
  }
}

console.log('\nDone! Profiles have been seeded.')
