import React, { useState, useCallback } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  LogOut,
  Sun,
  Moon,
  ChevronDown,
  ChevronRight,
  Sparkles,
  FileText,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import AutoTimeTracker from "@/components/billing/AutoTimeTracker";
import { useDashboardPreferences } from "@/contexts/DashboardPreferencesContext.jsx";
// OnboardingFlow / FirstRunOnboardingGate were the previous duplicated
// onboarding gates. They are intentionally removed in favour of the single
// /start conversational quiz with Anya — see src/pages/Start.jsx. Existing
// users coming back are routed straight to the dashboard; new users land at
// /start (handled by index.jsx + LayoutRoutes redirect below).
import AnyaGuidedTour from "@/components/onboarding/AnyaGuidedTour";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuthStore } from "@/stores/authStore";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import AnyaFloatingButton from "@/components/anya/AnyaFloatingButton";
import AnyaMatchScoutAlerts from "@/components/anya/AnyaMatchScoutAlerts";
import RobertRecommendationListener from "@/components/robert/RobertRecommendationListener";
import { AnyaContextProvider } from "@/contexts/AnyaContext";
import { useFeatureFlags } from "@/lib/featureFlags";
import ProBonoBanner from "@/components/banners/ProBonoBanner.jsx";
import FreePeriodNotice from "@/components/banners/FreePeriodNotice.jsx";
import MaintenanceGate from "@/components/maintenance/MaintenanceGate.jsx";
import NotificationBell from "@/components/notifications/NotificationBell";
import LoginAnnouncementModal from "@/components/announcements/LoginAnnouncementModal";
import AppBreadcrumb from "@/components/shared/AppBreadcrumb";
import UserStepCoach from "@/components/guidance/UserStepCoach";
import GrantLifecyclePhaseIndicator from "@/components/shared/GrantLifecyclePhaseIndicator";
import { apiFetch } from "@/api/client";
import { createPageUrl } from "@/utils";
import { NAV_GROUPS, getGroupIdForRoute } from "@/nav/navConfig";
import { useNavGroupsOpen, getShowAdvancedTools, setShowAdvancedTools } from "@/nav/useNavGroupsOpen";
import { useSettingsStore } from '@/stores/settingsStore';
import { setLastVisitedPath } from '@/lib/lastVisitedPreferences';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher.jsx';
import { useLanguage } from '@/i18n';

