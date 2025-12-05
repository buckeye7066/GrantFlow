import { createSafeServer } from "./_shared/safeHandler.js";
import { enforceOwnership, getSafeSDK } from "./_shared/security.js";
import { loadProfileContext } from "./_shared/matchingEngine.js";
import { invokeLLM } from "./_shared/aiUtils.js";

export default createSafeServer(async (req) => {
  const { base44, sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const profileId = body.profile_id ?? body.profileId ?? null;
  const organizationId = body.organization_id ?? body.organizationId ?? null;
  const grantId = body.grant_id ?? body.grantId ?? null;
  const sectionId = body.section_id ?? body.sectionId ?? body.section ?? null;
  const sectionTitle = body.section_title ?? body.sectionTitle ??
    "Proposal Section";
  const instructions = body.instructions ?? body.prompt ?? null;

  if (!grantId) {
    return Response.json({ error: "grant_id is required" }, { status: 400 });
  }

  if (!sectionId) {
    return Response.json({ error: "section_id is required" }, { status: 400 });
  }

  const grant = await sdk.entities.Grant.get(grantId).catch(() => null);
  if (!grant) {
    return Response.json({ error: "Grant not found" }, { status: 404 });
  }
  enforceOwnership(user, grant, "created_by");

  const context = await loadProfileContext(
    sdk,
    user,
    {
      profileId,
      organizationId: organizationId ?? grant.organization_id ?? null,
    },
  );

  const prompt = [
    "Write a proposal section based on the following context.",
    "Profile Summary:",
    context.summary,
    context.axes.length
      ? `Funding Axes:\n${
        context.axes.map((axis) => `- ${axis.label}`).join("\n")
      }`
      : "",
    "Grant Details:",
    `Title: ${grant.title ?? "Untitled grant"}`,
    grant.summary ? `Summary: ${grant.summary}` : "",
    grant.description ? `Description: ${grant.description}` : "",
    grant.eligibility_summary
      ? `Eligibility: ${grant.eligibility_summary}`
      : "",
    `Deadline: ${grant.deadline_at ?? grant.due_at ?? "unknown"}`,
    "",
    `Section: ${sectionTitle}`,
    instructions
      ? `Instructions: ${instructions}`
      : "Provide a persuasive narrative (200-250 words) focusing on alignment between the profile and the grant.",
    "",
    "Return JSON with content_markdown (Markdown formatted section).",
  ].filter(Boolean).join("\n");

  const response = await invokeLLM(base44, {
    prompt,
    temperature: 0.55,
    responseSchema: {
      type: "object",
      properties: {
        content_markdown: { type: "string" },
      },
    },
  });

  return {
    profile_id: context.profile.id,
    organization_id: context.organization?.id ?? null,
    grant_id: grantId,
    section: {
      id: sectionId,
      title: sectionTitle,
      content_markdown: response.content_markdown ?? "",
    },
  };
}, { name: "generateProposalSection" });
