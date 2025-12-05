import { createSafeServer } from "./_shared/safeHandler.js";
import { enforceOwnership, getSafeSDK } from "./_shared/security.js";
import { loadProfileContext } from "./_shared/matchingEngine.js";
import { invokeLLM } from "./_shared/aiUtils.js";

function buildOutreachPrompt(
  { profileSummary, axes, grant, tone, callToAction },
) {
  const axisText = axes.length
    ? `Funding Axes:\n${axes.map((axis) => `- ${axis.label}`).join("\n")}\n`
    : "";

  const instruction = [
    "Compose an outreach email introducing the funding opportunity.",
    `Tone: ${tone}.`,
    callToAction
      ? `Include a clear call-to-action: ${callToAction}.`
      : "Include a clear call-to-action inviting the recipient to discuss next steps.",
    "Keep the message concise (120-180 words), warm, and professional.",
  ].join(" ");

  return [
    "You are a grants specialist drafting an outreach email to a stakeholder or funder.",
    "Profile Summary:",
    profileSummary,
    axisText ? axisText : "",
    "Opportunity:",
    `Title: ${grant.title ?? "Unknown grant"}`,
    grant.summary ? `Summary: ${grant.summary}` : "",
    grant.eligibility_summary
      ? `Eligibility: ${grant.eligibility_summary}`
      : "",
    `Deadline: ${grant.deadline_at ?? grant.due_at ?? "unknown"}`,
    "",
    instruction,
    "",
    "Return JSON with subject, preview_text (<=90 characters), and body_markdown (Markdown formatted body).",
  ].filter(Boolean).join("\n");
}

export default createSafeServer(async (req) => {
  const { base44, sdk, user } = await getSafeSDK(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const profileId = body.profile_id ?? body.profileId ?? null;
  const organizationId = body.organization_id ?? body.organizationId ?? null;
  const grantId = body.grant_id ?? body.grantId ?? null;
  const tone = body.tone ?? "warm";
  const callToAction = body.call_to_action ?? body.callToAction ?? null;

  if (!grantId) {
    return Response.json({ error: "grant_id is required" }, { status: 400 });
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

  const prompt = buildOutreachPrompt({
    profileSummary: context.summary,
    axes: context.axes,
    grant,
    tone,
    callToAction,
  });

  const response = await invokeLLM(base44, {
    prompt,
    temperature: 0.6,
    responseSchema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        preview_text: { type: "string" },
        body_markdown: { type: "string" },
      },
    },
  });

  return {
    grant_id: grantId,
    profile_id: context.profile.id,
    organization_id: context.organization?.id ?? null,
    subject: response.subject ?? `Opportunity: ${grant.title}`,
    preview_text: response.preview_text ?? "",
    body_markdown: response.body_markdown ?? "",
  };
}, { name: "generateOutreachMessage" });
