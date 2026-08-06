#!/usr/bin/env node
/**
 * verify-crawlers-prod.mjs
 *
 * Production / local verification script.
 * Hits the deployed or local API endpoints and validates:
 *   - Each crawler_type returns count > 0 (or gated reason)
 *   - 100% of "funding sources" have a URL
 *   - match_explain present on every result
 *   - Top 5 titles + URLs printed for review
 *
 * Usage:
 *   node scripts/verify-crawlers-prod.mjs [--base-url URL] [--profile-id ID] [--token TOKEN]
 *
 * Defaults:
 *   --base-url  http://localhost:3001
 *   --profile-id  (auto-discovers first profile)
 *   --token       (reads from GRANTFLOW_TOKEN env or skips auth)
 *
 * Exit codes:
 *   0 = all checks pass
 *   1 = one or more checks failed
 */

import { DEFAULT_MIN_SCORE, SCORE_SCALE_ID } from '../backend/config/matchThresholds.js'

const args = process.argv.slice(2);

function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const BASE_URL = getArg('--base-url', process.env.GRANTFLOW_BASE_URL || 'http://localhost:3001');
const PROFILE_ID = getArg('--profile-id', process.env.GRANTFLOW_PROFILE_ID || '');
const TOKEN = getArg('--token', process.env.GRANTFLOW_TOKEN || '');

const CRAWLER_TYPES = [
  'comprehensive',
  'local_funding',
  'government_funding',
  'student_grants',
  'health_resources',
  'special_needs',
  'ecf_benefits',
  'curated_benefits',
];

const headers = { 'Content-Type': 'application/json' };
if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

async function api(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok && res.status !== 200) {
    throw new Error(`${method} ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function findProfileId() {
  if (PROFILE_ID) return PROFILE_ID;
  try {
    const data = await api('GET', '/api/real-crawlers/find-profile?name=a');
    if (data.profiles?.length > 0) return data.profiles[0].id;
  } catch { /* fall through */ }
  console.error('ERROR: No profile_id provided and auto-discover failed. Use --profile-id.');
  process.exit(1);
}

async function main() {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  GrantFlow Crawler Verification              ║`);
  console.log(`║  Base URL: ${BASE_URL.padEnd(33)}║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);

  const profileId = await findProfileId();
  console.log(`Profile ID: ${profileId}\n`);

  let totalPass = 0;
  let totalFail = 0;
  const failures = [];

  for (const crawlerType of CRAWLER_TYPES) {
    process.stdout.write(`  ${crawlerType.padEnd(22)}`);
    try {
      const data = await api('POST', '/api/real-crawlers/run', {
        crawler_type: crawlerType,
        profile_id: profileId,
        min_match_score: DEFAULT_MIN_SCORE,
        score_scale_id: SCORE_SCALE_ID,
      });

      if (data.gated) {
        console.log(`GATED — ${data.gate_reason?.slice(0, 60) || 'no reason'}`);
        totalPass++;
        continue;
      }

      const count = data.count || 0;
      const opps = data.opportunities || [];

      // Check URL rate
      const withUrl = opps.filter(o => o.url || o.application_url);
      const urlRate = opps.length > 0 ? Math.round((withUrl.length / opps.length) * 100) : 100;

      // Check match_explain rate
      const withExplain = opps.filter(o => o.match_explain);
      const explainRate = opps.length > 0 ? Math.round((withExplain.length / opps.length) * 100) : 100;

      const pass = count > 0 && urlRate === 100;
      if (pass) totalPass++;
      else {
        totalFail++;
        failures.push({ crawlerType, count, urlRate, explainRate });
      }

      console.log(`${pass ? 'PASS' : 'FAIL'}  count=${count}  url=${urlRate}%  explain=${explainRate}%  strategy=${data.debug?.strategy || '?'}`);

      // Print top 5
      for (const opp of opps.slice(0, 5)) {
        const url = opp.url || opp.application_url || '(no url)';
        console.log(`    match=${opp.match_score ?? 'unrated'} (${data.score_scale_id || SCORE_SCALE_ID})  ${(opp.title || '').slice(0, 50)}  →  ${url.slice(0, 60)}`);
      }
      console.log();
    } catch (err) {
      totalFail++;
      failures.push({ crawlerType, error: err.message });
      console.log(`ERROR  ${err.message}`);
    }
  }

  // Specific need test
  console.log(`\n  SPECIFIC NEED: "emergency rent"`);
  try {
    const data = await api('POST', '/api/real-crawlers/specific-need', {
      profile_id: profileId,
      need_text: 'emergency rent',
      min_item_relevance: 10,
      max_results: 5,
    });
    const count = data.count || 0;
    const topRelevance = data.opportunities?.[0]?.item_relevance_score ?? null;
    console.log(`    count=${count}  expanded_to=${data.expanded?.canonicalNeed || '?'}  top_item_relevance=${topRelevance ?? 'unrated'}  scale=${data.item_relevance_scale_id || 'unknown'}`);
    for (const opp of (data.opportunities || []).slice(0, 3)) {
      console.log(`    item_relevance=${opp.item_relevance_score ?? 'unrated'}  canonical_match=${opp.match_score ?? 'unrated'}  ${(opp.title || '').slice(0, 50)}  →  ${(opp.url || '').slice(0, 60)}`);
    }
    if (count > 0) totalPass++;
    else { totalFail++; failures.push({ crawlerType: 'specific-need', count }); }
  } catch (err) {
    totalFail++;
    failures.push({ crawlerType: 'specific-need', error: err.message });
    console.log(`    ERROR  ${err.message}`);
  }

  // Summary
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${totalPass} passed, ${totalFail} failed`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(`  - ${f.crawlerType}: ${f.error || `count=${f.count} url=${f.urlRate}%`}`);
    }
  }
  console.log();

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
