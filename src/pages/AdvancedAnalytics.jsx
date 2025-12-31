import React from "react"
import { LineChart } from "lucide-react"
import PageStub from "@/components/shared/PageStub"

export default function AdvancedAnalytics() {
  return (
    <PageStub
      title="Advanced Analytics"
      description="Dive deeper into performance trends, win rates, and portfolio health with interactive visualisations."
      icon={LineChart}
    >
      <ul className="space-y-3 text-slate-600 leading-relaxed list-disc list-inside">
        <li>Custom dashboards to compare programmes, geographies, and funder segments.</li>
        <li>Scenario modelling to forecast awards, cashflow, and reporting workload.</li>
        <li>Export-ready decks and narratives that auto-refresh when data changes.</li>
      </ul>
    </PageStub>
  )
}
