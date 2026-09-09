import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import appUpdates from './app-updates.mjs';

test('inventory contains only final assets after Vite inlines multi-page entry chunks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-update-vite-'));
  try {
    for (const name of ['index', 'privacy']) await writeFile(path.join(root, `${name}.html`), '<html><head></head><body><script type="module" src="./main.js"></script></body></html>');
    await writeFile(path.join(root, 'main.js'), "document.body.dataset.loaded = 'yes';");
    await build({ configFile: false, root, logLevel: 'silent', plugins: [appUpdates({ app: 'fixture' })], build: { outDir: 'dist', rollupOptions: { input: { index: path.join(root, 'index.html'), privacy: path.join(root, 'privacy.html') } } } });
    const manifest = JSON.parse(await readFile(path.join(root, 'dist/app-update.json'), 'utf8'));
    const missing = [];
    for (const asset of manifest.assets) { try { await access(path.join(root, 'dist', asset.path)); } catch { missing.push(asset.path); } }
    assert.deepEqual(missing, [], 'removed HTML entry chunks must not block update readiness');
    assert.ok(manifest.assets.some((asset) => asset.path.startsWith('assets/')), 'the real shared application chunk is verified');
  } finally { await rm(root, { recursive: true, force: true }); }
});
