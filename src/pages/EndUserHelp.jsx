import React, { useMemo } from 'react'
import { Mail, MessageCircle, Sparkles } from 'lucide-react'

import AnyaChat from '@/components/anya/AnyaChat'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/authStore'

const SUPPORT_EMAIL = 'dr.johnwhite@axiombiolabs.org'

export default function EndUserHelp() {
  const activeProfileId = useAuthStore((state) => state.activeProfileId)
  const profiles = useAuthStore((state) => state.profiles)
  const profileId = activeProfileId && activeProfileId !== '__admin__'
    ? activeProfileId
    : profiles?.[0]?.id ?? null

  const helpCenterGrounding = useMemo(
    () => [
      'You are serving this user from GrantFlow\'s Help Center.',
      'Use the active profile and your available profile-scoped tools before answering factual questions.',
      'Prioritize: profile gaps, pipeline status, submission progress, deadlines, the next best action, and plain-English explanations.',
      'When the user provides a missing profile fact, offer to save it with profile.updateSection and follow the required confirmation step.',
      `When the user asks how to contact GrantFlow administration, provide ${SUPPORT_EMAIL}.`,
      'When asked for a funder contact, use contact or source details actually available in the opportunity or application context. If no contact is stored, say so clearly and explain the safest way to find it.',
      'Never direct this end user to hidden admin, crawler, profile-editor, analytics, or diagnostic screens.',
    ].join(' '),
    [],
  )

  return (
    <section className="px-4 pb-10 pt-6 md:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              Your GrantFlow guide
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Ask Anya</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground md:text-base">
              Ask about your profile, funding sources, application progress, deadlines, what Hamilton needs, or what to do next.
            </p>
          </div>
          <Button asChild variant="outline" className="w-fit gap-2">
            <a href={`mailto:${SUPPORT_EMAIL}`}>
              <Mail className="h-4 w-4" />
              Contact GrantFlow administration
            </a>
          </Button>
        </div>

        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="grid gap-3 p-4 text-sm text-foreground md:grid-cols-3">
            <div className="flex items-start gap-2">
              <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>“What should I work on next?”</span>
            </div>
            <div className="flex items-start gap-2">
              <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>“What is missing from my profile?”</span>
            </div>
            <div className="flex items-start gap-2">
              <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>“How do I contact this funder?”</span>
            </div>
          </CardContent>
        </Card>

        <div className="h-[calc(100vh-17rem)] min-h-[620px]">
          <AnyaChat
            profileId={profileId}
            currentPage="Help Center"
            prefillMessage={helpCenterGrounding}
            prefillHidden
          />
        </div>
      </div>
    </section>
  )
}
