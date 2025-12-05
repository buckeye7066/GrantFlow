import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

const RESTRICTED_PATTERNS = [
  /^auth\./i,
  /^service_role/i,
  /^supabase\./i
];

function collectCandidateIds(value, fieldName, bucket) {
  if (value === null || value === undefined) return;
  const nextBucket = bucket ?? new Set();

  if (typeof value === 'string' || typeof value === 'number') {
    const candidate = String(value).trim();
    if (candidate.length > 0) nextBucket.add(candidate);
    return nextBucket;
  }

  if (typeof value === 'object') {
    const possibleKeys = ['id', 'auth_id', 'profile_id', fieldName];
    for (const key of possibleKeys) {
      if (key in value) collectCandidateIds(value[key], fieldName, nextBucket);
    }
  }

  return nextBucket;
}

function isRestrictedAuthIdentifier(value) {
  return RESTRICTED_PATTERNS.some((pattern) => pattern.test(value));
}

export async function getSafeSDK(req) {
  const base44 = createClientFromRequest(req);
  const sdk = base44.asServiceRole;

  const user = await base44.auth.me().catch(() => null);
  if (!user) {
    return { base44, sdk, user: null };
  }

  const authHeader = req.headers.get('authorization') ?? '';
  if (authHeader.toLowerCase().includes('service_role')) {
    throw new Error('Service role token is not allowed for user initiated requests');
  }

  return { base44, sdk, user };
}

export function assertNotUserSuppliedAuthId(fieldName, rawValue, context = 'unknown') {
  const candidates = collectCandidateIds(rawValue, fieldName);
  if (!candidates || candidates.size === 0) return;

  for (const candidate of candidates) {
    if (isRestrictedAuthIdentifier(candidate)) {
      throw new Error(`Illegal ${fieldName} received in ${context}`);
    }
  }
}

export function enforceOwnership(user, record, ownerField = 'user_id') {
  if (!user) throw new Error('Unauthorized');
  if (!record) throw new Error('Record not found');

  const ownerId = record[ownerField] ?? record.user_id ?? record.created_by ?? null;
  if (ownerId && ownerId !== user.id) {
    const roles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : []);
    if (!roles.includes('admin') && !roles.includes('super_admin')) {
      throw new Error('Forbidden');
    }
  }
}