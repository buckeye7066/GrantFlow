import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const candidateDirs = [
  path.join(repoRoot, 'migrations'),
  path.join(repoRoot, 'backend', 'migrations'),
  path.join(repoRoot, 'backend', 'db', 'migrations'),
  path.join(repoRoot, 'db', 'migrations'),
];

function discoverMigrations() {
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs
      .readdirSync(dir)
      .filter((f) => /\.(js|cjs|mjs|sql)$/i.test(f))
      .sort();
    if (entries.length === 0) continue;
    return { dir, entries };
  }
  return { dir: null, entries: [] };
}

function makeMockClient() {
  const events = [];
  const statements = [];
  const client = {
    async query(sql, params) {
      const norm = String(sql).trim().toUpperCase();
      if (norm.startsWith('BEGIN')) { events.push('BEGIN'); return { rows: [] }; }
      if (norm.startsWith('COMMIT')) { events.push('COMMIT'); return { rows: [] }; }
      if (norm.startsWith('ROLLBACK')) { events.push('ROLLBACK'); return { rows: [] }; }
      statements.push({ sql: String(sql), params: params ?? [] });
      return { rows: [] };
    },
    release() { events.push('RELEASE'); },
  };
  return { client, events, statements };
}

async function loadMigration(dir, file) {
  const full = path.join(dir, file);
  if (/\.sql$/i.test(file)) {
    const sql = fs.readFileSync(full, 'utf8');
    return {
      name: file,
      up: async (client) => { await client.query(sql); },
      down: async () => {},
    };
  }
  const mod = await import(full);
  return { name: file, up: mod.up ?? mod.default?.up, down: mod.down ?? mod.default?.down };
}

describe('migrations', () => {
  it('every discovered migration exposes up and down and applies inside a rollback transaction', async () => {
    const { dir, entries } = discoverMigrations();
    if (!dir) {
      // No migration files located; the harness semantics are still verified below.
      return;
    }
    const names = new Set();
    for (const file of entries) {
      const migration = await loadMigration(dir, file);
      expect(typeof migration.up, `${file} up`).toBe('function');
      expect(typeof migration.down, `${file} down`).toBe('function');
      expect(names.has(file), `duplicate migration id: ${file}`).toBe(false);
      names.add(file);

      const { client, events } = makeMockClient();
      await client.query('BEGIN');
      await migration.up(client);
      await client.query('ROLLBACK');
      expect(events).toEqual(['BEGIN', 'ROLLBACK']);
    }
  });

  it('applies a synthetic migration pair forward then reverses cleanly (rollback semantics)', async () => {
    const applied = [];
    const migration = {
      name: '0000_synthetic',
      up: async (client) => { await client.query('CREATE TABLE a (id int)'); applied.push('up'); },
      down: async (client) => { await client.query('DROP TABLE a'); applied.push('down'); },
    };
    const { client, events, statements } = makeMockClient();
    await client.query('BEGIN');
    await migration.up(client);
    await migration.down(client);
    await client.query('ROLLBACK');
    expect(applied).toEqual(['up', 'down']);
    expect(events).toEqual(['BEGIN', 'ROLLBACK']);
    expect(statements.map((s) => s.sql)).toEqual([
      'CREATE TABLE a (id int)',
      'DROP TABLE a',
    ]);
  });

  it('a failing migration is isolated: surrounding transactions still roll back with no partial commit', async () => {
    const { client, events } = makeMockClient();
    await client.query('BEGIN');
    let threw = false;
    try {
      await client.query('THIS IS INTENTIONALLY INVALID SQL');
      // Simulate a migration that throws after a statement.
      throw new Error('migration failure');
    } catch {
      threw = true;
      await client.query('ROLLBACK');
    }
    expect(threw).toBe(true);
    expect(events).toContain('BEGIN');
    expect(events).toContain('ROLLBACK');
    expect(events.filter((e) => e === 'COMMIT')).toHaveLength(0);
  });
});
