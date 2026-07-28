/**
 * Artifact composer and gatekeeper for the GrantFlow production audit.
 *
 * Two modes, run as two separate workflow steps:
 *
 *   --compose   fold the lane outputs into audit-summary.json + report.md and
 *               remove every working file that is not part of the contract
 *   (default)   validate: enforce the exact file allowlist, then recursively
 *               scan every byte for credential material and REFUSE the upload
 *               on any hit
 *
 * The validator is the last thing standing between production data and a
 * downloadable ZIP, so it fails CLOSED in every ambiguous case: an unexpected
 * file, an unreadable file, a file that is not the type it claims to be, or any
 * detector hit all block the upload. A redactor bug is survivable; a validator
 * that waves things through is not.
 *
 * It also deliberately re-scans files this script just wrote. Composing and
 * validating in one pass would mean the summary is the one artifact nobody
 * checked, which is exactly where a leak would hide.
 *
 *   node scripts/production-audit/validate-artifact.mjs --compose --out ./audit-out
 *   node scripts/production-audit/validate-artifact.mjs --out ./audit-out
 *   node scripts/production-audit/validate-artifact.mjs --self-test
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecrets, redact } from './redact.mjs';

/** Exactly what the artifact may contain. Anything else blocks the upload. */
const ALLOWED_FILES = new Set([
  'audit-summary.json',
  'database-findings.json',
  'application-findings.json',
  'portal-findings.json',
  'amy-findings.json',
  'report.md',
]);

/** Working files the lanes emit that must be folded in and removed. */
const WORKING_FILES = ['guard.json', 'db-lane-summary.json'];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Compose

