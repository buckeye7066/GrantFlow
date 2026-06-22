// crawler-os/tests/legacy-crawler-ban.test.mjs
//
// Cutover guard (Requirement A — old-system removal). The Crawler OS is the ONE
// discovery/matching authority; it must never depend on any legacy crawler
// module. This test fails if:
//
//   (1) any file under backend/crawler-os/ imports a path that escapes
//       backend/crawler-os/ (self-containment — the new OS is an island), or
//   (2) the public service seam backend/services/crawlerOsService.js imports a
//       known legacy crawler module (it may only reach ../crawler-os/, ../db/,
//       and node: builtins).
//
// When the live routes are fully cut over, the repo-wide complement of this
// guard (scripts/check-runtime-imports.mjs) flips on to assert that NOTHING in
// the backend runtime import graph reaches a legacy crawler module either.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const osRoot = path.resolve(path.dirname(__filename), '..');            // backend/crawler-os
const backendRoot = path.resolve(osRoot, '..');                        // backend
const serviceSeam = path.join(backendRoot, 'services', 'crawlerOsService.js');

const IMPORT_RE = /(?:^|\s|;|\()\s*(?:import|export)\s+(?:[\s\S]*?\bfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Legacy crawler/matching modules the new system must never import.
const LEGACY_DENYLIST = [
  'services/matchEngine',
  'services/opportunityMatcher',
  'services/opportunityNormalizer',
  'services/comprehensiveCrawler',
  'services/crawlerDispatcher',
  'services/crawlerManager',
  'services/crawlerFramework',
  'services/autoDiscoveryCrawlers',
  'services/scheduledAutoDiscovery',
  'services/anyaAutonomousCrawler',
  'services/grantsDotGovCrawler',
  'services/localCrawler',
  'services/crawlers/',
  'config/matchThresholds',
  'config/relevanceFloor',
];

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function specifiersOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const specs = new Set();
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) !== null) specs.add(m[1]);
  DYNAMIC_RE.lastIndex = 0;
  while ((m = DYNAMIC_RE.exec(src)) !== null) specs.add(m[1]);
  return [...specs];
}

test('every file under backend/crawler-os/ is self-contained (no import escapes the OS)', () => {
  const escapes = [];
  for (const file of listFiles(osRoot)) {
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) continue; // bare npm packages are fine
      const resolved = path.resolve(path.dirname(file), spec);
      const rel = path.relative(osRoot, resolved).replace(/\\/g, '/');
      if (rel.startsWith('..')) {
        escapes.push(`${path.relative(osRoot, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(escapes, [], `Crawler OS must be self-contained; offending imports:\n${escapes.join('\n')}`);
});

test('crawlerOsService.js (the seam) imports no legacy crawler module', () => {
  assert.ok(fs.existsSync(serviceSeam), 'service seam must exist');
  const hits = [];
  for (const spec of specifiersOf(serviceSeam)) {
    if (LEGACY_DENYLIST.some((banned) => spec.includes(banned))) hits.push(spec);
  }
  assert.deepEqual(hits, [], `service seam must not import legacy crawler modules; found:\n${hits.join('\n')}`);
});
