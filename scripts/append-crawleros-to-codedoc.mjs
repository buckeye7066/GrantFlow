// One-off: append the Crawler OS cutover files to "Code for GrantFlow.docx" so
// the generated full-repo export reflects the new code. Preserves the existing
// document; inserts new paragraphs (one per line, matching the export's
// `<w:p>`-per-line style) before the body-level <w:sectPr>.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const DOCX = 'G:/One Drive/Desktop/Code for GrantFlow.docx';
const REPO = path.resolve(process.cwd());

// Files added or modified during the cutover (relative to repo root).
// backend/crawler-os/ is still untracked, so walk the filesystem (not git).
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out.sort();
}
const ADDED = [
  ...walk('backend/crawler-os'),
  'backend/services/crawlerOsService.js',
  'backend/db/migrations/121_crawler_os_canonical_dedup.sql',
  'backend/db/postgres/migrations/0122_crawler_os_canonical_dedup.sql',
];
const MODIFIED = ['package.json', 'eslint.config.js'];

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function para(text) {
  // xml:space=preserve keeps leading indentation in code lines.
  return `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}
function fileParas(rel) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return [para(`${rel}  (missing)`)];
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const out = [para(rel)];
  lines.forEach((ln, i) => out.push(para(`${String(i + 1).padStart(6)}  ${ln}`)));
  out.push(para(''));
  return out;
}

const blocks = [];
blocks.push(para(''));
blocks.push(para('================================================================'));
blocks.push(para('CRAWLER OS CUTOVER — added / modified 2026-06-22'));
blocks.push(para('New canonical discovery/matching system at backend/crawler-os/,'));
blocks.push(para('public seam backend/services/crawlerOsService.js, durable-dedup'));
blocks.push(para('migrations, and the build-config changes that support them.'));
blocks.push(para('================================================================'));
blocks.push(para(''));
blocks.push(para(`Added files (${ADDED.length}):`));
for (const f of ADDED) blocks.push(...fileParas(f));
blocks.push(para(`Modified files (${MODIFIED.length}):`));
for (const f of MODIFIED) blocks.push(...fileParas(f));

// Read document.xml out of the zip, inject, write back (using PowerShell's
// System.IO.Compression so we don't need a zip lib).
const tmp = path.join(REPO, '.codedoc-document.xml');
execSync(
  `powershell -NoProfile -Command "Add-Type -A System.IO.Compression.FileSystem; ` +
  `$z=[IO.Compression.ZipFile]::Open('${DOCX}','Update'); ` +
  `$e=$z.GetEntry('word/document.xml'); $r=New-Object IO.StreamReader($e.Open()); ` +
  `$x=$r.ReadToEnd(); $r.Close(); [IO.File]::WriteAllText('${tmp.replace(/\\/g, '/')}',$x); $z.Dispose()"`,
  { stdio: 'inherit' },
);

let xml = fs.readFileSync(tmp, 'utf8');
const inject = blocks.join('');
const idx = xml.lastIndexOf('<w:sectPr');
if (idx === -1) {
  xml = xml.replace('</w:body>', `${inject}</w:body>`);
} else {
  xml = xml.slice(0, idx) + inject + xml.slice(idx);
}
fs.writeFileSync(tmp, xml, 'utf8');

execSync(
  `powershell -NoProfile -Command "Add-Type -A System.IO.Compression.FileSystem; ` +
  `$z=[IO.Compression.ZipFile]::Open('${DOCX}','Update'); ` +
  `$e=$z.GetEntry('word/document.xml'); $s=$e.Open(); $s.SetLength(0); ` +
  `$w=New-Object IO.StreamWriter($s); $w.Write([IO.File]::ReadAllText('${tmp.replace(/\\/g, '/')}')); ` +
  `$w.Close(); $z.Dispose()"`,
  { stdio: 'inherit' },
);
fs.unlinkSync(tmp);
console.log(`Appended ${ADDED.length + MODIFIED.length} files (${blocks.length} paragraphs) to Code for GrantFlow.docx`);
