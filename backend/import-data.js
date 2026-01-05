// Data Import Script
// Run this once to import data from Base44 export

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the export file
const exportPath = process.argv[2] || path.join(__dirname, '../data-export.json');

if (!fs.existsSync(exportPath)) {
  console.error('Export file not found:', exportPath);
  // TODO: Remove debug log - console.log('Usage: node import-data.js [path-to-export.json]');
  process.exit(1);
}

// TODO: Remove debug log - console.log('Loading export from:', exportPath);
const exportData = JSON.parse(fs.readFileSync(exportPath, 'utf8'));

// Initialize database
const dbPath = process.env.DATABASE_URL || path.join(__dirname, 'data/grantflow.db');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Load and run schema
const schemaPath = path.join(__dirname, 'db/schema.sql');
if (fs.existsSync(schemaPath)) {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
  // TODO: Remove debug log - console.log('Schema initialized');
}

// Import organizations
if (exportData.entities?.Organization) {
  // TODO: Remove debug log - console.log(`Importing ${exportData.entities.Organization.length} organizations...`);
  
  const insertOrg = db.prepare(`
    INSERT OR REPLACE INTO organizations (
      id, name, email, phone, applicant_type,
      date_of_birth, age, address, city, state, zip,
      website, ein, uei, organization_type, nonprofit_type,
      annual_budget, staff_count, mission,
      current_college, intended_major, gpa, first_generation,
      household_income, household_size,
      medicaid_enrolled, snap_recipient, ssi_recipient, ssdi_recipient,
      veteran, disabled_veteran,
      keywords, focus_areas, program_areas, funding_amount_needed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const insertMany = db.transaction((orgs) => {
    for (const org of orgs) {
      const id = org.id || crypto.randomUUID();
      insertOrg.run(
        id,
        org.name,
        org.email,
        org.phone,
        org.applicant_type,
        org.date_of_birth,
        org.age,
        org.address,
        org.city,
        org.state,
        org.zip,
        org.website,
        org.ein,
        org.uei,
        org.organization_type,
        org.nonprofit_type,
        org.annual_budget,
        org.staff_count,
        org.mission,
        org.current_college,
        org.intended_major,
        org.gpa,
        org.first_generation ? 1 : 0,
        org.household_income,
        org.household_size,
        org.medicaid_enrolled ? 1 : 0,
        org.snap_recipient ? 1 : 0,
        org.ssi_recipient ? 1 : 0,
        org.ssdi_recipient ? 1 : 0,
        org.veteran ? 1 : 0,
        org.disabled_veteran ? 1 : 0,
        JSON.stringify(org.keywords || []),
        JSON.stringify(org.focus_areas || []),
        JSON.stringify(org.program_areas || []),
        org.funding_amount_needed
      );
    }
  });
  
  insertMany(exportData.entities.Organization);
  // TODO: Remove debug log - console.log('Organizations imported');
}

// Import Funding Opportunities
if (exportData.entities?.FundingOpportunity) {
  // TODO: Remove debug log - console.log(`Importing ${exportData.entities.FundingOpportunity.length} funding opportunities...`);
  
  const insertOpp = db.prepare(`
    INSERT OR REPLACE INTO funding_opportunities (
      id, title, sponsor, source, source_id, description,
      eligibility_bullets, amount_min, amount_max,
      deadline, deadline_type, application_url,
      is_national, state, categories, keywords, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  
  const insertMany = db.transaction((opps) => {
    for (const opp of opps) {
      const id = opp.id || crypto.randomUUID();
      insertOpp.run(
        id,
        opp.title,
        opp.sponsor,
        opp.source,
        opp.source_id,
        opp.descriptionMd || opp.description,
        JSON.stringify(opp.eligibilityBullets || opp.eligibility_bullets || []),
        opp.amount_min || opp.amountMin,
        opp.amount_max || opp.amountMax,
        opp.deadline,
        opp.deadline_type || 'unknown',
        opp.application_url || opp.applicationUrl,
        opp.is_national ? 1 : 0,
        opp.state,
        JSON.stringify(opp.categories || []),
        JSON.stringify(opp.keywords || [])
      );
    }
  });
  
  insertMany(exportData.entities.FundingOpportunity);
  // TODO: Remove debug log - console.log('Funding opportunities imported');
}

// Import Grants
if (exportData.entities?.Grant) {
  // TODO: Remove debug log - console.log(`Importing ${exportData.entities.Grant.length} grants...`);
  
  const insertGrant = db.prepare(`
    INSERT OR REPLACE INTO grants (
      id, organization_id, title, funder, status,
      amount_requested, amount_awarded, deadline,
      match_score, match_reasons, notes, application_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const insertMany = db.transaction((grants) => {
    for (const grant of grants) {
      const id = grant.id || crypto.randomUUID();
      insertGrant.run(
        id,
        grant.organization_id,
        grant.title,
        grant.funder,
        grant.status || 'discovered',
        grant.amount_requested,
        grant.amount_awarded,
        grant.deadline,
        grant.match_score,
        JSON.stringify(grant.match_reasons || []),
        grant.notes,
        grant.application_url
      );
    }
  });
  
  insertMany(exportData.entities.Grant);
  // TODO: Remove debug log - console.log('Grants imported');
}

// Import Documents
if (exportData.entities?.Document) {
  // TODO: Remove debug log - console.log(`Importing ${exportData.entities.Document.length} documents...`);
  
  const insertDoc = db.prepare(`
    INSERT OR REPLACE INTO documents (
      id, organization_id, grant_id, name, type, file_url, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  const insertMany = db.transaction((docs) => {
    for (const doc of docs) {
      const id = doc.id || crypto.randomUUID();
      insertDoc.run(
        id,
        doc.organization_id,
        doc.grant_id,
        doc.name,
        doc.type,
        doc.file_url,
        doc.status || 'draft'
      );
    }
  });
  
  insertMany(exportData.entities.Document);
  // TODO: Remove debug log - console.log('Documents imported');
}

// Import Milestones
if (exportData.entities?.Milestone) {
  // TODO: Remove debug log - console.log(`Importing ${exportData.entities.Milestone.length} milestones...`);
  
  const insertMilestone = db.prepare(`
    INSERT OR REPLACE INTO milestones (
      id, grant_id, title, description, due_date, completed, type
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  const insertMany = db.transaction((milestones) => {
    for (const m of milestones) {
      const id = m.id || crypto.randomUUID();
      insertMilestone.run(
        id,
        m.grant_id,
        m.title,
        m.description,
        m.due_date,
        m.completed ? 1 : 0,
        m.type
      );
    }
  });
  
  insertMany(exportData.entities.Milestone);
  // TODO: Remove debug log - console.log('Milestones imported');
}

// Summary
// TODO: Remove debug log - console.log('\n=== Import Complete ===');
const counts = {
  organizations: db.prepare('SELECT COUNT(*) as c FROM organizations').get().c,
  opportunities: db.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get().c,
  grants: db.prepare('SELECT COUNT(*) as c FROM grants').get().c,
  documents: db.prepare('SELECT COUNT(*) as c FROM documents').get().c,
  milestones: db.prepare('SELECT COUNT(*) as c FROM milestones').get().c,
};

// TODO: Remove debug log - console.log('Database contents:');
Object.entries(counts).forEach(([table, count]) => {
  // TODO: Remove debug log - console.log(`  ${table}: ${count} records`);
});

db.close();
// TODO: Remove debug log - console.log('\nDone!');
