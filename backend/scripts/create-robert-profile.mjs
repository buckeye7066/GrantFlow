import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const db = new Database('./data/grantflow.db');

console.log('=== Creating Robert White Profile ===\n');

// Check if profile already exists
const existing = db.prepare("SELECT id FROM profiles WHERE display_name LIKE '%Robert White%'").get();
if (existing) {
  console.log('Profile already exists:', existing.id);
  db.close();
  process.exit(0);
}

// Create profile
const profileId = crypto.randomUUID();
db.prepare(`
  INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by)
  VALUES (?, 'Robert White', 'individual', 'active', '[]', 'admin')
`).run(profileId);

console.log(`✓ Created profile: Robert White (${profileId})`);

// Get admin user
const admin = db.prepare("SELECT id FROM users WHERE is_admin = 1").get();

// Link to admin
db.prepare('INSERT INTO user_profiles (user_id, profile_id, role) VALUES (?, ?, ?)').run(admin.id, profileId, 'admin');
console.log('✓ Linked to admin');

// Define extracted data
const profileData = {
  basic_information: {
    full_name: 'Robert White',
    profile_type: 'College Student',
    date_of_birth: '2001-12-27',
    address: {
      street: '3940 Eveningside Dr. NE',
      city: 'Cleveland',
      state: 'TN',
      zip: '37312'
    },
    geographic_focus: 'Cleveland, TN; Chattanooga, TN',
    website: 'none'
  },
  demographics: {
    ethnicity: 'White / Caucasian',
    citizenship: 'US Citizen',
    immigration_status: 'US Citizen',
    languages: ['English', 'Spanish', 'Third language (trilingual)'],
    heritage: 'White/Caucasian'
  },
  education: {
    highest_level: 'College Student - Currently in undergraduate program',
    current_institution: 'Cleveland State Community College',
    gpa: '3.75',
    high_school_gpa: '4.0',
    valedictorian: true,
    intended_major: 'Paramedic',
    community_service_hours: '400+',
    target_colleges: [
      'Cleveland State Community College',
      'Chattanooga State Community College',
      'Northeast State Community College',
      'Roane State Community College',
      'Volunteer State Community College',
      'Columbia State Community College',
      'Motlow State Community College',
      'Lee University'
    ],
    leadership_roles: ['Spanish Club', 'Chess Club']
  },
  employment: {
    current_status: 'Student',
    experience: 'Over 400 hours in skilled nursing facilities',
    career_goal: 'Fully qualified Paramedic'
  },
  financial: {
    household_income: '$310,000',
    funding_needs: '$50,000 per year',
    funding_purpose: 'Support education in paramedicine - textbooks, equipment, training materials, internship'
  },
  medical: {
    notes: 'Pursuing Paramedic certification'
  },
  housing: {
    address: '3940 Eveningside Dr. NE, Cleveland, TN 37312',
    type: 'Family home'
  },
  family: {
    support_system: 'Strong family support, mentors in healthcare field',
    notes: 'Family has limited resources despite income'
  },
  narrative: {
    personal_statement: `As a trilingual individual committed to enhancing emergency medical services, I, Robert White, aim to bridge the gap between healthcare and multilingual immigrant communities in Cleveland and Chattanooga. My journey began with a strong academic foundation, earning my Valedictorian status and a 4.0 GPA, which fueled my passion for community service. I have dedicated over 400 hours in skilled nursing facilities, focusing on delivering care while overcoming language barriers. This experience ignited my desire to become a fully qualified Paramedic, allowing me to implement outreach initiatives that improve healthcare access for non-native English speakers.

With my leadership roles in the Spanish Club and Chess Club, I cultivated my teamwork and mentorship skills, further solidifying my commitment to youth engagement in emergency medical services. I recognize the unique challenges faced by these communities and am determined to develop sustainable solutions through partnerships with local healthcare providers and advocacy organizations. By fostering cultural competence training for paramedics and establishing mentorship programs, I will ensure that a comprehensive, compassionate approach to healthcare is accessible for all. My mission is clear: to dismantle language barriers and enhance emergency healthcare access for those who need it most.`,
    goals: 'Become a fully qualified Paramedic, implement outreach initiatives for multilingual immigrant communities, partner with local healthcare providers for cultural competence training',
    needs_description: 'Financial assistance for paramedicine education, support for textbooks, equipment, training materials, and summer internship',
    target_population: 'Multilingual immigrant communities in Cleveland and Chattanooga, TN',
    unique_qualities: 'Trilingual, Valedictorian with 4.0 GPA, 400+ hours community service in skilled nursing facilities, leadership in Spanish Club and Chess Club'
  },
  programs_services: {
    interests: [
      'Emergency Medical Services',
      'Paramedic Training',
      'Multilingual Healthcare Initiatives',
      'Cultural Competence Training',
      'Community Health Outreach',
      'Healthcare Accessibility',
      'Youth Engagement in Healthcare',
      'Mentorship in Paramedicine',
      'Immigrant Health Advocacy'
    ],
    keywords: [
      'emergency medical services', 'paramedic training', 'multilingual healthcare',
      'cultural competence', 'community health outreach', 'healthcare accessibility',
      'language barriers in medicine', 'youth engagement', 'mentorship programs',
      'immigrant health advocacy', 'skilled nursing experience', 'trilingual',
      'valedictorian', 'gpa 4.0', 'community service 400 hours', 'cleveland tn',
      'chattanooga tn', 'paramedicine', 'ems', 'first responder'
    ],
    focus_areas: [
      'Emergency Medical Services',
      'Healthcare Accessibility',
      'Multilingual Healthcare',
      'Cultural Competence Training',
      'Community Health Outreach',
      'Youth Engagement in Healthcare',
      'Mentorship in Paramedicine',
      'Immigrant Health Advocacy'
    ]
  }
};

