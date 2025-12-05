import { createSafeServer } from "./_shared/safeHandler.js";
import { getSafeSDK } from "./_shared/security.js";

function sanitizeLeadPayload(input = {}) {
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

  const payload = {};
  for (const key of allowed) {
    if (input[key] === undefined || input[key] === null) continue;
    payload[key] = input[key];
  }
  return payload;
}

export default createSafeServer(async (req) => {
  const { sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const payload = sanitizeLeadPayload(body);

  if (!payload.name) {
    return Response.json({ error: "Lead name is required" }, { status: 400 });
  }

  payload.owner_id = user.id;
  payload.status = payload.status ?? "new";
  payload.tags = Array.isArray(payload.tags) ? payload.tags : [];
  payload.metadata = typeof payload.metadata === "object" && payload.metadata
    ? payload.metadata
    : {};

  const lead = await sdk.entities.Lead.create(payload);
  return { lead };
}, { name: "createLead" });
