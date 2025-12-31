import React from "react"
import { CalendarClock } from "lucide-react"
import PageStub from "@/components/shared/PageStub"

export default function GrantDeadline() {
  return (
    <PageStub
      title="Grant Deadline Control"
      description="Control every milestone—from invite-only briefings to final submission—so critical deadlines never slip."
      icon={CalendarClock}
    >
      <ul className="space-y-3 text-slate-600 leading-relaxed list-disc list-inside">
        <li>Unified deadline calendar with colour-coded urgency and owner assignments.</li>
        <li>Workflow automations that nudge reviewers, gather attachments, and prep e-signatures.</li>
        <li>Submission playbooks that capture funder portals, formatting tips, and help-desk contacts.</li>
      </ul>
    </PageStub>
  )
}
