// scripts/lint.mjs
// Dependency-free "lint": syntax-check every .js/.mjs file via `node --check`.
// Not a style linter — a fast, honest guarantee that every module parses.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT).sort();
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed += 1;
    console.error(`SYNTAX FAIL: ${f.replace(ROOT, '')}`);
    console.error(String(e.stderr ?? e.message));
  }
}

if (failed) {
  console.error(`\n[lint] ${failed} file(s) failed to parse`);
  process.exit(1);
}
console.log(`[lint] OK — ${files.length} files parse cleanly`);
