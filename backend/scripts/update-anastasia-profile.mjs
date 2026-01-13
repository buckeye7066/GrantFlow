import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const db = new Database('./data/grantflow.db');

console.log('=== Updating Anastasia Nicole White Profile ===\n');

// Find Anastasia profile
const profile = db.prepare("SELECT id, display_name FROM profiles WHERE display_name LIKE '%Anastasia%'").get();
if (!profile) {
  console.error('Anastasia profile not found!');
  process.exit(1);
}

console.log(`Found profile: ${profile.display_name} (${profile.id})`);

// Update display name
db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run('Anastasia Nicole White', profile.id);
console.log('✓ Updated display name to: Anastasia Nicole White');

// Define extracted data
const profileData = {
  basic_information: {
    full_name: 'Anastasia Nicole White',
    profile_type: 'High School Student',
    current_school: 'Cleveland State Community College',
    location: 'Cleveland, Tennessee',
    county: 'Bradley County',
    notes: 'Currently in high school, taking college-level classes at Cleveland State Community College'
  },
  demographics: {
    ethnicity: 'White / Caucasian',
    heritage: 'Polish',
    languages: ['English', 'Russian'],
    geographic_qualifiers: ['Rural Resident', 'Appalachian Region'],
    immigrant_status: 'Second-generation immigrant',
    gender: 'Female'
  },
  education: {
    highest_level: 'High School Senior (with college courses)',
    current_institution: 'Cleveland State Community College',
    gpa: '3.84',
    act_score: '28',
    intended_major: 'Forensic Science',
    schools: [
      { name: 'Cleveland State Community College', status: 'Current', type: 'Community College' }
    ],
    target_colleges: [
      'Middle Tennessee State University', 'University of Central Florida', 'University of New Haven',
      'Penn State University', 'Trevecca Nazarene University', 'Austin Peay State University',
      'Carson-Newman', 'Centre College', 'Christian Brothers University', 'Oberlin College',
      'Seton Hall University', 'Ohio State University', 'University of Alabama',
      'University of Tennessee Chattanooga', 'University of Tennessee Knoxville',
      'University of Michigan', 'Florida International University', 'Harvard University', 'Lee University'
    ],
    interests: ['Forensic Science', 'Criminal Justice', 'STEM', 'DNA Analysis', 'Crime Scene Investigation']
  },
  employment: {
    current_status: 'Unemployed',
    notes: 'High school student focused on academics'
  },
  financial: {
    annual_income: '$56,000',
    household_income: '$56,000',
    household_size: '7',
    receives_assistance: ['SSDI'],
    assistance_notes: 'Receives SSDI as the minor child of a parent who gets SSDI'
  },
  medical: {
    disabilities: [],
    assistance_programs: ['SSDI'],
    notes: 'SSDI recipient (as dependent)'
  },
  housing: {
    status: 'With family',
    type: 'Rural',
    geographic_designation: ['Rural', 'Appalachian'],
    broadband_speed: '1000 Mbps'
  },
  family: {
    household_size: '7',
    notes: 'Lives with grandparents who do not speak English; acts as translator and advocate',
    responsibilities: 'Assists grandparents with language barrier (Russian-speaking family)'
  },
  narrative: {
    personal_statement: `Navigating my journey as a high school senior has been fraught with challenges that directly influence my aspirations in forensic science. Balancing the demands of rigorous coursework with the pursuit of college-level classes requires immense dedication and time management. I often find myself navigating not just my academic goals, but also the added responsibility of assisting my grandparents, who do not speak English. This language barrier further complicates my experience, as I strive to be an advocate and translator while maintaining my academic performance and extracurricular commitments.

These experiences have ignited my passion for educational equity, particularly for second-generation immigrants like myself. I understand the barriers that my community faces in accessing quality education and opportunities in STEM fields. By overcoming my own challenges, I am inspired to empower others facing similar obstacles. My commitment to fostering an inclusive environment in forensic science is driven by my desire to uplift those who may not have the same resources, ensuring that the path I forge not only paves the way for my future but also creates opportunities for underserved populations in our society.`,
    goals: 'Pursue a career in forensic science, advocate for educational equity for second-generation immigrants and underserved populations in STEM fields',
    needs_description: 'Financial assistance for higher education, support for STEM career development',
    focus_areas: ['Forensic Science', 'Criminal Justice', 'STEM Education', 'Educational Equity', 'Women in STEM']
  },
  programs_services: {
    interests: [
      'Forensic Science Education Programs',
      'Scholarship Opportunities for STEM Students',
      'Community Service Programs in Criminal Justice',
      'Leadership Development for Multilingual Students',
      'STEM Outreach for Underserved Populations',
      'Mentorship Programs for Aspiring Forensic Scientists',
      'Educational Equity Initiatives'
    ],
    keywords: [
      'forensic science', 'criminal justice', 'crime scene investigation', 'DNA analysis',
      'biology', 'chemistry', 'stem', 'research', 'laboratory', 'science student',
      'high school senior', 'undergraduate', 'college bound', 'academic excellence',
      'scholarship', 'financial aid', 'tennessee student', 'cleveland tn', 'stem scholarship',
      'forensic pathology', 'women in stem', 'stem diversity', 'educational equity',
      'second generation immigrant', 'multilingual', 'russian-speaking', 'community service',
      'student leadership', 'act 28', 'gpa 3.84'
    ]
  }
};

