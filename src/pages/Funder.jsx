import React from "react"
import { HandCoins } from "lucide-react"
import PageStub from "@/components/shared/PageStub"

export default function Funder() {
  return (
    <PageStub
      title="Funder Workspace"
      description="Centralise institutional, corporate, and philanthropic funder relationships. Track giving history, grant requirements, and collaboration notes as we rebuild the experience."
      icon={HandCoins}
    >
      <ul className="space-y-3 text-slate-600 leading-relaxed list-disc list-inside">
        <li>Structured profiles for foundations, corporate sponsors, and government programmes.</li>
        <li>Grant history timelines with statuses, award amounts, and reporting cycles.</li>
        <li>AI-assisted relationship briefs pulled from synced documents and meeting notes.</li>
        <li>Collaboration planner with reminders, next steps, and shared ownership.</li>
      </ul>
    </PageStub>
  )
}
