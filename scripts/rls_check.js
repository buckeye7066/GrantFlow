#!/usr/bin/env node
// rls_check.js - heuristic check for sdk.entities.filter calls missing 'profile_id' or 'organization_id'

const fs = require('fs');
const path = require('path');

function walk(dir) {
  let res = [];
  const list = fs.readdirSync(dir);
  for (const f of list) {
    const p = path.join(dir, f);
    if (p.includes('node_modules') || p.includes('.git') || p.includes('triage')) continue;
    if (fs.statSync(p).isDirectory()) res = res.concat(walk(p));
    else if (p.endsWith('.js') || p.endsWith('.ts')) res.push(p);
  }
  return res;
}

const files = walk(process.cwd());
const issues = [];

for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (line.includes('filter(') && line.includes('sdk.entities')) {
      // heuristics - check if next lines include profile_id or organization_id
      const snippet = lines.slice(Math.max(0, idx - 2), idx + 6).join('\n');
      // If the filter includes profile_id, organization_id, or other safe filters (lock_id, source_id), skip
      if (!/(profile_id|organization_id|lock_id|source_id|source)\s*:/g.test(snippet)) {
        issues.push({ file: f, line: idx + 1, snippet: snippet.substring(0, 400) });
      }
    }
  });
}

fs.writeFileSync('triage/rls_report.json', JSON.stringify({ issues }, null, 2));
console.log('RLS scan completed. Results saved to triage/rls_report.json');
if (issues.length) {
  console.log('Possible RLS filter issues found:');
  issues.slice(0, 50).forEach(i => console.log(`${i.file}:${i.line} -> ${i.snippet.split('\n')[0].trim()}`));
}

process.exit(0);
