import React, { useCallback, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  LogOut,
  Moon,
  Sparkles,
  Sun,
} from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import AutoTimeTracker from '@/components/billing/AutoTimeTracker'
import OnboardingSequencer from '@/components/onboarding/OnboardingSequencer'
import AnyaFloatingButton from '@/components/anya/AnyaFloatingButton'
import AnyaMatchScoutAlerts from '@/components/anya/AnyaMatchScoutAlerts'
import RobertRecommendationListener from '@/components/robert/RobertRecommendationListener'
import { AnyaContextProvider } from '@/contexts/AnyaContext'
import ProBonoBanner from '@/components/banners/ProBonoBanner.jsx'
import FreePeriodNotice from '@/components/banners/FreePeriodNotice.jsx'
import MaintenanceGate from '@/components/maintenance/MaintenanceGate.jsx'
import NotificationBell from '@/components/notifications/NotificationBell'
import LoginAnnouncementModal from '@/components/announcements/LoginAnnouncementModal'
import AppBreadcrumb from '@/components/shared/AppBreadcrumb'
import UserStepCoach from '@/components/guidance/UserStepCoach'
import GrantLifecyclePhaseIndicator from '@/components/shared/GrantLifecyclePhaseIndicator'
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher.jsx'

import { apiFetch } from '@/api/client'
import { createPageUrl } from '@/utils'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useFeatureFlags } from '@/lib/featureFlags'
import { setLastVisitedPath } from '@/lib/lastVisitedPreferences'
import { NAV_GROUPS } from '@/nav/navConfig'
import { END_USER_NAV_GROUPS } from '@/nav/endUserNavConfig'
import {
  getShowAdvancedTools,
  setShowAdvancedTools,
  useNavGroupsOpen,
} from '@/nav/useNavGroupsOpen'
import { useLanguage } from '@/i18n'
import { hasFullAdminWorkspace } from '@/lib/workspaceAccess'

