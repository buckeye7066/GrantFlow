#!/usr/bin/env node
// repo_scan.js - Parse JS/TS import statements, build dependency graph and find missing modules
// Usage: node scripts/repo_scan.js

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const excludeDirs = ['.git', 'triage', 'node_modules'];

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(function(file) {
    const filepath = path.join(dir, file);
    const stat = fs.statSync(filepath);
    if (excludeDirs.includes(file)) return;
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(filepath));
    } else if (file.endsWith('.js') || file.endsWith('.ts')) {
      results.push(filepath);
    }
  });
  return results;
}

function normalizeImportPath(importPath, from) {
  if (importPath.startsWith('.')) {
    // relative
    const dir = path.dirname(from);
    const resolved = path.resolve(dir, importPath);
    // Try to find file with .js or .ts or index.js
    const candidates = [resolved, resolved + '.js', resolved + '.ts', path.join(resolved, 'index.js'), path.join(resolved, 'index.ts')];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  } else {
    // not relative imports: skip (node modules, npm: imports)
    return importPath;
  }
}

const files = walk(root);
const graph = {};
const errors = [];
const missing = new Set();
const allExports = new Map();
const allImports = new Map();

files.forEach(file => {
  const rel = path.relative(root, file);
  graph[rel] = [];
  const content = fs.readFileSync(file, 'utf8');
  const importRegex = /import\s+.*?from\s+['\"](.*?)['\"]/g;
  let m;
  while ((m = importRegex.exec(content)) !== null) {
    const importPath = m[1];
    const resolved = normalizeImportPath(importPath, file);
    graph[rel].push(importPath);
    allImports.set(rel, (allImports.get(rel) || []).concat(importPath));
    if (resolved === null) {
      missing.add(`${rel}->${importPath}`);
    }
  }
  // Look for exports - simple: `export function` or `export const` or `export default`
  const exportRegex = /export\s+(?:default\s+)?(function|const|let|var|class)\s+(\w+)/g;
  while ((m = exportRegex.exec(content)) !== null) {
    const kind = m[1];
    const name = m[2];
    allExports.set(rel, (allExports.get(rel) || []).concat(name));
  }
});

// Detect cycles in relative imports
function detectCycles() {
  const visited = {};
  const stack = {};
  const cycles = [];

  function dfs(node, pathStack) {
    visited[node] = true;
    stack[node] = true;
    const edges = graph[node] || [];
    for (const imp of edges) {
      // check only relative
      if (!imp.startsWith('.')) continue;
      const normalized = normalizeImportPath(imp, path.join(root, node));
      if (!normalized) continue;
      const rel = path.relative(root, normalized);
      if (!visited[rel]) {
        dfs(rel, pathStack.concat(rel));
      } else if (stack[rel]) {
        cycles.push(pathStack.concat(rel));
      }
    }
    stack[node] = false;
  }

  Object.keys(graph).forEach(node => {
    if (!visited[node]) dfs(node, [node]);
  });
  return cycles;
}

const cycles = detectCycles();

// Find exports never imported
const importedNames = new Map();
files.forEach(file => {
  const rel = path.relative(root, file);
  const content = fs.readFileSync(file, 'utf8');
  // naive: find all usage of exported names as identifiers
  for (const [expFile, names] of allExports) {
    for (const name of names) {
      if (content.includes(name)) {
        importedNames.set(name, (importedNames.get(name) || []).concat(rel));
      }
    }
  }
});

const exportsUnused = [];
for (const [file, names] of allExports) {
  for (const n of names) {
    if (!importedNames.has(n)) exportsUnused.push({ file, name: n });
  }
}

// Output summary
const out = {
  files: files.length,
  missingImports: Array.from(missing).slice(0, 200),
  cycles: cycles.slice(0, 50),
  exportsUnused: exportsUnused.slice(0, 200)
};
fs.writeFileSync('triage/scan_report.json', JSON.stringify(out, null, 2));
console.log('Scan completed. Results saved to triage/scan_report.json.');

if (missing.size > 0) {
  console.log('Missing imports detected (sample):');
  Array.from(missing).slice(0, 50).forEach(x => console.log('  ' + x));
}
if (cycles.length > 0) {
  console.log('Cycles detected (sample):');
  cycles.slice(0, 10).forEach(c => console.log('  ' + c.join(' -> ')));
}
if (exportsUnused.length > 0) {
  console.log('Unused exports (sample):');
  exportsUnused.slice(0, 50).forEach(e => console.log(`  ${e.file}: ${e.name}`));
}

console.log('Done.');
