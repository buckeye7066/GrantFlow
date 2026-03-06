import { pathToFileURL } from 'url';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { getDb } = await import(pathToFileURL(join(__dirname, '..', 'backend', 'db', 'index.js')).href);
const db = getDb();

const total = db.prepare('SELECT COUNT(*) AS cnt FROM funding_opportunities WHERE is_active = 1').get();
const withSrcUrl = db.prepare("SELECT COUNT(*) AS cnt FROM funding_opportunities WHERE is_active = 1 AND source_url IS NOT NULL AND source_url != ''").get();
const withAppUrl = db.prepare("SELECT COUNT(*) AS cnt FROM funding_opportunities WHERE is_active = 1 AND application_url IS NOT NULL AND application_url != ''").get();
const anyUrl = db.prepare("SELECT COUNT(*) AS cnt FROM funding_opportunities WHERE is_active = 1 AND (COALESCE(source_url,'') != '' OR COALESCE(application_url,'') != '')").get();

console.log('Total active opportunities:', total.cnt);
console.log('With source_url:', withSrcUrl.cnt);
console.log('With application_url:', withAppUrl.cnt);
console.log('With any URL:', anyUrl.cnt, `(${Math.round(anyUrl.cnt / total.cnt * 100)}%)`);

console.log('\nBy source (top 15):');
const bySource = db.prepare('SELECT source, COUNT(*) AS cnt FROM funding_opportunities WHERE is_active = 1 GROUP BY source ORDER BY cnt DESC LIMIT 15').all();
bySource.forEach(r => console.log(`  ${r.source}: ${r.cnt}`));

console.log('\nBy state (top 10):');
const byState = db.prepare("SELECT state, COUNT(*) AS cnt FROM funding_opportunities WHERE is_active = 1 AND state IS NOT NULL GROUP BY state ORDER BY cnt DESC LIMIT 10").all();
byState.forEach(r => console.log(`  ${r.state}: ${r.cnt}`));

console.log('\nBy record_origin:');
const byOrigin = db.prepare('SELECT record_origin, COUNT(*) AS cnt FROM funding_opportunities WHERE is_active = 1 GROUP BY record_origin ORDER BY cnt DESC').all();
byOrigin.forEach(r => console.log(`  ${r.record_origin}: ${r.cnt}`));

console.log('\n5 most recent entries:');
const recent = db.prepare('SELECT title, source_url, state, source, record_origin FROM funding_opportunities WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 5').all();
recent.forEach(r => console.log(`  [${r.state}] ${r.title} | ${r.source} | ${(r.source_url || '').substring(0, 60)}`));

console.log('\n5 sample curated entries:');
const curated = db.prepare("SELECT title, source_url, state FROM funding_opportunities WHERE is_active = 1 AND record_origin = 'curated_verified' ORDER BY RANDOM() LIMIT 5").all();
curated.forEach(r => console.log(`  [${r.state}] ${r.title} | ${(r.source_url || '').substring(0, 60)}`));