function NavGroupCollapsible({ group, location, isOpen, onToggle, user }) {
  // Access user preferences to support feature toggles
  const preferences = useSettingsStore((state) => state.preferences);
  const { t } = useLanguage();
  const isActive = group.items.some((item) => location.pathname === item.url);
  const visibleItems = group.items.filter((item) => {
    if (item.isAdminOnly && !user?.is_admin) return false;
    // Hide items that require Incognito when the flag is disabled
    if (item.requiresIncognitoEnabled && !preferences?.custom_preferences?.incognitoEnabled) return false;
    return true;
  });
  if (visibleItems.length === 0) return null;
  const GroupIcon = group.icon;

  return (
    <Collapsible open={isOpen} onOpenChange={() => onToggle(group.groupId)}>
      <SidebarGroup>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            className={`w-full justify-between rounded-lg mb-1 ${
              isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            }`}
          >
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              {GroupIcon && <GroupIcon className="w-3.5 h-3.5" />}
              {group.label}
            </span>
            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenu className="mt-1">
            {visibleItems.map((item) => (
              <SidebarMenuItem key={item.routeName}>
                <SidebarMenuButton
                  asChild
                  className={`transition-all duration-200 rounded-lg mb-1 ${
                    location.pathname === item.url
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  } ${item.isAdvanced ? "pl-6 text-xs" : ""}`}
                >
                  <Link to={item.url} className="flex items-center gap-3 px-3 py-2.5">
                    <item.icon className="w-4 h-4 shrink-0" />
                    <span className="font-medium">{item.i18nKey ? t(item.i18nKey) : item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

export default function Layout({ children, currentPageName }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [navGroupsOpen, toggleNavGroup] = useNavGroupsOpen();
  const [showAdvancedTools, setShowAdvancedToolsState] = useState(getShowAdvancedTools);
  const { state: dashboardPrefs, dispatch: preferencesDispatch } = useDashboardPreferences();
  const { user, profiles, activeProfileId, setActiveProfileId, logout } = useAuthStore((state) => ({
    user: state.user,
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
    setActiveProfileId: state.setActiveProfileId,
    logout: state.logout,
  }));
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isAdmin = Boolean(user?.is_admin);
  const showAdminGroup = isAdmin || showAdvancedTools;

  const handleAdvancedToolsToggle = useCallback(() => {
    const next = !getShowAdvancedTools();
    setShowAdvancedTools(next);
    setShowAdvancedToolsState(next);
  }, []);

  const toggleDarkMode = React.useCallback(() => {
    preferencesDispatch({
      type: "SET_DARK_MODE",
      enabled: !dashboardPrefs.darkMode,
    })
  }, [dashboardPrefs.darkMode, preferencesDispatch])

  const displayName = user?.display_name || user?.full_name || 'User';
  const displayEmail = user?.primary_email || user?.email || undefined;
  const selectedProfileId = activeProfileId ?? (isAdmin ? '__admin__' : (profiles?.[0]?.id ?? ''));
  const initials =
    displayName
      .split(' ')
      .filter(Boolean)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'U';

  const handleProfileChange = (value) => {
        // Admin view: set activeProfileId to __admin__ but don't navigate
            if (value === '__admin__') {
                  setActiveProfileId('__admin__');
                        return;
                            }
                                setActiveProfileId(value || null);
                                    if (value) {
                                          navigate(`/OrganizationProfile?id=${value}`);
                                              }
  };

  const handleLogout = () => {
    logout();
  };

  // Lightweight analytics: record page views for admin reporting.
  // Best-effort: never block UI.
  React.useEffect(() => {
    if (!isAuthenticated) return

    const path = `${location.pathname}${location.search || ''}`
    if (!path) return

    // Avoid tracking auth screens.
    if (path.startsWith('/login') || path.startsWith('/set-password') || path.startsWith('/auth')) return

    apiFetch('/api/activity/page-view', {
      method: 'POST',
      body: JSON.stringify({
        path,
        title: typeof document !== 'undefined' ? document.title : undefined,
        referrer: typeof document !== 'undefined' ? document.referrer : undefined,
      }),
    }).catch(() => {})
  }, [isAuthenticated, location.pathname, location.search])

  // Persist last visited page for Dashboard "Continue" card (preferences = source of truth, localStorage = fallback).
  const lastVisitedRef = React.useRef({ path: null, at: 0 })
  React.useEffect(() => {
    if (!isAuthenticated) return
    const path = location.pathname + (location.search || '')
    if (path.startsWith('/login') || path.startsWith('/set-password') || path.startsWith('/auth')) return
    if (path === '/' || path === '/Dashboard') return
    try {
      window.localStorage.setItem('grantflow:last-visited-page', path)
    } catch (_) { /* ignore */ }
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
      <div className="min-h-screen flex w-full bg-gradient-to-br from-background via-background to-muted text-foreground">
        <Sidebar className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
          <SidebarHeader className="border-b border-sidebar-border p-6">
            <Link to={createPageUrl("Dashboard")} className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-blue-800 rounded-xl flex items-center justify-center shadow-lg">
                <FileText className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="font-bold text-sidebar-foreground text-lg">GrantFlow</h2>
                <p className="text-xs text-muted-foreground">Grant Management Suite</p>
              </div>
            </Link>
          </SidebarHeader>
          
          <SidebarContent className="p-3">
            {NAV_GROUPS.filter((g) => g.groupId !== "admin" || showAdminGroup).map((group) => (
              <NavGroupCollapsible
                key={group.groupId}
                group={group}
                location={location}
                isOpen={navGroupsOpen.has(group.groupId)}
                onToggle={toggleNavGroup}
                user={user}
              />
            ))}
            <div className="pt-2 mt-2 border-t border-sidebar-border">
              <button
                type="button"
                onClick={handleAdvancedToolsToggle}
                className="text-[11px] text-muted-foreground hover:text-sidebar-foreground px-3 py-1.5"
              >
                {showAdvancedTools ? "Hide advanced tools" : "Show advanced tools"}
              </button>
            </div>
          </SidebarContent>

          <SidebarFooter className="border-t border-sidebar-border p-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-9 h-9 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-full flex items-center justify-center">
                  <span className="text-white font-semibold text-sm">{initials}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sidebar-foreground text-sm truncate">{displayName}</p>
                  {displayEmail ? <p className="text-xs text-muted-foreground truncate">{displayEmail}</p> : null}
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="p-2 hover:bg-sidebar-accent rounded-lg transition-colors"
                title="Logout"
              >
                <LogOut className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
            <LanguageSwitcher className="w-full justify-start" />
            {isAdmin ? (
              <div>
                <div className="w-full rounded-md border border-input bg-muted/50 px-3 py-2 text-sm text-sidebar-foreground">
                  {displayName} (Admin View)
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Workspace shows data for{' '}
                  <span className="font-medium text-sidebar-foreground">all profiles (admin)</span>
                </p>
              </div>
            ) : profiles?.length > 0 ? (
              <div>
                <Select value={selectedProfileId || undefined} onValueChange={handleProfileChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Switch profile" />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.display_name ?? profile.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Workspace shows data for{' '}
                  <span className="font-medium text-sidebar-foreground">
                    {profiles.find((p) => p.id === activeProfileId)?.display_name ??
                      profiles[0]?.display_name ??
                      'your organization'}
                  </span>
                </p>
              </div>
            ) : null}
            <div className="pt-3 border-t border-sidebar-border text-center text-xs text-muted-foreground">
              Created by <span className="font-semibold text-sidebar-foreground">John White</span>
            </div>
          </SidebarFooter>
        </Sidebar>

        <main className="flex-1 flex flex-col overflow-hidden">
          <header className="bg-background/80 backdrop-blur border-b border-border px-4 md:px-6 py-3 flex flex-col gap-2 sticky top-0 z-20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 md:gap-4">
                <SidebarTrigger className="hover:bg-muted p-2 rounded-lg transition-colors duration-200 md:hidden" />
                <div>
                  <h1 className="text-lg md:text-xl font-semibold text-foreground leading-tight">GrantFlow</h1>
                  <p className="text-xs text-muted-foreground">AI-assisted grant management workspace</p>
                </div>
              </div>
          <div className="flex items-center gap-2 md:gap-3">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="hidden md:inline-flex"
            >
              <Link to={createPageUrl('Help')}>
                <Sparkles className="w-3.5 h-3.5 mr-2" />
                User Manual
              </Link>
            </Button>
            <NotificationBell />
            <Button
              variant="outline"
              size="icon"
              onClick={toggleDarkMode}
              title={dashboardPrefs.darkMode ? "Switch to light mode" : "Switch to dark mode"}
            >
              {dashboardPrefs.darkMode ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </Button>
              <Button variant="ghost" className="flex items-center gap-2 px-2">
                <Avatar className="w-8 h-8">
                  <AvatarImage src={user?.avatar_url ?? ''} alt={displayName} />
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
                <div className="hidden md:block text-left">
                  <p className="text-sm font-medium text-foreground">{displayName}</p>
                  {displayEmail ? <p className="text-xs text-muted-foreground">{displayEmail}</p> : null}
                </div>
              </Button>
            </div>
            </div>
            <div className="flex flex-col gap-1.5 min-w-0">
              <AppBreadcrumb />
              <GrantLifecyclePhaseIndicator />
            </div>
          </header>

          <div className="flex-1 overflow-auto bg-background text-foreground">
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

        {/*
          Onboarding is now handled OUTSIDE the layout: new users land at
          /start (Anya conversational quiz) and finish there with a profile +
          email-OTP credential. The previous OnboardingFlow,
          ProfileCreationWizard, and FirstRunOnboardingGate modals are
          intentionally not rendered here — keeping them mounted alongside
          /start would re-introduce the duplicate-modal bug we set out to
          eliminate.
         */}

        {/* Anya guided tour (versioned, non-admin only) */}
        <AnyaGuidedTour />

        {/*
          Per-page coach prompt (plain-English "what is this page for / what
          to do next"). Shown at most once per (page, profile) via
          localStorage. Mounted exactly once here — DO NOT mount in
          src/pages/index.jsx or any page-level file.
        */}
        <UserStepCoach />

        {/*
          Anya Match Scout — recommend-only popup that polls
          /api/anya/match-suggestions/pending and shows a friendly toast
          with [Add to Pipeline] / [Not right now] buttons. Never
          auto-adds. Mounted exactly once here, alongside AnyaFloatingButton.
        */}
        <AnyaMatchScoutAlerts />

        {/* Robert — Funding Discovery Agent. Polls
            /api/robert/recommendations/stream for the active profile and
            shows toasts with [View Details] / [Yes, Add to Pipeline] /
            [No, Keep in Resources]. Robert never auto-adds. */}
        <RobertRecommendationListener />

        {/* Anya AI Assistant Floating Button */}
        <AnyaFloatingButton profileId={activeProfileId} />
      </div>
    </SidebarProvider>
  )
  return copilotEnabled ? <AnyaContextProvider>{content}</AnyaContextProvider> : content
}
