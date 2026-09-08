import React from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui/button'
import { createPageUrl } from '@/utils'

/** Uses the existing optional onboarding state, without forcing navigation. */
export default function EndUserWelcomeGuide() {
  const markStatus = useAuthStore((state) => state.markGuidedCycleTourStatus)
  return <section aria-labelledby="welcome-guide-title" className="mx-4 mt-4 rounded-xl border border-primary/30 bg-card p-4 text-foreground md:mx-6 lg:mx-10">
    <h2 id="welcome-guide-title" className="text-lg font-semibold">Start with one clear next step</h2>
    <p className="mt-2 text-sm leading-relaxed">Home recommends what to do next. My Profile holds your information, Find Funding helps you search, and Work holds applications and documents. You can use any available tool without finishing a tour.</p>
    <div className="mt-3 flex flex-wrap gap-3">
      <Button asChild variant="outline"><Link to={createPageUrl('Help', { tour: '1' })}>Read the getting-started guide</Link></Button>
      <Button variant="outline" onClick={() => markStatus('completed')}>I understand the steps</Button>
      <Button variant="ghost" onClick={() => markStatus('skipped')}>Skip this introduction</Button>
    </div>
    <p className="mt-2 text-sm">The guide is always available in Help. Closing this introduction does not change your applications.</p>
  </section>
}