function NavGroupCollapsible({ group, location, isOpen, onToggle, user }) {
  const preferences = useSettingsStore((state) => state.preferences)
  const { t } = useLanguage()
  const isAdmin = hasFullAdminWorkspace(user)
  const isActive = group.items.some((item) => location.pathname === item.url)
  const visibleItems = group.items.filter((item) => {
    if (item.isAdminOnly && !isAdmin) return false
    if (item.requiresIncognitoEnabled && !preferences?.custom_preferences?.incognitoEnabled) return false
    return true
  })

  if (visibleItems.length === 0) return null
  const GroupIcon = group.icon

  return (
    <Collapsible open={isOpen} onOpenChange={() => onToggle(group.groupId)}>
      <SidebarGroup>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            className={`mb-1 w-full justify-between rounded-lg ${
              isActive ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            }`}
          >
            <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {GroupIcon ? <GroupIcon className="h-3.5 w-3.5" /> : null}
              {group.groupI18nKey ? t(group.groupI18nKey) : group.label}
            </span>
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenu className="mt-1">
            {visibleItems.map((item) => (
              <SidebarMenuItem key={item.routeName}>
                <SidebarMenuButton
                  asChild
                  className={`mb-1 rounded-lg transition-all duration-200 ${
                    location.pathname === item.url
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                  } ${item.isAdvanced ? 'pl-6 text-xs' : ''}`}
                >
                  <Link to={item.url} className="flex items-center gap-3 px-3 py-2.5">
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="font-medium">{item.i18nKey ? t(item.i18nKey) : item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

export default function Layout({ children }) {
  const location = useLocation()
  const { t } = useLanguage()
  const [showAdvancedTools, setShowAdvancedToolsState] = useState(getShowAdvancedTools)

  const user = useAuthStore((state) => state.user)
  const activeProfileId = useAuthStore((state) => state.activeProfileId)
  const logout = useAuthStore((state) => state.logout)
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)

  const isAdmin = hasFullAdminWorkspace(user)
  // Admins get every nav group expanded on first render (the "old view": all
  // tabs visible); their own collapse choices persist from then on. End users
  // keep the compact simplified nav untouched.
  const [navGroupsOpen, toggleNavGroup] = useNavGroupsOpen(
    isAdmin ? NAV_GROUPS.map((group) => group.groupId) : null,
  )
  const showAdminGroup = isAdmin || showAdvancedTools
  const navigationGroups = isAdmin
    ? NAV_GROUPS.filter((group) => group.groupId !== 'admin' || showAdminGroup)
    : END_USER_NAV_GROUPS

  const handleAdvancedToolsToggle = useCallback(() => {
    const next = !getShowAdvancedTools()
    setShowAdvancedTools(next)
    setShowAdvancedToolsState(next)
  }, [])

  const preferences = useSettingsStore((state) => state.preferences)
  const updatePreference = useSettingsStore((state) => state.updatePreference)
  const isDarkActive =
    preferences?.theme === 'dark' ||
    (preferences?.theme === 'system' &&
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)

  const toggleDarkMode = useCallback(() => {
    updatePreference('theme', isDarkActive ? 'light' : 'dark')
  }, [isDarkActive, updatePreference])

  const displayName = user?.display_name || user?.full_name || 'User'
  const displayEmail = user?.primary_email || user?.email || undefined
  const initials =
    displayName
      .split(' ')
      .filter(Boolean)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'U'

  React.useEffect(() => {
    if (!isAuthenticated) return
    const path = `${location.pathname}${location.search || ''}`
    if (!path || path.startsWith('/login') || path.startsWith('/set-password') || path.startsWith('/auth')) return
    apiFetch('/api/activity/page-view', {
      method: 'POST',
      body: JSON.stringify({
        path,
        title: typeof document !== 'undefined' ? document.title : undefined,
        referrer: typeof document !== 'undefined' ? document.referrer : undefined,
      }),
    }).catch(() => {})
  }, [isAuthenticated, location.pathname, location.search])

  const lastVisitedRef = React.useRef({ path: null, at: 0 })
  React.useEffect(() => {
    if (!isAuthenticated) return
    const path = location.pathname + (location.search || '')
    if (path.startsWith('/login') || path.startsWith('/set-password') || path.startsWith('/auth')) return
    if (path === '/' || path === '/Dashboard') return
    try {
      window.localStorage.setItem('grantflow:last-visited-page', path)
    } catch {
      // Local persistence is only a fallback.
    }
    const now = Date.now()
    const { path: lastPath, at } = lastVisitedRef.current
    if (path !== lastPath || now - at >= 5000) {
      lastVisitedRef.current = { path, at: now }
      setLastVisitedPath(path).catch(() => {})
    }
  }, [isAuthenticated, location.pathname, location.search])

  const { anyaCopilotEnabled: copilotEnabled } = useFeatureFlags()

  const content = (
    <SidebarProvider>
      <div className="flex min-h-screen min-h-dvh w-full overflow-x-hidden bg-gradient-to-br from-background via-background to-muted text-foreground">
        <Sidebar className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
          <SidebarHeader className="border-b border-sidebar-border p-6">
            <Link to={createPageUrl('Dashboard')} className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-blue-800 shadow-lg">
                <FileText className="h-6 w-6 text-white" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-sidebar-foreground">GrantFlow</h2>
                <p className="text-xs text-muted-foreground">{t('layout.grantSuite')}</p>
              </div>
            </Link>
          </SidebarHeader>

          <SidebarContent className="p-3">
            {navigationGroups.map((group) => (
              <NavGroupCollapsible
                key={group.groupId}
                group={group}
                location={location}
                isOpen={navGroupsOpen.has(group.groupId)}
                onToggle={toggleNavGroup}
                user={user}
              />
            ))}
            {isAdmin ? (
              <div className="mt-2 border-t border-sidebar-border pt-2">
                <button
                  type="button"
                  onClick={handleAdvancedToolsToggle}
                  className="px-3 py-1.5 text-[11px] text-muted-foreground hover:text-sidebar-foreground"
                >
                  {showAdvancedTools ? t('layout.hideAdvancedTools') : t('layout.showAdvancedTools')}
                </button>
              </div>
            ) : null}
          </SidebarContent>

          <SidebarFooter className="space-y-4 border-t border-sidebar-border p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600">
                  <span className="text-sm font-semibold text-white">{initials}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-sidebar-foreground">{displayName}</p>
                  {displayEmail ? <p className="truncate text-xs text-muted-foreground">{displayEmail}</p> : null}
                </div>
              </div>
              <button
                onClick={logout}
                className="rounded-lg p-2 transition-colors hover:bg-sidebar-accent"
                title={t('layout.logout')}
              >
                <LogOut className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>

            <LanguageSwitcher className="w-full justify-start" />

            {isAdmin ? (
              <div>
                <div className="w-full rounded-md border border-input bg-muted/50 px-3 py-2 text-sm text-sidebar-foreground">
                  {t('layout.adminViewLabel', { name: displayName })}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t('layout.workspaceShowsData')}{' '}
                  <span className="font-medium text-sidebar-foreground">{t('layout.allProfilesAdmin')}</span>
                </p>
              </div>
            ) : null}

            <div className="border-t border-sidebar-border pt-3 text-center text-xs text-muted-foreground">
              {t('layout.createdBy')} <span className="font-semibold text-sidebar-foreground">John White</span>
            </div>
          </SidebarFooter>
        </Sidebar>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex flex-col gap-2 border-b border-border bg-background/80 px-4 py-3 backdrop-blur md:px-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 md:gap-4">
                <SidebarTrigger className="rounded-lg p-2 transition-colors duration-200 hover:bg-muted md:hidden" />
                <div>
                  <h1 className="text-lg font-semibold leading-tight text-foreground md:text-xl">GrantFlow</h1>
                  <p className="text-xs text-muted-foreground">{t('layout.headerSubtitle')}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 md:gap-3">
                <Button asChild variant="outline" size="sm" className="hidden md:inline-flex">
                  <Link to={createPageUrl('Help')}>
                    <Sparkles className="mr-2 h-3.5 w-3.5" />
                    {isAdmin ? t('layout.userManual') : 'Ask Anya'}
                  </Link>
                </Button>
                <NotificationBell />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={toggleDarkMode}
                  title={isDarkActive ? t('layout.switchToLight') : t('layout.switchToDark')}
                >
                  {isDarkActive ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                </Button>
                <Button variant="ghost" className="flex items-center gap-2 px-2">
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={user?.avatar_url ?? ''} alt={displayName} />
                    <AvatarFallback>{initials}</AvatarFallback>
                  </Avatar>
                  <div className="hidden text-left md:block">
                    <p className="text-sm font-medium text-foreground">{displayName}</p>
                    {displayEmail ? <p className="text-xs text-muted-foreground">{displayEmail}</p> : null}
                  </div>
                </Button>
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <AppBreadcrumb />
              {isAdmin ? <GrantLifecyclePhaseIndicator /> : null}
            </div>
          </header>

          <div className="flex-1 bg-background text-foreground">
            <div className="min-h-full">
              <AutoTimeTracker />
              <MaintenanceGate />
              <ProBonoBanner />
              <FreePeriodNotice />
              <LoginAnnouncementModal />
              {children}
            </div>
          </div>
        </main>

        {isAdmin ? (
          <>
            <OnboardingSequencer />
            <UserStepCoach />
            <AnyaMatchScoutAlerts />
            <RobertRecommendationListener />
            <AnyaFloatingButton profileId={activeProfileId} />
          </>
        ) : null}
      </div>
    </SidebarProvider>
  )

  return copilotEnabled ? <AnyaContextProvider>{content}</AnyaContextProvider> : content
}
