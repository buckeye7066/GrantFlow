import Database from 'better-sqlite3';

import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'backend', 'data', 'grantflow.db');
const PROFILE_ID = 'profile-avanell-leamon';

const IRRELEVANT_TITLE_PATTERNS = [
  // Veteran-specific
  'SSVF',
  'Supportive Services for Veteran Families',
  'Boots to Business',
  'Veteran Entrepreneurship',

  // Business/entrepreneur grants
  'Minority Business Development Agency',
  'MBDA',
  'USDA Rural Business Development',
  'Native CDFI Network',
  'Indigenous Business',
  'National Urban League',
  'Entrepreneurship Centers',
  'SBA Women-Owned Small Business',
  'WOSB',
  'SBA 8(a) Business Development',
  'LiftFund',
  'Community Business Grants',
  'NASE Growth Grants',
  'Kiva U.S.',
  'Crowdfunded Business',
  'SBIR',
  'STTR',
  'Small Business Innovation Research',
  'USDA Value-Added Producer Grants',
  'VAPG',
  'SBA Community Advantage',
  'SBA Small Business Resources',
  'SBA Small Business Grants',
  'Self-Employment Assistance Program',

  // Refugee/resettlement
  'Office of Refugee Resettlement',
  'International Rescue Committee',
  'IRC.*Resettlement',
  'Resettlement.*IRC',

  // Nonprofit-specific
  'Good360',
  'Product Philanthropy for Nonprofits',
  'GrantWatch.*Van.*Vehicle.*Nonprofits',
  'Van & Vehicle Grants for Nonprofits',
  'Foundation Directory Online',
  'Equipment & Vehicle Grants',

  // Foster care youth
  'FosterClub',
  'Youth Aging Out',

  // Visual impairment
  'National Federation of the Blind',
  'American Foundation for the Blind',
  'visual impairment support',

  // First responders
  'First Responder Children',

  // Wrong location
  'Silver Point, TN',
  'near Silver Point',
  'Whitleyville, TN',
  'near Whitleyville',
  'near Wilder, TN',
  'Wilder, TN',

  // University-specific
  'Cleveland State University',
  'Cleveland State Community College',
];

const db = new Database(DB_PATH);

console.log('=== Cleanup Avanell Pipeline — Remove Irrelevant Grants ===\n');

const allGrants = db.prepare(
  `SELECT id, title FROM grants WHERE profile_id = ?`
).all(PROFILE_ID);

console.log(`Total grants for profile ${PROFILE_ID}: ${allGrants.length}\n`);

if (allGrants.length === 0) {
  console.log('No grants found for this profile. Nothing to clean up.');
  db.close();
  process.exit(0);
}

const toDelete = [];

for (const grant of allGrants) {
  const titleLower = (grant.title || '').toLowerCase();
  const matched = IRRELEVANT_TITLE_PATTERNS.some((pattern) => {
    const patLower = pattern.toLowerCase();
    if (patLower.includes('.*')) {
      try {
        return new RegExp(patLower).test(titleLower);
      } catch {
        return titleLower.includes(patLower.replace(/\.\*/g, ''));
      }
    }
    return titleLower.includes(patLower);
  });
  if (matched) {
    toDelete.push(grant);
  }
}

console.log(`Grants flagged for removal: ${toDelete.length}\n`);

if (toDelete.length === 0) {
  console.log('No irrelevant grants matched. Pipeline is already clean.');
  db.close();
  process.exit(0);
}

const deleteStmt = db.prepare('DELETE FROM grants WHERE id = ?');

const deleteTx = db.transaction((grants) => {
  for (const g of grants) {
    deleteStmt.run(g.id);
    console.log(`  DELETED: [${g.id}] ${g.title}`);
  }
});

deleteTx(toDelete);

const remaining = db.prepare(
  `SELECT COUNT(*) as cnt FROM grants WHERE profile_id = ?`
).get(PROFILE_ID);

console.log(`\n✓ Removed ${toDelete.length} irrelevant grants.`);
console.log(`✓ ${remaining.cnt} grants remain in Avanell's pipeline.\n`);

db.close();
