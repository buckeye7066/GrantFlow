import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const isLegacy = (rel) =>
  /backend\/services\/(matchEngine|matchingEngine|opportunityMatcher|comprehensiveCrawlerOptimized|crawlerDispatcher|crawlerJobState|autoDiscoveryCrawlers|scheduledAutoDiscovery|grantsDotGovCrawler|realFundingCrawler|realLocationFundingCrawler|localCrawler)\.js$/.test(rel)
  || rel.includes('backend/services/crawlers/');
const IMP = /(?:^|\s|;|\()(?:import|export)\s+(?:[\s\S]*?\bfrom\s+)?['"]([^'"]+)['"]/g;
const DYN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
function resolve(spec, from) {
  if (spec.startsWith('node:') || (!spec.startsWith('.') && !spec.startsWith('/'))) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const e of ['', '.js', '.mjs', '.cjs']) {
    if (fs.existsSync(base + e) && fs.statSync(base + e).isFile()) return base + e;
  }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    for (const i of ['index.js', 'index.mjs']) {
      const p = path.join(base, i);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const visited = new Set();
const edges = new Set();
function walk(f) {
  if (visited.has(f)) return;
  visited.add(f);
  const rel = path.relative(root, f).split(path.sep).join('/');
  if (rel.includes('node_modules/')) return;
  let src = '';
  try { src = fs.readFileSync(f, 'utf8'); } catch { return; }
  const specs = new Set();
  let m;
  IMP.lastIndex = 0; while ((m = IMP.exec(src))) specs.add(m[1]);
  DYN.lastIndex = 0; while ((m = DYN.exec(src))) specs.add(m[1]);
  for (const s of specs) {
    const r = resolve(s, f);
    if (!r) continue;
    const rr = path.relative(root, r).split(path.sep).join('/');
    if (isLegacy(rr) && !isLegacy(rel)) edges.add(`${rel}  ==>  ${rr}`);
    walk(r);
  }
}
for (const e of ['backend/start.js', 'backend/server.js']) walk(path.resolve(root, e));
console.log('ENTRY EDGES (non-legacy -> legacy):', edges.size);
[...edges].sort().forEach((e) => console.log('  ' + e));
