
import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:opportunityHelpers')
/**
 * Pure helper functions for the opportunities route.
 * Extracted to enable unit testing without Express/DB dependencies.
 */

export function stripOrdinalSuffixes(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!text) return '';
  return text.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
}

export function parseLooseDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = typeof value === 'string' ? value.trim() : String(value).trim();
  if (!raw) return null;
  const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const cleaned = stripOrdinalSuffixes(raw)
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Attempt structured parse for common written formats before falling back.
  // Month-Day-Year and Month Year patterns are handled explicitly.
  const monthNames = 'january|february|march|april|may|june|july|august|september|october|november|december';
  const mdyMatch = cleaned.match(
    new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})\\s+(\\d{4})\\b`, 'i')
  );
  if (mdyMatch) {
    const d2 = new Date(`${mdyMatch[1]} ${mdyMatch[2]} ${mdyMatch[3]} 00:00:00 UTC`);
    return Number.isNaN(d2.getTime()) ? null : d2;
  }
  const myMatch = cleaned.match(
    new RegExp(`\\b(${monthNames})\\s+(\\d{4})\\b`, 'i')
  );
  if (myMatch) {
    // Use last day of month as conservative expiry boundary.
    const d2 = new Date(`${myMatch[1]} 1 ${myMatch[2]} 00:00:00 UTC`);
    if (!Number.isNaN(d2.getTime())) {
      d2.setUTCMonth(d2.getUTCMonth() + 1, 0); // last day of that month
    }
    return Number.isNaN(d2.getTime()) ? null : d2;
  }
  // Ambiguous strings with no year cannot be reliably dated; return null
  // so they are NOT treated as expired (prefer recall, Goal 7).
  const hasYear = /\b(19|20)\d{2}\b/.test(cleaned);
  if (!hasYear) return null;
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function normalizeUrlForDedupe(url) {
  if (!url || typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.hash = '';
    const drop = new Set([
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid', 'mc_cid', 'mc_eid',
    ]);
    Array.from(u.searchParams.keys()).forEach((k) => {
      if (drop.has(String(k).toLowerCase())) u.searchParams.delete(k);
    });
    const normalized = `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/g, '').toLowerCase()
      + (u.search ? `?${u.searchParams.toString()}` : '');
    return normalized || null;
  } catch {
    return raw.replace(/\/+$/g, '').toLowerCase();
  }
}

export function isDirectoryLike(row) {
  if (!row || typeof row !== 'object') return false;
  const type = String(row.type || '').trim().toUpperCase();
  if (type === 'DIRECTORY') return true;
  const origin = String(row.record_origin || '').trim().toLowerCase();
  if (origin.includes('directory')) return true;
  const oppType = String(row.opportunity_type || '').trim().toLowerCase();
  return oppType.includes('directory');
}

export function isExpiredOpportunity(row, { now = new Date() } = {}) {
  if (!row) return false;
  if (isDirectoryLike(row)) return false;
  const deadlineType = String(row.deadline_type || '').trim().toLowerCase();
  if (deadlineType === 'rolling' || deadlineType === 'ongoing') return false;
  const deadlineDate = parseLooseDate(row.deadline);
  if (!deadlineDate) return false;
  // Compare using UTC dates so the cutoff is timezone-neutral,
  // matching the UTC-midnight deadlines produced by parseLooseDate.
  const cutoff = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
  return deadlineDate.getTime() < cutoff.getTime();
}

export function dedupeKeyFromRow(row) {
  if (!row) return null;
  const appUrl = normalizeUrlForDedupe(row.application_url);
  if (appUrl) return `url:${appUrl}`;
  // Fall through to source_url only if no application_url exists.
  const srcUrl = normalizeUrlForDedupe(row.source_url);
  if (srcUrl) return `srcurl:${srcUrl}`;
  const title = String(row.title || '').trim().toLowerCase();
  const sponsor = String(row.sponsor || '').trim().toLowerCase();
  const deadlineIso = (() => {
    try {
      const d = parseLooseDate(row.deadline);
      return d ? d.toISOString().slice(0, 10) : String(row.deadline || '').trim().toLowerCase();
    } catch {
      return String(row.deadline || '').trim().toLowerCase();
    }
  })();
  const rowUrl = normalizeUrlForDedupe(row.url);
  if (rowUrl) return `rowurl:${rowUrl}`;
  const sourceId = (row.source_id !== null && row.source_id !== undefined) ? String(row.source_id).trim().toLowerCase() : '';
  if (sourceId) return `sid:${sourceId}`;
  if (title && sponsor) return `tsd:${title}::${sponsor}::${deadlineIso}`;
  if (title && deadlineIso) return `td:${title}::${deadlineIso}`;
  return row.id ? `id:${String(row.id)}` : null;
}