// Update each section
for (const [sectionKey, sectionData] of Object.entries(profileData)) {
  db.prepare(`
    INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
    VALUES (?, ?, ?, 'ocr-extraction')
    ON CONFLICT(profile_id, section_key) DO UPDATE SET
      data = excluded.data,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = excluded.updated_by
  `).run(profile.id, sectionKey, JSON.stringify(sectionData));
  
  const fieldCount = Object.keys(sectionData).length;
  console.log(`✓ ${sectionKey}: ${fieldCount} fields`);
}

// Copy PDF to uploads and create document record
const pdfPath = 'C:\\Users\\firer\\Downloads\\A1.pdf';
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Check if document already exists
const existingDoc = db.prepare('SELECT id FROM documents WHERE profile_id = ? AND name LIKE ?').get(profile.id, '%A1%');

if (!existingDoc && fs.existsSync(pdfPath)) {
  const documentId = crypto.randomUUID();
  const destFilename = `${documentId}-Anastasia-Profile.pdf`;
  const destPath = path.join(UPLOAD_DIR, destFilename);
  
  fs.copyFileSync(pdfPath, destPath);
  
  // Read extracted text
  const extractedText = fs.readFileSync('./temp_images/a1_text.txt', 'utf8');
  
  db.prepare(`
    INSERT INTO documents (id, profile_id, name, type, file_url, file_path, file_size, mime_type, extracted_text, processing_status, status, notes)
    VALUES (?, ?, ?, 'profile_document', ?, ?, ?, 'application/pdf', ?, 'completed', 'final', 'Uploaded for Anastasia profile')
  `).run(
    documentId,
    profile.id,
    'Anastasia-Profile-A1.pdf',
    `/uploads/${destFilename}`,
    destPath,
    fs.statSync(pdfPath).size,
    extractedText
  );
  
  db.prepare('INSERT OR IGNORE INTO profile_documents (profile_id, document_id) VALUES (?, ?)').run(profile.id, documentId);
  console.log(`\n✓ Attached document: ${documentId}`);
}

// Final summary
console.log('\n=== FINAL PROFILE STATUS ===');
const finalProfile = db.prepare('SELECT display_name FROM profiles WHERE id = ?').get(profile.id);
console.log(`Profile: ${finalProfile.display_name}`);

const sections = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id);
console.log(`Total sections: ${sections.length}`);

for (const s of sections) {
  const data = JSON.parse(s.data || '{}');
  const filled = Object.keys(data).length;
  console.log(`  - ${s.section_key}: ${filled} fields`);
}

const docCount = db.prepare('SELECT COUNT(*) as count FROM profile_documents WHERE profile_id = ?').get(profile.id);
console.log(`Documents attached: ${docCount.count}`);

db.close();
console.log('\n✓ DONE!');
