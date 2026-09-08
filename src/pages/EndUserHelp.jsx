import React, { useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Mail } from 'lucide-react'
import AnyaChat from '@/components/anya/SafeAnyaChat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuthStore } from '@/stores/authStore'
import { useTierEntitlements } from '@/hooks/useTierEntitlements'
import { isRealProfileId } from '@/api/profileIdGuards'
import { END_USER_NAV_GROUPS } from '@/nav/endUserNavConfig'
import { HELP_REGISTRY } from '@/config/helpRegistry'
import { createPageUrl } from '@/utils'
import { useLanguage } from '@/i18n'

const SUPPORT_EMAIL = 'dr.johnwhite@axiombiolabs.org'
const QUESTIONS = ['What should I work on next?', 'What is missing from my profile?', 'How do I contact this funder?']

export default function EndUserHelp() {
  const activeProfileId = useAuthStore((state) => state.activeProfileId)
  const profileId = isRealProfileId(activeProfileId) ? activeProfileId : null
  const { capabilities, loading } = useTierEntitlements(profileId)
  const [search, setSearch] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const location = useLocation()
  const { t } = useLanguage()
  const available = useMemo(() => END_USER_NAV_GROUPS.flatMap((group) => group.items)
    .filter((item) => !item.requiresCapability || loading || capabilities?.[item.requiresCapability] !== false), [capabilities, loading])
  const from = new URLSearchParams(location.search).get('from')
  const origin = available.find((item) => item.routeName === from)
  const label = (item) => item.i18nKey ? t(item.i18nKey) : item.title
  const url = (item) => item.usesActiveProfile
    ? profileId ? createPageUrl(item.routeName, { id: profileId, tab: 'profile' }) : null
    : item.url
  const helpFor = (route) => HELP_REGISTRY.find((entry) => entry.key === route)
  const tasks = available.filter((item) => item.routeName !== 'Help' &&
    (label(item) + ' ' + (helpFor(item.routeName)?.endUserDescription || '')).toLowerCase().includes(search.trim().toLowerCase()))
  const grounding = useMemo(() => ({
    originPage: origin?.routeName || 'Help',
    pagePurpose: helpFor(origin?.routeName)?.endUserDescription || 'Help with the funding journey',
    allowedDestinations: available.map((item) => ({ route: item.routeName, label: item.title })),
    instructions: 'Use the caller-authorized profile and real tools for facts. My Profile is available for the active profile. Explain the same route names shown in navigation. Never claim an action succeeded without evidence. Required confirmation rules still apply. Do not send non-admins to admin, crawler control, or diagnostic pages.',
    supportContact: SUPPORT_EMAIL,
  }), [origin?.routeName, available])
  return (
    <section className="px-4 pb-10 pt-6 md:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Help Center</h1>
            <p className="mt-2 max-w-2xl text-base text-foreground">Choose what you want to do. These instructions and links work without Anya or an AI service.</p>
          </div>
          <Button asChild variant="outline"><a href={'mailto:' + SUPPORT_EMAIL}><Mail className="mr-2 h-4 w-4" />Contact GrantFlow administration</a></Button>
        </header>
        {origin ? <div className="rounded-xl border bg-card p-4 text-foreground"><h2 className="font-semibold">Help with {label(origin)}</h2><p className="mt-2">{helpFor(origin.routeName)?.endUserDescription}</p>{url(origin) ? <Link className="mt-2 inline-flex min-h-11 items-center underline" to={url(origin)}>Return to {label(origin)}</Link> : null}</div> : null}
        <details open={new URLSearchParams(location.search).get('tour') === '1' || undefined} className="rounded-xl border bg-card p-4 text-foreground">
          <summary className="min-h-11 cursor-pointer py-3 font-semibold">Start here: follow the funding journey</summary>
          <ol className="mt-3 list-decimal space-y-3 pl-5 text-base leading-relaxed">
            <li><strong>About you.</strong> Open My Profile. Add relevant information, save each section, and return later. Optional answers are not a promise of eligibility.</li>
            <li><strong>Find funding.</strong> Begin with Discover Grants. Smart Matcher is useful for a specific need; Funding Results lets you review search results. Catalog and directory tools help you explore further.</li>
            <li><strong>Review and save.</strong> Read the source, requirements, deadline, and match explanation. A saved grant is a bookmark, not an application.</li>
            <li><strong>Prepare and apply.</strong> Open the Pipeline to work on a suitable source. Hamilton helps prepare applications. Documents are reusable files; Proposals are written drafts. Follow the task's actual instructions for questions and external handoffs.</li>
            <li><strong>Track results.</strong> Use Applications and Calendar for recorded outcomes and dates. A draft, download, or portal visit is not proof of submission. Retain the confirmation from the funder.</li>
          </ol>
          <p className="mt-4 text-sm">You can reopen this guide whenever needed. No step here starts a search, shares documents, or submits an application.</p>
        </details>
        <section aria-labelledby="help-task-heading">
          <h2 id="help-task-heading" className="text-xl font-semibold text-foreground">Find the right tool</h2>
          <label htmlFor="help-task-search" className="mt-3 block text-sm font-medium text-foreground">Search tools and instructions</label>
          <Input id="help-task-search" className="mt-2 min-h-11" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="For example: profile, documents, or deadline" />
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {tasks.map((item) => <article key={item.routeName} className="rounded-xl border bg-card p-4 text-foreground">
              <h3 className="font-semibold">{label(item)}</h3><p className="mt-2 text-sm leading-relaxed">{helpFor(item.routeName)?.endUserDescription || helpFor(item.routeName)?.description}</p>
              {url(item) ? <Link className="mt-2 inline-flex min-h-11 items-center rounded-md px-2 underline focus-visible:ring-2 focus-visible:ring-primary" to={url(item)}>Open {label(item)}</Link> : <p className="mt-3 text-sm">No active profile is available. Use account support to restore access.</p>}
            </article>)}
          </div>
          {!tasks.length ? <p role="status" className="mt-4 text-foreground">No tools match that phrase. Try a simpler word or clear your search.</p> : null}
        </section>
        <section aria-labelledby="ask-anya-heading" className="rounded-xl border bg-card p-4 text-foreground">
          <h2 id="ask-anya-heading" className="text-xl font-semibold">Ask Anya about your work</h2>
          <p className="mt-2 text-sm">Anya can explain your saved profile and application status. Your message is sent only when you press Send.</p>
          {!chatOpen ? <Button className="mt-4" variant="outline" onClick={() => setChatOpen(true)}>Open Anya chat</Button> : (
            <div className="mt-4 h-[65dvh] min-h-[360px]">
              <AnyaChat profileId={profileId} currentPage="Help Center" guidanceContext={grounding} suggestedQuestions={QUESTIONS} />
            </div>
          )}
          <p className="mt-3 text-sm" aria-label="Questions you can ask Anya">Questions you can ask Anya: what to work on next, what your profile needs, or how to contact a funder.</p>
        </section>
      </div>
    </section>
  )
}
