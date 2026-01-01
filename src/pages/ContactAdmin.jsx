import React from "react"
import { MessageSquare } from "lucide-react"
import PageStub from "@/components/shared/PageStub"

export default function ContactAdmin() {
  return (
    <PageStub
      title="Contact Admin"
      description="Coordinate support requests, onboarding tasks, and global communications across your GrantFlow workspace."
      icon={MessageSquare}
    >
      <ul className="space-y-3 text-slate-600 leading-relaxed list-disc list-inside">
        <li>Submit environment-wide configuration changes and monitor their progress.</li>
        <li>Broadcast announcements or resource updates to every workspace user.</li>
        <li>Surface audit trails for system changes, new integrations, and access requests.</li>
      </ul>
    </PageStub>
  )
}
