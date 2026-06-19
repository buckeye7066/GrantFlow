/**
 * Vehicle Opportunities Pipeline — Integration Tests
 *
 * Tests:
 *   1. API ingestion: valid vehicle is inserted and returns 201
 *   2. Duplicate prevention: second insert with same link returns 200 duplicate flag
 *   3. Scam rejection: viper + price < 10000 returns 422
 *   4. Missing required fields returns 400
 *   5. GitHub sync mock: scheduleDebouncedVehicleSync is called after successful insert
 */

import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js';

// ---------------------------------------------------------------------------
// Mock the GitHub sync service so tests never hit the real GitHub API.
// We replace the module *before* the server boots so the vehicles route picks
// up the mock automatically.
// ---------------------------------------------------------------------------
vi.mock('../services/githubSyncVehicles.js', () => ({
  scheduleDebouncedVehicleSync: vi.fn(),
  syncVehicleOpportunitiesToGitHub: vi.fn().mockResolvedValue({ ok: true, message: 'mocked' }),
}));

// Import the mock AFTER vi.mock so we can spy on it.
const { scheduleDebouncedVehicleSync } = await import('../services/githubSyncVehicles.js');

// ---------------------------------------------------------------------------

describe('Vehicle Opportunities Pipeline', () => {
  let app;
  let db;

  beforeAll(async () => {
    const loaded = await getAppAndDb();
    app = loaded.app;
    db = loaded.db;
  }, 60_000);

  beforeEach(() => {
    resetDb(db);
    // Ensure vehicle_opportunities table is clean between tests
    try {
      db.prepare('DELETE FROM vehicle_opportunities').run();
    } catch {
      // table may not exist in very old test schema; ignore
    }
    vi.clearAllMocks();
  });

  // ── Auth: ingest is a machine-fed endpoint behind a shared secret ──────────
  it('rejects an unauthenticated ingest request', async () => {
    const res = await request(app)
      .post('/api/vehicles/ingest')
      .send({ title: 'Anonymous Car', link: 'https://example.com/cars/anon' });

    // No admin/ctx and no ingest token → 403 (token configured but not supplied).
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);

    // Nothing should have been written.
    const row = db
      .prepare('SELECT id FROM vehicle_opportunities WHERE link = ?')
      .get('https://example.com/cars/anon');
    expect(row).toBeFalsy();
  });

  // ── Test 1: Successful ingestion ────────────────────────────────────────────
  it('inserts a valid vehicle and returns 201', async () => {
    const payload = {
      vehicle_type: 'sedan',
      title: 'Toyota Camry 2020',
      price: 18000,
      mileage: 30000,
      year: 2020,
      transmission: 'automatic',
      color: 'blue',
      location: 'Columbus, OH',
      link: 'https://example.com/cars/toyota-camry-2020-unique',
      vin: '1HGBH41JXMN109186',
      clean_title: true,
      source: 'test',
    };

    const res = await request(app)
      .post('/api/vehicles/ingest').set(TEST_ADMIN_AUTH_HEADER)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.inserted).toBe(true);
    expect(res.body.id).toBeTruthy();
    expect(res.body.vehicle.title).toBe(payload.title);
    expect(res.body.vehicle.link).toBe(payload.link);

    // Verify row was actually written to the database
    const row = db
      .prepare('SELECT * FROM vehicle_opportunities WHERE link = ?')
      .get(payload.link);
    expect(row).toBeTruthy();
    expect(row.title).toBe(payload.title);
    expect(Number(row.price)).toBe(payload.price);
  });

  // ── Test 2: Duplicate prevention ───────────────────────────────────────────
  it('returns 200 duplicate flag when the same link is submitted twice', async () => {
    const payload = {
      vehicle_type: 'truck',
      title: 'Ford F-150 2019',
      price: 35000,
      link: 'https://example.com/cars/ford-f150-2019-dup',
    };

    // First insert
    const first = await request(app)
      .post('/api/vehicles/ingest').set(TEST_ADMIN_AUTH_HEADER)
      .send(payload);
    expect(first.status).toBe(201);
    expect(first.body.inserted).toBe(true);

    // Second insert — same link
    const second = await request(app)
      .post('/api/vehicles/ingest').set(TEST_ADMIN_AUTH_HEADER)
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(second.body.inserted).toBe(false);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.link).toBe(payload.link);

    // Exactly one row in DB
    const count = db
      .prepare('SELECT COUNT(*) AS cnt FROM vehicle_opportunities WHERE link = ?')
      .get(payload.link);
    expect(Number(count.cnt)).toBe(1);
  });

  // ── Test 3: Scam rejection — viper + price < 10000 ─────────────────────────
  it('rejects a viper listing with price below $10,000', async () => {
    const payload = {
      vehicle_type: 'viper',
      title: 'Dodge Viper SRT-10',
      price: 5000,
      link: 'https://example.com/cars/fake-viper-scam',
    };

    const res = await request(app)
      .post('/api/vehicles/ingest').set(TEST_ADMIN_AUTH_HEADER)
      .send(payload);

    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.rejected).toBe(true);
    expect(res.body.reason).toMatch(/viper/i);

    // Row must NOT be in DB
    const row = db
      .prepare('SELECT id FROM vehicle_opportunities WHERE link = ?')
      .get(payload.link);
    expect(row).toBeFalsy();
  });

  // ── Boundary: viper at exactly $10,000 should be allowed ───────────────────
  it('allows a viper listing priced at exactly $10,000', async () => {
    const payload = {
      vehicle_type: 'viper',
      title: 'Dodge Viper SRT10 Priced Right',
      price: 10000,
      link: 'https://example.com/cars/viper-exactly-10k',
    };

    const res = await request(app)
      .post('/api/vehicles/ingest').set(TEST_ADMIN_AUTH_HEADER)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(true);
  });

  // ── Test 4: Validation — missing required fields ────────────────────────────
  it('returns 400 when required field "title" is missing', async () => {
    const res = await request(app)
      .post('/api/vehicles/ingest').set(TEST_ADMIN_AUTH_HEADER)
      .send({ link: 'https://example.com/cars/no-title' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/validation/i);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/title/i)]),
    );
  });

  it('returns 400 when required field "link" is missing', async () => {
    const res = await request(app)
      .post('/api/vehicles/ingest').set(TEST_ADMIN_AUTH_HEADER)
      .send({ title: 'Some Car' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/link/i)]),
    );
  });

  // ── Test 5: GitHub sync is triggered on successful insert ──────────────────
  it('calls scheduleDebouncedVehicleSync after a successful insert', async () => {
    const payload = {
      vehicle_type: 'suv',
      title: 'Honda CR-V 2022',
      price: 28000,
      link: 'https://example.com/cars/honda-crv-2022-sync-test',
    };

    const res = await request(app)
      .post('/api/vehicles/ingest').set(TEST_ADMIN_AUTH_HEADER)
      .send(payload);

    expect(res.status).toBe(201);
    expect(scheduleDebouncedVehicleSync).toHaveBeenCalledTimes(1);
  });

  // Sync must NOT be called for duplicates or rejected listings
  it('does not call scheduleDebouncedVehicleSync for a duplicate', async () => {
    const payload = {
      vehicle_type: 'coupe',
      title: 'BMW 3 Series 2021',
      price: 40000,
      link: 'https://example.com/cars/bmw-3-series-no-sync-dup',
    };

    // First insert
    await request(app).post('/api/vehicles/ingest').set(TEST_ADMIN_AUTH_HEADER).send(payload);
    vi.clearAllMocks();

    // Second (duplicate) insert
    const res = await request(app).post('/api/vehicles/ingest').set(TEST_ADMIN_AUTH_HEADER).send(payload);
    expect(res.status).toBe(200);
    expect(scheduleDebouncedVehicleSync).not.toHaveBeenCalled();
  });
});
