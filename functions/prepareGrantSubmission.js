import { createSafeServer } from "./_shared/safeHandler.js";
import { enforceOwnership, getSafeSDK } from "./_shared/security.js";

async function fetchRequirements(sdk, grantId) {
  const requirements = await sdk.entities.GrantRequirement.filter({
    grant_id: grantId,
  }).catch(() => []);

  return (Array.isArray(requirements) ? requirements : []).map((req) => ({
    id: req.id,
    title: req.title ?? req.name ?? "Requirement",
    description: req.description ?? "",
    due_at: req.due_at ?? req.deadline_at ?? null,
    status: req.status ?? "pending",
    type: req.type ?? "document",
    notes: req.notes ?? "",
  }));
}

async function fetchDocuments(sdk, grantId) {
  const documents = await sdk.entities.Document.filter({
    grant_id: grantId,
  }).catch(() => []);

  return (Array.isArray(documents) ? documents : []).map((doc) => ({
    id: doc.id,
    name: doc.name ?? doc.title ?? "Document",
    url: doc.url ?? null,
    type: doc.type ?? "attachment",
    status: doc.status ?? "draft",
    updated_at: doc.updated_at ?? doc.created_at ?? null,
  }));
}

function buildChecklist(grant, requirements, documents) {
  const checklist = [];

  if (!grant?.narrative) {
    checklist.push({
      code: "narrative",
      label: "Draft narrative",
      status: "pending",
      hint: "Grant narrative has not been prepared yet.",
    });
  }

  if ((documents ?? []).length === 0) {
    checklist.push({
      code: "documents",
      label: "Upload supporting documents",
      status: "pending",
      hint: "No documents are attached to this grant submission.",
    });
  }

  for (const req of requirements) {
    checklist.push({
      code: `requirement:${req.id}`,
      label: req.title,
      status: req.status ?? "pending",
      due_at: req.due_at,
    });
  }

  if (!grant?.submission_strategy) {
    checklist.push({
      code: "strategy",
      label: "Review submission strategy",
      status: "pending",
      hint: "No submission strategy recorded.",
    });
  }

  return checklist;
}

export default createSafeServer(async (req) => {
  const { sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { grant_id } = await req.json().catch(() => ({}));
  if (!grant_id) {
    return Response.json({ error: "grant_id is required" }, { status: 400 });
  }

  const grant = await sdk.entities.Grant.get(grant_id).catch(() => null);
  if (!grant) {
    return Response.json({ error: "Grant not found" }, { status: 404 });
  }

  enforceOwnership(user, grant, "created_by");

  const organization = grant.organization_id
    ? await sdk.entities.Organization.get(grant.organization_id).catch(() =>
      null
    )
    : null;

  const requirements = await fetchRequirements(sdk, grant_id);
  const documents = await fetchDocuments(sdk, grant_id);
  const checklist = buildChecklist(grant, requirements, documents);

  return {
    grant: {
      id: grant.id,
      title: grant.title,
      status: grant.status,
      submission_strategy: grant.submission_strategy ?? null,
      due_at: grant.due_at ?? grant.deadline_at ?? null,
    },
    organization: organization
      ? {
        id: organization.id,
        name: organization.name,
        contact_email: organization.primary_email ?? organization.email ?? null,
        contact_phone: organization.primary_phone ?? organization.phone ?? null,
      }
      : null,
    requirements,
    documents,
    checklist,
  };
}, { name: "prepareGrantSubmission" });
