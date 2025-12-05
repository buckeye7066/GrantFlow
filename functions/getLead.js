import { createSafeServer } from "./_shared/safeHandler.js";
import { enforceOwnership, getSafeSDK } from "./_shared/security.js";

export default createSafeServer(async (req) => {
  const { sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { lead_id } = await req.json().catch(() => ({}));
  if (!lead_id) {
    return Response.json({ error: "lead_id is required" }, { status: 400 });
  }

  const lead = await sdk.entities.Lead.get(lead_id).catch(() => null);
  if (!lead) {
    return Response.json({ error: "Lead not found" }, { status: 404 });
  }

  enforceOwnership(user, lead, "owner_id");
  return { lead };
}, { name: "getLead" });