// Insert all sections
for (const [sectionKey, sectionData] of Object.entries(profileData)) {
  db.prepare(`
    INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
    VALUES (?, ?, ?, 'pdf-extraction')
  `).run(profileId, sectionKey, JSON.stringify(sectionData));
  console.log(`✓ ${sectionKey}: ${Object.keys(sectionData).length} fields`);
}

// Also add organization_details as empty for completeness
db.prepare(`
  INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
  VALUES (?, 'organization_details', '{}', 'system')
`).run(profileId);

// Copy PDF and create document record
const pdfPath = 'C:\\Users\\firer\\Downloads\\R1.pdf';
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (fs.existsSync(pdfPath)) {
  const documentId = crypto.randomUUID();
  const destFilename = `${documentId}-Robert-White-Profile.pdf`;
  const destPath = path.join(UPLOAD_DIR, destFilename);
  
  fs.copyFileSync(pdfPath, destPath);
  
  // Read extracted text
  const extractedText = fs.readFileSync('./temp_images/r1_text.txt', 'utf8');
  
  db.prepare(`
    INSERT INTO documents (id, profile_id, name, type, file_url, file_path, file_size, mime_type, extracted_text, processing_status, status, notes)
    VALUES (?, ?, ?, 'profile_document', ?, ?, ?, 'application/pdf', ?, 'completed', 'final', 'Uploaded for Robert White profile')
  `).run(
    documentId,
    profileId,
    'Robert-White-Profile-R1.pdf',
    `/uploads/${destFilename}`,
    destPath,
    fs.statSync(pdfPath).size,
    extractedText
  );
  
  db.prepare('INSERT INTO profile_documents (profile_id, document_id) VALUES (?, ?)').run(profileId, documentId);
  console.log(`\n✓ Attached document: ${documentId}`);
}

// Summary
console.log('\n=== ROBERT WHITE PROFILE COMPLETE ===');
const sections = db.prepare('SELECT section_key FROM profile_sections WHERE profile_id = ?').all(profileId);
console.log(`Sections: ${sections.length}`);
sections.forEach(s => console.log(`  - ${s.section_key}`));

const docCount = db.prepare('SELECT COUNT(*) as c FROM profile_documents WHERE profile_id = ?').get(profileId);
console.log(`Documents: ${docCount.c}`);

db.close();
console.log('\n✓ Done!');
