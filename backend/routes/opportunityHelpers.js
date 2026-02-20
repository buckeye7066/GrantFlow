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
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  return deadlineDate.getTime() < cutoff.getTime();
}

export function dedupeKeyFromRow(row) {
  if (!row) return null;
  const url = normalizeUrlForDedupe(row.application_url) || normalizeUrlForDedupe(row.source_url);
  const title = String(row.title || '').trim().toLowerCase();
  const sponsor = String(row.sponsor || '').trim().toLowerCase();
  const deadlineIso = (() => {
    const d = parseLooseDate(row.deadline);
    return d ? d.toISOString().slice(0, 10) : String(row.deadline || '').trim().toLowerCase();
  })();
  if (url) return `url:${url}`;
  const sourceId = row.source_id != null ? String(row.source_id).trim().toLowerCase() : '';
  if (sourceId) return `sid:${sourceId}`;
  if (title && sponsor) return `tsd:${title}::${sponsor}::${deadlineIso}`;
  if (title && deadlineIso) return `td:${title}::${deadlineIso}`;
  return row.id ? `id:${String(row.id)}` : null;
}
