/**
 * Vehicles API Route
 *
 * POST /api/vehicles/ingest
 *   Ingest a new vehicle opportunity into the database.
 *   - Validates required fields: title, link
 *   - Rejects obvious scams (viper + price < 10000)
 *   - Deduplicates by link
 *   - Triggers a debounced GitHub sync after a successful insert
 */

import express from 'express';
import crypto from 'node:crypto';
import { randomUUID } from 'crypto';
import { formatError } from '../middleware/errorHandler.js';
import { scheduleDebouncedVehicleSync } from '../services/githubSyncVehicles.js';
import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:vehicles')

const router = express.Router();

/**
 * Constant-time secret comparison. timingSafeEqual throws on unequal lengths,
 * so the length check both prevents that and short-circuits mismatches without
 * leaking length via timing once we're past it.
 */
function timingSafeEq(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function resolveVehiclesIngestToken() {
  return (
    process.env.VEHICLES_INGEST_TOKEN ||
    process.env.ADMIN_TOKEN ||
    process.env.ANYA_ADMIN_TOKEN ||
    null
  );
}

/**
 * Shared-secret guard for the machine-fed ingest endpoint.
 *
 * /ingest is pushed to by an external scraper (each insert triggers an outbound
 * GitHub sync), so it is intentionally callable without a user session — but it
 * must NOT be anonymous. We require VEHICLES_INGEST_TOKEN (falling back to the
 * admin token) supplied via x-vehicles-token or Authorization: Bearer, mirroring
 * the blocklist ingest pattern. A logged-in admin (req.ctx.isAdmin) also passes.
 */
function ingestAuth(req, res, next) {
  if (req.ctx?.isAdmin === true || req.user?.is_admin === true) return next();
  const configured = resolveVehiclesIngestToken();
  if (!configured) {
    return res
      .status(401)
      .json({ ok: false, error: 'Ingest token not configured (set VEHICLES_INGEST_TOKEN)' });
  }
  const headerToken =
    req.headers['x-vehicles-token'] || req.headers.authorization?.replace('Bearer ', '');
  if (!timingSafeEq(headerToken, configured)) {
    return res.status(403).json({ ok: false, error: 'Invalid ingest token' });
  }
  return next();
}

/**
 * Sanitize and coerce an inbound vehicle payload.
 * Returns { data, errors } where errors is an array of human-readable messages.
 *
 * @param {object} body - Raw request body
 * @returns {{ data: object, errors: string[] }}
 */
function validateAndCoerce(body) {
  const errors = [];
  const data = {};

  // Required fields
  const title = typeof body.title === 'string' ? body.title.trim() : null;
  if (!title) errors.push('title is required and must be a non-empty string');
  else data.title = title;

  const link = typeof body.link === 'string' ? body.link.trim() : null;
  if (!link) errors.push('link is required and must be a non-empty string');
  else data.link = link;

  // Optional fields
  data.vehicle_type = typeof body.vehicle_type === 'string' ? body.vehicle_type.trim() : '';
  data.price = body.price !== undefined && body.price !== null && body.price !== ''
    ? Number(body.price)
    : null;
  data.mileage = body.mileage !== undefined && body.mileage !== null && body.mileage !== ''
    ? parseInt(String(body.mileage), 10)
    : null;
  data.year = body.year !== undefined && body.year !== null && body.year !== ''
    ? parseInt(String(body.year), 10)
    : null;
  data.transmission = typeof body.transmission === 'string' ? body.transmission.trim() : null;
  data.color = typeof body.color === 'string' ? body.color.trim() : null;
  data.location = typeof body.location === 'string' ? body.location.trim() : null;
  data.vin = typeof body.vin === 'string' ? body.vin.trim() : null;
  data.clean_title = body.clean_title !== undefined ? Boolean(body.clean_title) : true;
  data.source = typeof body.source === 'string' ? body.source.trim() : null;

  // Numeric sanity checks
  if (data.price !== null && !Number.isFinite(data.price)) {
    errors.push('price must be a valid number');
    data.price = null;
  }
  if (data.mileage !== null && !Number.isFinite(data.mileage)) {
    errors.push('mileage must be a valid integer');
    data.mileage = null;
  }
  if (data.year !== null && !Number.isFinite(data.year)) {
    errors.push('year must be a valid integer');
    data.year = null;
  }

  return { data, errors };
}

/**
 * Scam-rejection logic.
 * Returns a rejection reason string if the listing should be rejected, otherwise null.
 *
 * @param {{ vehicle_type: string, price: number|null }} data
 * @returns {string|null}
 */
function detectScam(data) {
  const type = String(data.vehicle_type || '').toLowerCase().trim();
  const price = data.price;

  if (type === 'viper' && price !== null && Number.isFinite(price) && price < 10000) {
    return `Suspected scam: vehicle_type="${data.vehicle_type}" with price=${price} is below the minimum threshold of $10,000`;
  }
  return null;
}

/**
 * POST /api/vehicles/ingest
 *
 * Body (JSON):
 *   title*       {string}
 *   link*        {string}
 *   vehicle_type {string}
 *   price        {number}
 *   mileage      {number}
 *   year         {number}
 *   transmission {string}
 *   color        {string}
 *   location     {string}
 *   vin          {string}
 *   clean_title  {boolean}
 *   source       {string}
 *
 * Responses:
 *   201  { ok: true,  inserted: true,  id, vehicle }
 *   200  { ok: true,  inserted: false, duplicate: true, link }
 *   400  { ok: false, error, details? }
 *   422  { ok: false, error, rejected: true, reason }
 *   500  { ok: false, error }
 */
router.post('/ingest', ingestAuth, async (req, res) => {
  const db = req.db;
  const { data, errors } = validateAndCoerce(req.body || {});

  if (errors.length > 0) {
    console.warn('[vehicles/ingest] Validation failed', { errors, body: req.body });
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: errors,
    });
  }

  // Scam detection
  const scamReason = detectScam(data);
  if (scamReason) {
    console.warn('[vehicles/ingest] Scam rejection', {
      reason: scamReason,
      vehicle_type: data.vehicle_type,
      price: data.price,
      link: data.link,
    });
    return res.status(422).json({
      ok: false,
      error: 'Listing rejected',
      rejected: true,
      reason: scamReason,
    });
  }

  if (!db) {
    console.error('[vehicles/ingest] Database is not available');
    return res.status(500).json({ ok: false, error: 'Database unavailable' });
  }

  try {
    // Deduplicate by link
    const existing = await db
      .prepare('SELECT id FROM vehicle_opportunities WHERE link = ? LIMIT 1')
      .get(data.link);

    if (existing) {
      routeLogger.info('[vehicles/ingest] Duplicate skipped', { link: data.link, existingId: existing.id });
      return res.status(200).json({
        ok: true,
        inserted: false,
        duplicate: true,
        link: data.link,
      });
    }

    const isPg = db.dialect === 'postgres';

    let id;
    if (isPg) {
      // PostgreSQL: gen_random_uuid() - let the DB generate the id
      // clean_title is a native boolean column in Postgres
      const inserted = await db.prepare(
        `INSERT INTO vehicle_opportunities
           (vehicle_type, title, price, mileage, year, transmission, color, location, link, vin, clean_title, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      ).get(
        data.vehicle_type,
        data.title,
        data.price,
        data.mileage,
        data.year,
        data.transmission,
        data.color,
        data.location,
        data.link,
        data.vin,
        data.clean_title,
        data.source,
      );
      id = inserted?.id;
    } else {
      // SQLite: generate id manually; clean_title stored as integer (1/0)
      id = randomUUID();
      await db
        .prepare(
          `INSERT INTO vehicle_opportunities
             (id, vehicle_type, title, price, mileage, year, transmission, color, location, link, vin, clean_title, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          data.vehicle_type,
          data.title,
          data.price,
          data.mileage,
          data.year,
          data.transmission,
          data.color,
          data.location,
          data.link,
          data.vin,
          data.clean_title ? 1 : 0,
          data.source,
        );
    }

    routeLogger.info('[vehicles/ingest] Inserted vehicle opportunity', {
      id,
      title: data.title,
      link: data.link,
    });

    // Trigger debounced GitHub sync — fire-and-forget, never blocks the response
    try {
      scheduleDebouncedVehicleSync(db);
    } catch (syncErr) {
      // Log but do NOT fail the request if sync scheduling fails
      console.error('[vehicles/ingest] Failed to schedule GitHub sync:', syncErr?.message || String(syncErr));
    }

    return res.status(201).json({
      ok: true,
      inserted: true,
      id,
      vehicle: {
        id,
        ...data,
      },
    });
  } catch (err) {
    // Check for unique-constraint violation (duplicate link race condition)
    const msg = String(err?.message || '');
    const isUniqueViolation =
      msg.includes('UNIQUE constraint failed') ||
      msg.includes('unique constraint') ||
      (err?.code === '23505'); // PostgreSQL unique_violation

    if (isUniqueViolation) {
      routeLogger.info('[vehicles/ingest] Duplicate (race) skipped', { link: data.link });
      return res.status(200).json({
        ok: true,
        inserted: false,
        duplicate: true,
        link: data.link,
      });
    }

    console.error('[vehicles/ingest] Insert error:', err?.message || String(err), { link: data.link });
    return res.status(500).json(formatError(err));
  }
});

export default router;