function composeReport(outDir) {
  const db = readJson(path.join(outDir, 'database-findings.json'));
  const portal = readJson(path.join(outDir, 'portal-findings.json'));
  const amy = readJson(path.join(outDir, 'amy-findings.json'));
  const app = readJson(path.join(outDir, 'application-findings.json'));
  const guard = readJson(path.join(outDir, 'guard.json'));
  const laneSummary = readJson(path.join(outDir, 'db-lane-summary.json'));

  const screenshotDir = path.join(outDir, 'screenshots');
  const screenshots = fs.existsSync(screenshotDir)
    ? fs.readdirSync(screenshotDir).filter((f) => f.endsWith('.png'))
    : [];

  const allFindings = [...(db?.findings ?? []), ...(portal?.findings ?? [])];
  const withRows = allFindings.filter((f) => f.rowCount > 0);
  const errored = allFindings.filter((f) => f.error);

  const summary = {
    audit: 'grantflow-production-audit',
    generated_at: new Date().toISOString(),
    base_url: db?.base_url ?? app?.base_url ?? null,
    profiles_scoped: db?.profiles_scoped ?? null,
    database_role: db?.role ?? null,
    safety: {
      // Every claim below is backed by a check recorded in guard.json.
      auto_submit_disabled: guard?.posture?.allow_auto_submit === false,
      auto_submit_verified_against_running_process: guard?.posture?.boot_id_matches_live === true,
      db_write_refused: Boolean(
        guard?.checks?.find((c) => c.name === 'write attempt is REFUSED by production')?.pass,
      ),
      db_insert_refused: Boolean(
        guard?.checks?.find((c) => c.name === 'INSERT into a real table is REFUSED')?.pass,
      ),
      sensitive_tables_denied: Boolean(
        guard?.checks?.find((c) => c.name === 'every sensitive table is DENIED')?.pass,
      ),
      session_ciphertext_denied: Boolean(
        guard?.checks?.find((c) => c.name === 'raw session ciphertext is DENIED')?.pass,
      ),
      mutating_requests_blocked: app?.mutations_blocked?.length ?? null,
      red_flag_attempts: app?.red_flag_attempts?.length ?? null,
      mutating_requests_allowed: (app?.mutations_allowed ?? []).map((m) => `${m.method} ${m.why}`),
      portal_reads_permitted: app?.portal_reads?.permitted ?? false,
    },
    counts: {
      findings_total: allFindings.length,
      findings_with_rows: withRows.length,
      findings_errored: errored.length,
      screenshots: screenshots.length,
      console_errors: app?.console_errors?.length ?? null,
      failed_requests: app?.failed_requests?.length ?? null,
    },
    amy: amy?.amy?.counts ?? null,
    lane_timings: laneSummary?.summary ?? null,
    findings_index: allFindings.map((f) => ({
      id: f.id,
      requirement: f.requirement,
      rows: f.rowCount,
      error: f.error,
    })),
  };

  fs.writeFileSync(path.join(outDir, 'audit-summary.json'), JSON.stringify(redact(summary), null, 2));

  // ---- report.md ---------------------------------------------------------
  const L = [];
  L.push('# GrantFlow production audit');
  L.push('');
  L.push(`Generated: ${summary.generated_at}`);
  L.push(`Target: ${summary.base_url ?? 'unknown'}`);
  L.push(`Database role: ${summary.database_role ?? 'unknown'}`);
  L.push(
    `Profiles scoped: ${Array.isArray(summary.profiles_scoped) ? summary.profiles_scoped.join(', ') : 'all real profiles'}`,
  );
  L.push('');
  L.push('## What this artifact is, and what it is not');
  L.push('');
  L.push(
    'Everything here was produced by a READ ONLY transaction on a non-superuser, expiring database role, ' +
      'plus an authenticated browser session whose network layer denied every mutating request by default. ' +
      'No production row was created, changed, or deleted. No application was submitted.',
  );
  L.push('');
  L.push(
    'A finding that returned zero rows means the query found nothing — it does NOT by itself mean the ' +
      'condition is absent, only that this query could not see it. Errored findings are listed explicitly below.',
  );
  L.push('');
  L.push('## Safety verification');
  L.push('');
  L.push('| Control | Result |');
  L.push('| --- | --- |');
  L.push(`| HAMILTON_ALLOW_AUTOSUBMIT disabled | ${summary.safety.auto_submit_disabled ? 'verified' : 'NOT VERIFIED'} |`);
  L.push(
    `| ...in the process actually serving traffic | ${summary.safety.auto_submit_verified_against_running_process ? 'verified (boot id matched)' : 'NOT VERIFIED'} |`,
  );
  L.push(`| Production DB write refused | ${summary.safety.db_write_refused ? 'verified' : 'NOT VERIFIED'} |`);
  L.push(`| Production DB INSERT refused | ${summary.safety.db_insert_refused ? 'verified' : 'NOT VERIFIED'} |`);
  L.push(`| Sensitive tables denied | ${summary.safety.sensitive_tables_denied ? 'verified' : 'NOT VERIFIED'} |`);
  L.push(`| Session ciphertext denied | ${summary.safety.session_ciphertext_denied ? 'verified' : 'NOT VERIFIED'} |`);
  L.push(`| Mutating requests blocked | ${summary.safety.mutating_requests_blocked ?? 'n/a'} |`);
  L.push(`| Red-flag attempts | ${summary.safety.red_flag_attempts ?? 'n/a'} |`);
  L.push(`| Portal reads permitted this run | ${summary.safety.portal_reads_permitted ? 'yes' : 'no'} |`);
  L.push('');
  L.push('Mutating requests that WERE allowed (each requires a justification):');
  L.push('');
  for (const m of summary.safety.mutating_requests_allowed) L.push(`- ${m}`);
  if (!summary.safety.mutating_requests_allowed.length) L.push('- none');
  L.push('');

  L.push('## Findings');
  L.push('');
  L.push('| # | Requirement | Rows | Status |');
  L.push('| --- | --- | --- | --- |');
  allFindings.forEach((f, i) => {
    L.push(`| ${i + 1} | ${f.requirement} | ${f.rowCount} | ${f.error ? `ERROR: ${f.error}` : 'ok'} |`);
  });
  L.push('');

  for (const f of allFindings) {
    L.push(`### ${f.requirement}`);
    L.push('');
    L.push(f.question);
    L.push('');
    L.push(`Rows: **${f.rowCount}**${f.error ? ` — ERRORED: ${f.error}` : ''}`);
    L.push('');
  }

  L.push('## Amy');
  L.push('');
  if (amy?.amy) {
    const c = amy.amy.counts ?? {};
    L.push(`- Latest report run id: ${c.run_id ?? 'unknown'}`);
    L.push(`- Profiles evaluated: ${c.evaluated ?? 'unknown'}`);
    L.push(`- Clean: ${c.clean ?? 'unknown'}`);
    // Labelled "derived" on purpose: Amy records no single issue-count field,
    // so this is evaluated - clean, not a number she reported.
    L.push(`- Issues (derived = evaluated - clean): ${c.issues_derived ?? 'unknown'}`);
    L.push(`- Weak / zero / errored: ${c.weak ?? '?'} / ${c.zero ?? '?'} / ${c.errored ?? '?'}`);
    L.push(`- False-positive rate: ${c.false_positive_rate ?? 'unknown'}`);
    L.push(`- Operating floor: ${c.current_floor ?? 'unknown'}`);
    L.push(`- Duplicate runs detected: ${amy.amy.duplicate_runs?.length ?? 0}`);
    L.push(`- Report last written: ${amy.amy.report_updated_at ?? 'unknown'}`);
  } else {
    L.push('- Amy findings unavailable.');
  }
  L.push('');

  L.push('## Application lane');
  L.push('');
  if (app) {
    L.push(`- Signed in: ${app.signed_in ? 'yes' : 'no'}`);
    L.push(`- Account is admin: ${app.account?.is_admin ?? 'unknown'}`);
    L.push(`- Profiles visible to the audit account: ${app.account?.accessible_profile_count ?? 'unknown'}`);
    L.push(`- Console errors: ${app.console_errors?.length ?? 0}`);
    L.push(`- Failed requests: ${app.failed_requests?.length ?? 0}`);
    L.push(`- Screenshots: ${screenshots.length}`);
    L.push('');
    if (app.portal_reads?.results?.length) {
      L.push('### Portal reads');
      L.push('');
      L.push('| Portal host | Profile | Outcome |');
      L.push('| --- | --- | --- |');
      for (const r of app.portal_reads.results) {
        L.push(`| ${r.portal_host} | ${r.profile_id} | ${r.outcome} |`);
      }
      L.push('');
    }
  } else {
    L.push('- Application lane produced no output.');
  }

  L.push('## Screenshots');
  L.push('');
  for (const s of screenshots) L.push(`- screenshots/${s}`);
  if (!screenshots.length) L.push('- none captured');
  L.push('');

  fs.writeFileSync(path.join(outDir, 'report.md'), L.join('\n'));

  // Remove the working files so the artifact matches its contract exactly.
  for (const f of WORKING_FILES) {
    const p = path.join(outDir, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  console.log('composed audit-summary.json and report.md');
  console.log(`folded and removed working files: ${WORKING_FILES.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Validate

function walk(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) walk(full, base, acc);
    else acc.push({ full, rel });
  }
  return acc;
}

function validate(outDir) {
  const problems = [];
  if (!fs.existsSync(outDir)) {
    console.error(`FATAL: ${outDir} does not exist`);
    process.exit(2);
  }

  const files = walk(outDir);
  if (!files.length) problems.push('artifact directory is EMPTY — nothing to upload');

  let scanned = 0;
  let bytes = 0;

  for (const { full, rel } of files) {
    // 1. Allowlist.
    const isScreenshot = /^screenshots\/[^/]+\.png$/.test(rel);
    if (!ALLOWED_FILES.has(rel) && !isScreenshot) {
      problems.push(`DISALLOWED FILE in artifact: ${rel}`);
      continue;
    }

    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch (err) {
      problems.push(`UNREADABLE FILE (failing closed): ${rel} — ${err.message}`);
      continue;
    }
    bytes += buf.length;

    // 2. A screenshot must really be a PNG — a text file renamed .png would
    //    otherwise skip the content scan entirely.
    if (isScreenshot) {
      if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
        problems.push(`NOT A REAL PNG (failing closed): ${rel}`);
      }
      continue;
    }

    // 3. Content scan.
    const text = buf.toString('utf8');
    scanned += 1;
    const hits = findSecrets(text, { where: rel });
    for (const h of hits) {
      problems.push(`SECRET in ${rel}: rule=${h.rule}${h.key ? ` key=${h.key}` : ''} — ${h.excerpt}`);
    }
  }

  // 4. Required files must be present.
  const present = new Set(files.map((f) => f.rel));
  for (const required of ALLOWED_FILES) {
    if (!present.has(required)) problems.push(`MISSING required file: ${required}`);
  }

  console.log(`files: ${files.length}  text files scanned: ${scanned}  total bytes: ${bytes}`);

  if (problems.length) {
    console.error(`\nARTIFACT REJECTED — ${problems.length} problem(s):`);
    problems.forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }
  console.log('Artifact validated: file allowlist satisfied, no credential material found.');
}

// ---------------------------------------------------------------------------
// Self-test: prove the validator REJECTS planted secrets and ACCEPTS a clean
// artifact. A validator only ever run against clean input is untested.

function selfTest() {
  const failures = [];

  const mkArtifact = (extra = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-audit-selftest-'));
    fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'screenshots', 'a.png'), PNG_MAGIC);
    for (const f of ALLOWED_FILES) {
      if (f === 'report.md') {
        fs.writeFileSync(
          path.join(dir, f),
          '# report\n\nThe password field was not accessed. No session token was exported.\n',
        );
      } else {
        fs.writeFileSync(path.join(dir, f), JSON.stringify({ ok: true, note: 'cookie banner dismissed' }, null, 2));
      }
    }
    for (const [name, content] of Object.entries(extra)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  };

  // Run validate() in a child-free way by capturing process.exit.
  const runValidate = (dir) => {
    const realExit = process.exit;
    const realErr = console.error;
    const realLog = console.log;
    let code = 0;
    process.exit = (c) => {
      code = c ?? 0;
      throw new Error('__exit__');
    };
    console.error = () => {};
    console.log = () => {};
    try {
      validate(dir);
    } catch (err) {
      if (err.message !== '__exit__') throw err;
    } finally {
      process.exit = realExit;
      console.error = realErr;
      console.log = realLog;
    }
    return code;
  };

  // 1. A clean artifact must PASS. Without this, a deny-everything validator
  //    would look perfect while making the bridge unusable.
  const clean = mkArtifact();
  if (runValidate(clean) !== 0) failures.push('clean artifact was REJECTED (false positive)');

  // 2. Planted secrets must each be REJECTED.
  const PLANTS = {
    'database url': {
      'report.md': '# report\n\nconn: postgresql://grantflow_auditor:hunter2secret@x.rlwy.net:5432/railway\n',
    },
    'jwt': {
      'audit-summary.json':
        '{"t":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"}',
    },
    'password value': { 'report.md': '# report\n\npassword: Sup3rS3cretValue123\n' },
    'storage state blob': {
      'application-findings.json': '{"storageState":"eyJjb29raWVzIjpbeyJuYW1lIjoic2Vzc2lvbiJ9XX0abcdef"}',
    },
    'bearer token': { 'report.md': '# report\n\nAuthorization: Bearer sk-live-9f8a7b6c5d4e3f2a1b0c\n' },
    'private key': { 'report.md': '# r\n\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n' },
    'disallowed file': { '.env.local': 'GRANTFLOW_AUDIT_PASSWORD=abc123456789' },
    'fake png': { 'screenshots/evil.png': 'this is not a png, it is text with password: Sup3rS3cret123' },
  };

  for (const [name, extra] of Object.entries(PLANTS)) {
    const dir = mkArtifact(extra);
    if (runValidate(dir) === 0) failures.push(`planted "${name}" was ACCEPTED — validator failed to reject it`);
  }

  // 3. A missing required file must be rejected.
  const missing = mkArtifact();
  fs.rmSync(path.join(missing, 'report.md'));
  if (runValidate(missing) === 0) failures.push('missing report.md was ACCEPTED');

  const total = 1 + Object.keys(PLANTS).length + 1;
  console.log(`${total - failures.length}/${total} validator self-tests passed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('Validator verified: rejects planted secrets, accepts a clean artifact.');
}

// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  const i = argv.indexOf('--out');
  const outDir = i >= 0 && argv[i + 1] ? argv[i + 1] : path.join(process.cwd(), 'audit-out');

  if (argv.includes('--compose')) return composeReport(outDir);
  return validate(outDir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
