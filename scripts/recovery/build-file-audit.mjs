#!/usr/bin/env node
// Recovery audit ledger generator (survival directive §4.2/§4.4).
// Produces docs/recovery/FILE_AUDIT.csv from `git ls-files` at the current HEAD,
// merging inspection state from any existing ledger so re-runs never lose review work.
// Verify mode (--verify) fails non-zero when the tree has drifted from the ledger.
//
// FILE_AUDIT.csv is deliberately excluded from its own inventory. Generate it from a
// clean source commit, then commit only the ledger. Verification accepts that exact
// ledger-only child commit while continuing to reject any other source drift.
//
// Usage:
//   node scripts/recovery/build-file-audit.mjs            # (re)generate, preserving inspected/findings columns
//   node scripts/recovery/build-file-audit.mjs --verify   # reconciliation gate: exit 1 on any drift
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
const headSha = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
const ledgerPath = path.join(repoRoot, 'docs', 'recovery', 'FILE_AUDIT.csv');
const ledgerRelativePath = 'docs/recovery/FILE_AUDIT.csv';
const verifyMode = process.argv.includes('--verify');

function nonLedgerWorktreeDrift() {
  return execFileSync('git', [
    'status', '--porcelain=v1', '--untracked-files=all', '--', '.',
    `:(exclude)${ledgerRelativePath}`,
  ], { cwd: repoRoot, maxBuffer: 1 << 24 }).toString().trim();
}

const sourceDrift = nonLedgerWorktreeDrift();
if (sourceDrift) {
  console.error('FILE_AUDIT requires a clean committed source tree; only the ledger itself may be uncommitted.');
  process.exit(1);
}

// --- enumerate tracked files with blob SHAs (NUL-safe) ---
const lsRaw = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: repoRoot, maxBuffer: 1 << 26 }).toString();
const entries = lsRaw.split('\0').filter(Boolean).map((line) => {
  const tab = line.indexOf('\t');
  const [mode, blob] = line.slice(0, tab).split(' ');
  return { mode, blob, path: line.slice(tab + 1) };
}).filter((entry) => entry.path !== ledgerRelativePath);

// --- binary detection + line counts from the empty-tree diff (matches git's own heuristic) ---
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const numstat = execFileSync('git', ['diff', '--numstat', '-z', EMPTY_TREE, 'HEAD'], { cwd: repoRoot, maxBuffer: 1 << 26 }).toString();
const lineCounts = new Map();
{
  const parts = numstat.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const m = parts[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
    if (!m) continue;
    if (m[3] === '') { // rename/quoted form: path follows in next part
      lineCounts.set(parts[i + 1], m[1] === '-' ? null : Number(m[1]));
      i += 1;
    } else {
      lineCounts.set(m[3], m[1] === '-' ? null : Number(m[1]));
    }
  }
}

