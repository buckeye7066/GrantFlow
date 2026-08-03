#!/usr/bin/env node
// Mark ledger rows inspected: node scripts/recovery/mark-inspected.mjs <list-file> "<evidence>"
// list-file: one repo-relative path per line (# comments allowed). Unknown paths are
// reported, never silently skipped. Re-marking an inspected row keeps existing findings.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
const ledgerPath = path.join(repoRoot, 'docs', 'recovery', 'FILE_AUDIT.csv');
const [listFile, evidence] = process.argv.slice(2);
if (!listFile || !evidence) { console.error('usage: mark-inspected.mjs <list-file> "<evidence>"'); process.exit(2); }

const wanted = new Set(readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
const lines = readFileSync(ledgerPath, 'utf8').split('\n');
const esc = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v);
function parseCsvRow(row) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < row.length; i += 1) {
    const c = row[i];
    if (q) { if (c === '"') { if (row[i + 1] === '"') { cur += '"'; i += 1; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
let marked = 0;
const found = new Set();
const out = lines.map((line, idx) => {
  if (idx === 0 || !line) return line;
  const cols = parseCsvRow(line);
  if (!wanted.has(cols[0])) return line;
  found.add(cols[0]);
  cols[8] = 'yes';
  cols[11] = cols[11] ? cols[11] : evidence;
  marked += 1;
  return cols.map(esc).join(',');
});
writeFileSync(ledgerPath, out.join('\n'));
const missing = [...wanted].filter((p) => !found.has(p));
console.log(`marked ${marked}; not in ledger: ${missing.length}`);
for (const m of missing) console.log('  MISSING: ' + m);
