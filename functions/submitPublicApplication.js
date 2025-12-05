import { createClientFromRequest } from "npm:@base44/sdk@0.8.4";
import { createSafeServer } from "./_shared/safeHandler.js";
import { listFundingAxes } from "./_shared/profileSchema.js";

async function ensureGrant(sdk, grantId) {
  const grant = await sdk.entities.Grant.get(grantId).catch(() => null);
  if (!grant) {
    throw new Error("Grant not found");
  }
  return grant;
}

function buildApplicantSummary(applicant = {}) {
  if (!applicant) return "";
  const parts = [];
  if (applicant.name) parts.push(`Name: ${applicant.name}`);
  if (applicant.email) parts.push(`Email: ${applicant.email}`);
  if (applicant.phone) parts.push(`Phone: ${applicant.phone}`);
  if (applicant.organization) {
    parts.push(`Organization: ${applicant.organization}`);
  }
  return parts.join(" • ");
}

export default createSafeServer(async (req) => {
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));

  const grantId = body.grant_id ?? body.grantId ?? null;
  const applicant = body.applicant ?? {};
  const responses = body.responses ?? {};
  const profileQualifiers = body.profile_qualifiers ?? {};

  if (!grantId) {
    return Response.json({ error: "grant_id is required" }, { status: 400 });
  }

  if (!applicant?.name || !applicant?.email) {
    return Response.json({
      error: "applicant.name and applicant.email are required",
    }, { status: 400 });
  }

  const sdk = base44.asServiceRole;
  const grant = await ensureGrant(sdk, grantId);

  const now = new Date().toISOString();
  const axes = listFundingAxes(profileQualifiers);

  const publicApplication = await sdk.entities.PublicGrantApplication.create({
    grant_id: grantId,
    applicant_name: applicant.name,
    applicant_email: applicant.email,
    applicant_phone: applicant.phone ?? null,
    organization_name: applicant.organization ?? null,
    responses,
    funding_axes: axes,
    submitted_at: now,
    status: "submitted",
  });

  await sdk.entities.Activity.create({
    entity_type: "Grant",
    entity_id: grantId,
    type: "public_submission",
    message: `Public application received: ${buildApplicantSummary(applicant)}`,
    metadata: { application_id: publicApplication.id },
  }).catch(() => {});

  await sdk.entities.Grant.update(grantId, {
    public_application_count: (grant.public_application_count ?? 0) + 1,
    last_public_application_at: now,
  }).catch(() => {});

  return {
    application: publicApplication,
    grant: {
      id: grant.id,
      title: grant.title,
    },
  };
}, { name: "submitPublicApplication" });
