import 'dotenv/config';
import process from 'process';

const API_URL = (process.env.API_URL || process.env.VITE_API_URL || 'http://localhost:8080').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || '';

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [k, ...rest] = raw.slice(2).split('=');
    out[k] = rest.join('=') || true;
  }
  return out;
}

function usage(exitCode = 1) {
  // eslint-disable-next-line no-console
  console.log(
    [
      'Geo Crawl (admin) — queues crawler_jobs.type="comprehensive" with parameters.mode="geo".',
      '',
      'Usage:',
      '  node scripts/geo-crawl.mjs --state=OH [--min_sources_per_zip=3] [--zips=43004,43005] [--counties=Franklin]',
      '',
      'Env:',
      '  API_URL=http://localhost:8080',
      '  ADMIN_TOKEN=...  (or ANYA_ADMIN_TOKEN)',
    ].join('\n'),
  );
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
const state = args.state ? String(args.state).toUpperCase() : '';

if (!state) usage(1);
if (!ADMIN_TOKEN) {
  // eslint-disable-next-line no-console
  console.error('Missing ADMIN_TOKEN (or ANYA_ADMIN_TOKEN).');
  usage(1);
}

const payload = {
  state,
};

if (args.min_sources_per_zip) payload.min_sources_per_zip = Number(args.min_sources_per_zip) || 3;
if (args.zips) payload.zips = String(args.zips).split(',').map((s) => s.trim()).filter(Boolean);
if (args.counties) payload.counties = String(args.counties).split(',').map((s) => s.trim()).filter(Boolean);

const res = await fetch(`${API_URL}/api/admin/geo/crawl/start`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Admin-Token': ADMIN_TOKEN,
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  json = { raw: text };
}

if (!res.ok) {
  // eslint-disable-next-line no-console
  console.error('Geo crawl failed:', res.status, json);
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log(JSON.stringify(json, null, 2));

