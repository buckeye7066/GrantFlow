import { createSafeServer } from "./_shared/safeHandler.js";
import { enforceOwnership, getSafeSDK } from "./_shared/security.js";

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
  const leadId = params.lead_id ?? params.id;

  if (!leadId) {
    return Response.json({ error: "lead_id is required" }, { status: 400 });
  }

  const lead = await sdk.entities.Lead.get(leadId).catch(() => null);
  if (!lead) {
    return Response.json({ error: "Lead not found" }, { status: 404 });
  }

  enforceOwnership(user, lead, "owner_id");

  const options = {
    limit: coerceLimit(params.limit),
    offset: coerceOffset(params.offset),
    order: [{ column: "created_at", ascending: false }],
  };

  const activities = await sdk.entities.Activity.filter({
    entity_type: "Lead",
    entity_id: leadId,
  }, options).catch(() => []);

  return {
    lead_id: leadId,
    activities,
    pagination: {
      limit: options.limit,
      offset: options.offset,
      count: activities.length,
    },
  };
}, { name: "getLeadActivities" });
