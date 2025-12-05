import { createSafeServer } from "./_shared/safeHandler.js";
import { getSafeSDK } from "./_shared/security.js";

function coerceArray(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export default createSafeServer(async (req) => {
  const { sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await req.json().catch(() => ({}));
  const status = params.status ? coerceArray(params.status) : undefined;
  const search = params.search ? String(params.search).trim() : null;

  const filters = {
    owner_id: user.id,
  };
  if (status && status.length > 0) {
    filters.status = { in: status };
  }

  const options = {
    limit: Math.min(Number(params.limit) || 50, 200),
    offset: Math.max(Number(params.offset) || 0, 0),
    order: [{ column: "created_at", ascending: false }],
  };

  let leads = await sdk.entities.Lead.filter(filters, options);
  if (!Array.isArray(leads)) leads = [];

  if (search) {
    const term = search.toLowerCase();
    leads = leads.filter((lead) => {
      const haystack = [
        lead.name,
        lead.email,
        lead.status,
        lead.source,
        lead.notes,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }

  return {
    leads,
    pagination: {
      limit: options.limit,
      offset: options.offset,
      count: leads.length,
    },
  };
}, { name: "getLeads" });
