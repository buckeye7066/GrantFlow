import { createSafeServer } from "./_shared/safeHandler.js";
import { enforceOwnership, getSafeSDK } from "./_shared/security.js";

function sanitizeUpdate(input = {}) {
  const allowed = [
    "name",
    "email",
    "phone",
    "organization_id",
    "status",
    "source",
    "notes",
    "tags",
    "metadata",
  ];
  const update = {};
  for (const key of allowed) {
    if (input[key] === undefined) continue;
    update[key] = input[key];
  }
  return update;
}

export default createSafeServer(async (req) => {
  const { sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const leadId = body.lead_id ?? body.id;
  if (!leadId) {
    return Response.json({ error: "lead_id is required" }, { status: 400 });
  }

  const lead = await sdk.entities.Lead.get(leadId).catch(() => null);
  if (!lead) {
    return Response.json({ error: "Lead not found" }, { status: 404 });
  }
  enforceOwnership(user, lead, "owner_id");

  const update = sanitizeUpdate(body);
  if (Object.keys(update).length === 0) {
    return { lead };
  }

  update.updated_at = new Date().toISOString();
  const updated = await sdk.entities.Lead.update(leadId, update);
  return { lead: updated };
}, { name: "updateLead" });
