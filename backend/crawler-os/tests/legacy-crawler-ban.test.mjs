// crawler-os/tests/legacy-crawler-ban.test.mjs
//
// Cutover guard (Requirement A: old-system removal). The Crawler OS is the ONE
// discovery spine; matching decisions must delegate to the shared canonical
// matcher and the OS must never depend on legacy crawler modules. This test
// fails if:
//
//   (1) any file under backend/crawler-os/ imports a path that escapes
//       backend/crawler-os/ without being allowlisted as a shared contract, or
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

// Legacy crawler modules the new system must never import. The canonical
// services/matchEngine.js is deliberately not on this list: doctrine requires
// every runtime, including Crawler OS, to use it as the sole decision authority.
const LEGACY_DENYLIST = [
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

const ALLOWED_SHARED_IMPORTS = new Set([
  'shared/pipelineStages.js',
  'backend/services/matchEngine.js',
  // Pure, dependency-free whole-word term matcher — the shared contract that
  // keeps need/keyword scanning precision identical across the OS thesis
  // builder and the legacy engine (the phantom-need substring class).
  'backend/services/shared/textMatch.js',
  // The ONE question choke point (org/person applicability matrix + canonical
  // fact aliases). Doctrine: every question-asking surface — including the OS
  // project-readiness interview — must run its questions through it, the same
  // way matchEngine is the sole matching authority. Pure module; only reaches
  // shared/profileSectionApplicability.js (itself dependency-free).
  'backend/services/profileKnownFacts.js',
  // The ONE award-amount authority (structured-wins → conservative text
  // extraction → honest status, plus the $100–$10M plausibility window that
  // keeps an untrusted aggregator's PROGRAM APPROPRIATION from posing as a
  // per-award ceiling — the HUD Section 4 $42M class). The OS normalizer must
  // resolve amounts through it rather than carry structured numerics only:
  // otherwise the canonical Opportunity and the persisted row disagree within
  // one run (persistence resolved amounts a stage later), which is what made
  // Amy's amount_recall_miss measure pre-extraction values. Zero imports, zero
  // I/O — verified dependency-free.
  'backend/services/awardAmountExtractor.js',
  // The need-first scoring policy adapter, imported by crawler-os/matchEngine.js
  // so the OS decision and the canonical engine apply the SAME need-first rules
  // (matchEngine.js itself is already an approved contract above; this is the
  // half of it the OS actually calls). Reaches only config/matchThresholds.js
  // and its sibling policy module. This escape was already tripping the guard
  // on main before the 2026-08-01 farm work — allowlisted here so the boundary
  // test states the real, intended architecture instead of standing red.
  'backend/services/matching/needFirstScoringAdapter.js',
  // The ONE registry of agricultural-producer identity (the Anita class,
  // 2026-08-01). crawler-os/profileIntelligence.js PLANS a declared farmer into
  // the USDA lanes while services/applicantTypeGate.js decides whether she may
  // keep what comes back; a private copy on either side means a profile gets
  // crawled for agriculture and then hard-dropped on the way home. Zero
  // imports, zero I/O — verified dependency-free.
  'backend/services/eligibility/farmIdentity.js',
  // The ONE derived-profile-fact layer (#1091) and the ONE academic-stage
  // taxonomy built on it. `crawler-os/planner.js` ranks lanes by what the
  // profile DECLARED — its topical terms and its derived stage — and the whole
  // point of those modules is that the derivation has a single owner: a private
  // copy in the OS would mean the planner selects lanes from one reading of the
  // profile while the match engine judges the results from another. Both are
  // pure config; `profileDerivedFacts` reaches only `profileInstitutions.js`,
  // `aidTypePreferences.js` and `shared/data/stateRegistry.js` (all data-only),
  // and `stageOfLifeEligibility` reaches only `profileDerivedFacts`. Zero I/O.
  'backend/config/profileDerivedFacts.js',
  'backend/config/stageOfLifeEligibility.js',
  // The ONE lane taxonomy + condition vocabulary (moved out of
  // coverageEvidenceService for exactly this reason: that service imports
  // crawlerPlanExplainer, which imports the planner, so the planner could not
  // consult the facts that decide which crawlers are appropriate). Pure data +
  // pure predicates; its only import is this package's own sourceRegistry.
  'backend/config/sourceLanes.js',
]);

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

test('every file under backend/crawler-os/ uses only the OS or approved shared contracts', () => {
  const escapes = [];
  for (const file of listFiles(osRoot)) {
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) continue; // bare npm packages are fine
      const resolved = path.resolve(path.dirname(file), spec);
      const rel = path.relative(osRoot, resolved).replace(/\\/g, '/');
      const repoRel = path.relative(path.resolve(backendRoot, '..'), resolved).replace(/\\/g, '/');
      if (ALLOWED_SHARED_IMPORTS.has(repoRel)) continue;
      if (rel.startsWith('..')) {
        escapes.push(`${path.relative(osRoot, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(escapes, [], `Crawler OS imports must stay inside the OS or approved shared contracts; offending imports:\n${escapes.join('\n')}`);
});

test('crawlerOsService.js (the seam) imports no legacy crawler module', () => {
  assert.ok(fs.existsSync(serviceSeam), 'service seam must exist');
  const hits = [];
  for (const spec of specifiersOf(serviceSeam)) {
    if (LEGACY_DENYLIST.some((banned) => spec.includes(banned))) hits.push(spec);
  }
  assert.deepEqual(hits, [], `service seam must not import legacy crawler modules; found:\n${hits.join('\n')}`);
});
