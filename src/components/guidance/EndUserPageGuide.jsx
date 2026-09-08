import React from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { useLanguage } from '@/i18n'
import { createPageUrl } from '@/utils'
import SavedWorkNotice from './SavedWorkNotice'
import { HELP_REGISTRY } from '@/config/helpRegistry'
import { END_USER_NAV_GROUPS } from '@/nav/endUserNavConfig'
import { isRealProfileId } from '@/api/profileIdGuards'

const STEPS = [
  ['about', 'ProfileDetail', ['ProfileDetail', 'OrganizationProfile']],
  ['find', 'DiscoverGrants', ['DiscoverGrants', 'FundingResults', 'SmartMatcher', 'ProfileMatcher', 'FundingOpportunities', 'ItemFunding', 'GreenHomePrograms', 'Funder', 'DataSources', 'SourceDirectory']],
  ['review', 'SavedGrants', ['SavedGrants', 'GrantDetail', 'NOFOParser', 'AIGrantScorer']],
  ['prepare', 'Pipeline', ['Pipeline', 'HamiltonProcessing', 'Documents', 'Proposals', 'PrintableApplication', 'Apply', 'VNextApplication', 'VNextFinishPacket']],
  ['track', 'Applications', ['Applications', 'Calendar', 'GrantLifecycle']],
]
export default function EndUserPageGuide() {
  const location = useLocation()
  const navigate = useNavigate()
  const { t } = useLanguage()
  const profileId = useAuthStore((state) => state.activeProfileId)
  const profilesRaw = useAuthStore((state) => state.profiles)
  const setActiveProfileId = useAuthStore((state) => state.setActiveProfileId)
  const profiles = Array.isArray(profilesRaw) ? profilesRaw : []
  const route = location.pathname.split('/')[1] || 'Dashboard'
  const nav = END_USER_NAV_GROUPS.flatMap((group) => group.items)
  const item = nav.find((entry) => entry.routeName === route)
  const guide = HELP_REGISTRY.find((entry) => entry.key === route)
  const active = profiles.find((profile) => String(profile.id) === String(profileId))
  const viewedId = route === 'ProfileDetail' ? new URLSearchParams(location.search).get('id') : null
  const viewed = viewedId ? profiles.find((profile) => String(profile.id) === String(viewedId)) : active
  const title = item?.i18nKey ? t(item.i18nKey) : item?.title || guide?.title || t('journey.page')
  const href = (name) => name === 'ProfileDetail'
    ? isRealProfileId(profileId) ? createPageUrl(name, { id: profileId, tab: 'profile' }) : createPageUrl('Help')
    : createPageUrl(name)
  const changeProfile = (event) => {
    const id = event.target.value
    if (!profiles.some((profile) => String(profile.id) === id)) return
    setActiveProfileId(id)
    // A record-specific URL must not remain selected under a different profile.
    navigate(createPageUrl(route === 'ProfileDetail' ? 'ProfileDetail' : 'Dashboard', route === 'ProfileDetail' ? { id, tab: 'profile' } : undefined))
  }
  return (
    <aside aria-label={t('journey.orientation')} className="mx-4 mt-4 rounded-xl border border-border bg-card p-4 text-foreground md:mx-6 lg:mx-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{title}</p>
          <p className="mt-1 text-sm leading-relaxed">{guide?.endUserDescription || guide?.description || t('journey.pageHint')}</p>
        </div>
        <Link className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm underline focus-visible:ring-2 focus-visible:ring-primary" to={createPageUrl('Help', { from: item ? route : 'Dashboard' })}>{t('journey.help')}</Link>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        {profiles.length > 1 ? <label className="flex flex-wrap items-center gap-2">{t('journey.activeProfile')}
          <select className="min-h-11 max-w-full rounded-md border bg-background px-2 text-foreground" value={active?.id || ''} onChange={changeProfile}>
            {!active ? <option value="">{t('journey.chooseProfile')}</option> : null}
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name || t('journey.profile')}</option>)}
          </select>
        </label> : <span>{t('journey.activeProfile')}: {active?.display_name || t('journey.noProfile')}</span>}
        {viewedId && viewed && viewedId !== String(profileId) ? <span>{t('journey.viewing')}: {viewed.display_name}</span> : null}
        <Link to={createPageUrl('Dashboard')} className="inline-flex min-h-11 items-center underline">{t('breadcrumb.home')}</Link>
      </div>
      <SavedWorkNotice />
      <details className="mt-2">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:ring-2 focus-visible:ring-primary">{t('journey.how')}</summary>
        <p className="mb-3 text-sm">{t('journey.notWizard')}</p>
      </details>
      <nav aria-label={t('journey.how')} className="mt-2">
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map(([key, name, routes], index) => <li key={key}>
            <Link to={href(name)} aria-current={routes.includes(route) ? 'step' : undefined} className="flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm aria-[current=step]:border-primary aria-[current=step]:font-bold focus-visible:ring-2 focus-visible:ring-primary">
              <span aria-hidden="true">{index + 1}.</span>{t('journey.' + key)}
            </Link>
          </li>)}
        </ol>
      </nav>
    </aside>
  )
}
