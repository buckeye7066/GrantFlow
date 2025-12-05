import { createSafeServer } from "./_shared/safeHandler.js";
import { getSafeSDK } from "./_shared/security.js";

function coerceLimit(value, max = 200, fallback = 50) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return fallback;
  return Math.min(Math.max(numeric, 1), max);
}

function coerceOffset(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric) || numeric < 0) return 0;
  return numeric;
}

export default createSafeServer(async (req) => {
  const { sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await req.json().catch(() => ({}));

  const filters = {
    owner_id: user.id,
  };

  if (params.entity_type) {
    filters.entity_type = String(params.entity_type);
  }

  if (params.entity_id) {
    filters.entity_id = String(params.entity_id);
  }

  if (params.since) {
    filters.created_at = { gte: new Date(params.since).toISOString() };
  }

  const options = {
    limit: coerceLimit(params.limit),
    offset: coerceOffset(params.offset),
    order: [{ column: "created_at", ascending: false }],
  };

  const activities = await sdk.entities.Activity.filter(filters, options)
    .catch(() => []);

  return {
    activities,
    pagination: {
      limit: options.limit,
      offset: options.offset,
      count: activities.length,
    },
  };
}, { name: "getActivities" });
