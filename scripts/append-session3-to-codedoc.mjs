// Append the session-2 cutover changes (agents/persistence/relevance/pipeline
// cleanup) to "Code for GrantFlow.docx" so the export reflects the latest code.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const DOCX = 'G:/One Drive/Desktop/Code for GrantFlow.docx';
const REPO = path.resolve(process.cwd());

const FILES = [
  'backend/routes/matching.js',
  'backend/routes/discovery.js',
  'scripts/check-runtime-imports.mjs',
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const para = (t) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
function fileParas(rel) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return [para(`${rel}  (missing)`)];
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  return [para(rel), ...lines.map((ln, i) => para(`${String(i + 1).padStart(6)}  ${ln}`)), para('')];
}

const blocks = [
  para(''),
  para('================================================================'),
  para('CRAWLER OS CUTOVER — SESSION 3 (route cutover + legacy-reachability gate) 2026-06-22'),
  para('Discovery + matching READ routes now serve Crawler OS matches; legacy'),
  para('crawler reachability is now tracked by the runtime-imports guard.'),
  para(''),
  para('================================================================'),
  para(''),
  para(`Files (${FILES.length}):`),
  ...FILES.flatMap(fileParas),
];

const tmp = path.join(REPO, '.codedoc-document3.xml');
execSync(
  `powershell -NoProfile -Command "Add-Type -A System.IO.Compression.FileSystem; ` +
  `$z=[IO.Compression.ZipFile]::Open('${DOCX}','Update'); $e=$z.GetEntry('word/document.xml'); ` +
  `$r=New-Object IO.StreamReader($e.Open()); $x=$r.ReadToEnd(); $r.Close(); ` +
  `[IO.File]::WriteAllText('${tmp.replace(/\\/g, '/')}',$x); $z.Dispose()"`,
  { stdio: 'inherit' },
);
let xml = fs.readFileSync(tmp, 'utf8');
const inject = blocks.join('');
const idx = xml.lastIndexOf('<w:sectPr');
xml = idx === -1 ? xml.replace('</w:body>', `${inject}</w:body>`) : xml.slice(0, idx) + inject + xml.slice(idx);
fs.writeFileSync(tmp, xml, 'utf8');
execSync(
  `powershell -NoProfile -Command "Add-Type -A System.IO.Compression.FileSystem; ` +
  `$z=[IO.Compression.ZipFile]::Open('${DOCX}','Update'); $e=$z.GetEntry('word/document.xml'); ` +
  `$s=$e.Open(); $s.SetLength(0); $w=New-Object IO.StreamWriter($s); ` +
  `$w.Write([IO.File]::ReadAllText('${tmp.replace(/\\/g, '/')}')); $w.Close(); $z.Dispose()"`,
  { stdio: 'inherit' },
);
fs.unlinkSync(tmp);
console.log(`Appended session-2 (${FILES.length} files, ${blocks.length} paragraphs) to Code for GrantFlow.docx`);
