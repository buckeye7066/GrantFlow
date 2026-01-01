import React from "react"
import { Megaphone } from "lucide-react"
import PageStub from "@/components/shared/PageStub"

export default function Outreach() {
  return (
    <PageStub
      title="Outreach Hub"
      description="Plan campaigns, steward prospects, and log touchpoints that turn funding conversations into awarded grants."
      icon={Megaphone}
    >
      <ul className="space-y-3 text-slate-600 leading-relaxed list-disc list-inside">
        <li>Campaign dashboards that blend grant, sponsorship, and donor outreach pipelines.</li>
        <li>Embedded email and call logging with templates tied to programme outcomes.</li>
        <li>Impact storytelling assets auto-suggested from recent wins and reports.</li>
      </ul>
    </PageStub>
  )
}