function classify(p) {
  const lower = p.toLowerCase();
  if (/^(docs|memory)\//.test(p) || /\.(md|txt)$/i.test(p)) return 'documentation';
  if (/^backend\/db\/migrations\//.test(p) || /^backend\/db\/postgres\/migrations\//.test(p)) return 'migration';
  if (/(^|\/)(tests?|__tests__|fixtures)\//.test(lower) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) return 'test';
  if (/^scripts\//.test(p) || /^tools\//.test(p)) return 'script';
  if (/^\.(github|claude|cursor|vscode)\//.test(p)) return 'configuration';
  if (/(^|\/)(package(-lock)?\.json|tsconfig|vite\.config|vercel\.json|railway\.json|dockerfile|\.dockerignore|eslint|\.env\.example)/.test(lower)) return 'configuration';
  if (/\.(sql)$/.test(lower)) return 'schema';
  if (/\.(png|jpe?g|gif|ico|woff2?|ttf|eot|pdf|zip|docx|xlsx|mp[34])$/.test(lower)) return 'asset';
  if (/^(src|backend|shared|public|android|ios)\//.test(p)) return 'source';
  return 'other';
}
function subsystem(p) {
  if (/^backend\/crawler-os\//.test(p)) return 'crawler-os';
  if (/^backend\/services\/amy\//.test(p)) return 'amy';
  if (/^backend\/services\/hamilton\//.test(p) || /hamilton/i.test(p)) return 'hamilton';
  if (/^backend\/(routes|middleware)\//.test(p)) return 'api';
  if (/^backend\/(db|migrations)\//.test(p) || /^backend\/db\//.test(p)) return 'database';
  if (/^backend\/startup\//.test(p)) return 'boot';
  if (/^backend\//.test(p)) return 'backend';
  if (/^src\//.test(p)) return 'frontend';
  if (/^shared\//.test(p)) return 'shared';
  if (/^scripts\/source-materialization\//.test(p) || /materialize/.test(p)) return 'materialization';
  if (/^scripts\//.test(p)) return 'ops-scripts';
  if (/^docs\//.test(p)) return 'docs';
  if (/^\.github\//.test(p)) return 'ci';
  if (/^(android|ios)\//.test(p)) return 'mobile';
  return 'root';
}

// --- preserve prior inspection state ---
const prior = new Map();
if (existsSync(ledgerPath)) {
  const rows = readFileSync(ledgerPath, 'utf8').split('\n').slice(1).filter(Boolean);
  for (const row of rows) {
    const cols = parseCsvRow(row);
    if (cols) prior.set(cols[0], cols);
  }
}
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
  return out.length >= 12 ? out : null;
}
const esc = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v);

// --- build rows ---
const header = ['path', 'blob_sha', 'sha256', 'bytes', 'lines', 'binary', 'category', 'subsystem', 'inspected', 'findings', 'disposition', 'evidence', 'audit_head_sha'];
const drift = [];
const out = [header.join(',')];
for (const e of entries) {
  const abs = path.join(repoRoot, e.path);
  let bytes = 0; let sha256 = '';
  try {
    const buf = readFileSync(abs);
    bytes = buf.length;
    // EOL-normalized so the hash is checkout-independent: git may materialize
    // the same blob as CRLF or LF depending on filters/tools, and a raw hash
    // would fire false RE-REVIEW drift between two clean checkouts of one SHA.
    const isText = lineCounts.get(e.path) !== null;
    const hashInput = isText ? buf.toString('latin1').replaceAll('\r\n', '\n') : buf;
    sha256 = createHash('sha256').update(hashInput, isText ? 'latin1' : undefined).digest('hex');
  } catch {
    sha256 = 'UNREADABLE';
  }
  const lines = lineCounts.get(e.path);
  const binary = lines === null || lines === undefined ? (lines === null ? 'binary' : 'unknown') : 'text';
  const old = prior.get(e.path);
  let inspected = 'no'; let findings = ''; let disposition = ''; let evidence = '';
  if (old) {
    // hash changed since review → inspection is stale, reset to 'no' and record drift
    if (old[8] === 'yes' && old[2] !== sha256) { drift.push(`RE-REVIEW (content changed since inspection): ${e.path}`); }
    else { inspected = old[8]; findings = old[9]; disposition = old[10]; evidence = old[11]; }
  }
  out.push([e.path, e.blob, sha256, bytes, lines ?? '', binary, classify(e.path), subsystem(e.path), inspected, findings, disposition, evidence, headSha].map(esc).join(','));
}
for (const p of prior.keys()) {
  if (!entries.some((e) => e.path === p)) drift.push(`REMOVED from tree but present in ledger: ${p}`);
}
const newFiles = entries.filter((e) => !prior.has(e.path));

if (verifyMode) {
  const problems = [];
  if (!existsSync(ledgerPath)) problems.push('ledger missing');
  if (prior.size !== entries.length) problems.push(`row count ${prior.size} != tracked ${entries.length}`);
  const recordedSourceShas = new Set([...prior.values()].map((c) => c[12]).filter(Boolean));
  if (recordedSourceShas.size !== 1) {
    problems.push(`ledger must record exactly one source SHA (found ${recordedSourceShas.size})`);
  } else {
    const [recordedSourceSha] = recordedSourceShas;
    let sourceShaAccepted = recordedSourceSha === headSha;
    if (!sourceShaAccepted) {
      try {
        const parentSha = execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: repoRoot }).toString().trim();
        const changedPaths = execFileSync('git', [
          'diff', '--name-only', '--no-renames', `${recordedSourceSha}..${headSha}`,
        ], { cwd: repoRoot }).toString().trim().split('\n').filter(Boolean);
        sourceShaAccepted = recordedSourceSha === parentSha
          && changedPaths.length === 1
          && changedPaths[0] === ledgerRelativePath;
      } catch {
        sourceShaAccepted = false;
      }
    }
    if (!sourceShaAccepted) {
      problems.push(`ledger source ${recordedSourceSha.slice(0, 8)} is neither HEAD nor its ledger-only parent ${headSha.slice(0, 8)}`);
    }
  }
  problems.push(...drift);
  if (prior.size && newFiles.length) problems.push(`${newFiles.length} tracked file(s) missing from ledger`);
  if (problems.length) {
    console.error('FILE_AUDIT reconciliation FAILED:');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  const uninspected = [...prior.values()].filter((c) => c[8] !== 'yes' && c[5] === 'text').length;
  console.log(`FILE_AUDIT reconciles: ${entries.length} tracked source files = ${prior.size} rows; uninspected readable: ${uninspected}`);
  process.exit(0);
}

mkdirSync(path.dirname(ledgerPath), { recursive: true });
writeFileSync(ledgerPath, out.join('\n') + '\n');
const inspectedCount = out.slice(1).filter((r) => parseCsvRow(r)?.[8] === 'yes').length;
console.log(`wrote ${entries.length} rows @ ${headSha.slice(0, 8)}; inspected=${inspectedCount}; drift notes=${drift.length}`);
for (const d of drift) console.log('  ' + d);
