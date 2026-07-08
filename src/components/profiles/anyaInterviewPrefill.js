/**
 * anyaInterviewPrefill.js
 *
 * Builds the seed message that starts Anya's project-readiness interview from a
 * profile's action plan. Kept as a pure, React-free helper so the exact wording
 * — which is load-bearing for LLM behavior — can be unit-tested directly.
 *
 * BUG THIS FIXES (global): the old prefill ENDED with a full markdown list of
 * every interview question ("Questions:\n- q1\n- q2 ..."). LLMs weight the last
 * thing they read most heavily, so Anya mirrored that list back to the user
 * instead of conducting a one-question-at-a-time interview — on every profile
 * that had questions, i.e. most of them.
 *
 * The rewrite keeps the computed, profile-specific questions (they're valuable)
 * but reframes them as Anya's PRIVATE queue, demotes known facts to a "do not
 * re-ask" reference, and ends the message with a single actionable directive:
 * greet, then ask ONLY the first question now, one at a time, never showing the
 * list. Recency now reinforces the interview instead of fighting it.
 *
 * PRIVACY: this seed is Anya's script, not something the user typed. It is sent
 * with prefillHidden=true (ProfileActionPlanCard → openAnyaPanel); the server
 * stamps the stored row with the anya_private_seed marker (role stays 'user' —
 * never client-controlled) and the chat UI collapses marked rows. The model
 * reads it, the audit trail keeps it, and the user's first sight of the
 * interview is Anya's greeting.
 */

export function buildAnyaPrefill(plan, profileName) {
  const who = profileName || "this profile"

  // Facts we already have — private reference so Anya never re-asks them. NOT a
  // user-facing list; it exists only to suppress redundant questions.
  const knownFacts = (plan?.checklist ?? [])
    .filter((item) => item?.status === "known" && item?.known_value)
    .slice(0, 20)
    .map((item) => `  • ${item.title}: ${item.known_value}`)
    .join("\n")

  // Ordered question queue. The FIRST question is pulled out as the immediate
  // action; the rest are a private queue Anya works through one at a time. This
  // is her script — it must never be pasted back to the user as a list.
  const queue = (plan?.interview_questions ?? []).slice(0, 8)
  const firstQuestion = queue[0]?.prompt ?? null
  const remaining = queue
    .slice(1)
    .map((q, i) => `  ${i + 2}. ${q.prompt}`)
    .join("\n")

  const lines = [
    `Anya, run the project-readiness interview for ${who} as a live back-and-forth conversation — NOT a list.`,
    `Plan: ${plan?.title ?? "Project readiness plan"} (${plan?.plan_id ?? "general"}).`,
    "",
    "How to run it (follow exactly):",
    `- Open warmly with: "Good job! Now that you've gotten this far, I have a few questions to narrow down your needs."`,
    "- Then ask exactly ONE question and STOP. Wait for the user's answer before asking the next.",
    "- NEVER paste, number, bullet, or summarize the whole set of questions. The user must only ever see one question at a time.",
    "- Use the profile fields and uploaded document text GrantFlow already has. Skip anything under \"Known facts\" below; if a PDF, DOCX, screenshot, or note already answers something, treat it as evidence and ask only to confirm.",
    "- For official IDs, tax identifiers, SSNs, EINs, license numbers, military IDs, account numbers, or medical/benefit proof, ask the user to upload the official document to the profile instead of typing sensitive numbers into chat. Explain the upload creates the profile's audit trail, and never quote full sensitive identifiers back.",
  ]

  if (knownFacts) {
    lines.push("", "Known facts (do NOT re-ask — private reference):", knownFacts)
  }

  if (firstQuestion) {
    lines.push("", `Start now by asking ONLY this first question: ${firstQuestion}`)
    if (remaining) {
      lines.push(
        "",
        "Your private queue for AFTER each answer (one at a time — never show this list to the user):",
        remaining,
      )
    }
  } else {
    lines.push(
      "",
      "There are no required questions right now. Greet the user, confirm the key facts you already have one at a time, and ask whether anything has changed.",
    )
  }

  return lines.join("\n")
}
