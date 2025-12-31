import React from "react"
import { Sparkles } from "lucide-react"
import PageStub from "@/components/shared/PageStub"

export default function SmartMatcher() {
  return (
    <PageStub
      title="Smart Matcher"
      description="Surface the best-fit opportunities for every profile with weighted criteria, AI summaries, and saved searches."
      icon={Sparkles}
    >
      <ul className="space-y-3 text-slate-600 leading-relaxed list-disc list-inside">
        <li>Adaptive scoring that blends eligibility flags, historical wins, and profile tags.</li>
        <li>Scenario planning to compare funding mixes by organisation, region, or programme.</li>
        <li>Fine-grained filters with the ability to share saved views across the team.</li>
        <li>Automated explainers for why an opportunity is recommended—or excluded.</li>
      </ul>
    </PageStub>
  )
}
