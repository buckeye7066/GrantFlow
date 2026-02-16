import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import {
  LayoutDashboard,
  Building2,
  HandCoins,
  Search,
  Sparkles,
  Boxes,
  Target,
  Kanban,
  MessageSquare,
  Megaphone,
  CalendarClock,
  BarChart3,
  FileText,
  ShieldCheck,
  DollarSign,
  FolderOpen,
  Calendar,
  LineChart,
  Workflow,
  Layers,
  LogOut,
  Brain,
  FileStack,
  Database,
  DatabaseZap,
  Beaker,
  Sun,
  Moon,
  Settings,
  Shield,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import AutoTimeTracker from "@/components/billing/AutoTimeTracker";
import { useDashboardPreferences } from "@/contexts/DashboardPreferencesContext.jsx";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuthStore } from "@/stores/authStore";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import AnyaFloatingButton from "@/components/anya/AnyaFloatingButton";
import ProBonoBanner from "@/components/banners/ProBonoBanner.jsx";
import { apiFetch } from "@/api/client";

const navigationItems = [
  {
    title: "Dashboard",
    url: createPageUrl("Dashboard"),
    icon: LayoutDashboard,
  },
  {
    title: "My Profiles",
    url: createPageUrl("MyProfiles"),
    icon: Building2,
  },
  {
    title: "Funder",
    url: createPageUrl("Funder"),
    icon: HandCoins,
  },
  {
    title: "Discover Grants",
    url: createPageUrl("DiscoverGrants"),
    icon: Search,
  },
  {
    title: "Smart Matcher",
    url: createPageUrl("SmartMatcher"),
    icon: Sparkles,
  },
  {
    title: "Item Funding",
    url: createPageUrl("ItemFunding"),
    icon: Boxes,
  },
  {
    title: "Profile Matcher",
    url: createPageUrl("ProfileMatcher"),
    icon: Target,
  },
  {
    title: "Pipeline",
    url: createPageUrl("Pipeline"),
    icon: Kanban,
  },
  {
    title: "Outreach",
    url: createPageUrl("Outreach"),
    icon: Megaphone,
  },
  {
    title: "Grant Deadline",
    url: createPageUrl("GrantDeadline"),
    icon: CalendarClock,
  },
  {
    title: "Grant Monitoring",
    url: createPageUrl("GrantMonitoring"),
    icon: BarChart3,
  },
  {
    title: "Proposals",
    url: createPageUrl("Proposals"),
    icon: FileText,
  },
  {
    title: "Stewardship",
    url: createPageUrl("Stewardship"),
    icon: ShieldCheck,
  },
  {
    title: "Reports & Analytics",
    url: createPageUrl("Reports"),
    icon: BarChart3,
  },
  {
    title: "Advanced Analytics",
    url: createPageUrl("AdvancedAnalytics"),
    icon: LineChart,
  },
  {
    title: "Billing & Invoicing",
    url: createPageUrl("Billing"),
    icon: DollarSign,
  },
  {
    title: "Budgets",
    url: createPageUrl("Budgets"),
    icon: DollarSign,
  },
  {
    title: "Documents",
    url: createPageUrl("Documents"),
    icon: FolderOpen,
  },
  {
    title: "Calendar",
    url: createPageUrl("Calendar"),
    icon: Calendar,
  },
  {
    title: "Automation",
    url: createPageUrl("Automation"),
    icon: Workflow,
  },
  {
    title: "Funding Opportunities",
    url: createPageUrl("FundingOpportunities"),
    icon: Layers,
  },
  {
    title: "Data Sources",
    url: createPageUrl("DataSources"),
    icon: Database,
  },
  {
    title: "Source Directory",
    url: createPageUrl("SourceDirectory"),
    icon: DatabaseZap,
  },
  {
    title: "Printable Application",
    url: createPageUrl("PrintableApplication"),
    icon: FileText,
  },
  {
    title: "AI Grant Scorer",
    url: createPageUrl("AIGrantScorer"),
    icon: Brain,
  },
  {
    title: "NOFO Parser",
    url: createPageUrl("NOFOParser"),
    icon: FileStack,
  },
  {
    title: "Settings",
    url: createPageUrl("Settings"),
    icon: Settings,
  },
]

const developerItems = [
  {
    title: "Diagnostics",
    url: createPageUrl("Diagnostics"),
    icon: Beaker,
  },
];

const adminItems = [
  {
    title: "Admin Panel",
    url: createPageUrl("Admin"),
    icon: Shield,
  },
];

export default function Layout({ children, currentPageName }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { state: dashboardPrefs, dispatch: preferencesDispatch } = useDashboardPreferences();
  const { user, profiles, activeProfileId, setActiveProfileId, logout, triggerOnboardingVideo } = useAuthStore((state) => ({
    user: state.user,
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
    setActiveProfileId: state.setActiveProfileId,
    logout: state.logout,
    triggerOnboardingVideo: state.triggerOnboardingVideo,
  }));
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  const toggleDarkMode = React.useCallback(() => {
    preferencesDispatch({
      type: "SET_DARK_MODE",
      enabled: !dashboardPrefs.darkMode,
    })
  }, [dashboardPrefs.darkMode, preferencesDispatch])

  const displayName = user?.display_name || user?.full_name || 'User';
  const displayEmail = user?.primary_email || user?.email || undefined;
  const selectedProfileId = activeProfileId ?? (profiles?.[0]?.id ?? '');
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

  return (
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
            <SidebarGroup>
              <SidebarGroupLabel className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 py-2">
                Navigation
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navigationItems.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton 
                        asChild 
                        className={`transition-all duration-200 rounded-lg mb-1 ${
                          location.pathname === item.url
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                        }`}
                      >
                        <Link to={item.url} className="flex items-center gap-3 px-3 py-2.5">
                          <item.icon className="w-4 h-4" />
                          <span className="font-medium">{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup className="mt-4">
              <SidebarGroupLabel className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 py-2">
                Developer
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {developerItems.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton 
                        asChild 
                        className={`transition-all duration-200 rounded-lg mb-1 ${
                          location.pathname === item.url
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                        }`}
                      >
                        <Link to={item.url} className="flex items-center gap-3 px-3 py-2.5">
                          <item.icon className="w-4 h-4" />
                          <span className="font-medium">{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            {user?.is_admin && (
              <SidebarGroup className="mt-4">
                <SidebarGroupLabel className="text-xs font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wider px-3 py-2">
                  Admin
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {adminItems.map((item) => (
                      <SidebarMenuItem key={item.title}>
                        <SidebarMenuButton 
                          asChild 
                          className={`transition-all duration-200 rounded-lg mb-1 ${
                            location.pathname === item.url
                              ? 'bg-amber-600 text-white shadow-sm'
                              : 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                          }`}
                        >
                          <Link to={item.url} className="flex items-center gap-3 px-3 py-2.5">
                            <item.icon className="w-4 h-4" />
                            <span className="font-medium">{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
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
            {profiles?.length > 0 ? (
              <div>
                <Select value={selectedProfileId} onValueChange={handleProfileChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Switch profile" />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.display_name ?? profile.id}
                      </SelectItem>
                    ))}
                                  {user?.is_admin && (
                                                    <SelectItem key="__admin__" value="__admin__">
                                                                        buckeye7066 (Admin View)
                                                                                        </SelectItem>
                                  )}
                  </SelectContent>
                </Select>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Workspace shows data for{' '}
                  <span className="font-medium text-sidebar-foreground">
                                    {activeProfileId === '__admin__' ? 'buckeye7066 (Admin)' : (profiles.find((p) => p.id === activeProfileId)?.display_name ??
                                                      profiles[0]?.display_name ??
                                                                        'your organization')}
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
          <header className="bg-background/80 backdrop-blur border-b border-border px-4 md:px-6 py-3 flex items-center justify-between sticky top-0 z-20">
            <div className="flex items-center gap-3 md:gap-4">
              <SidebarTrigger className="hover:bg-muted p-2 rounded-lg transition-colors duration-200 md:hidden" />
              <div>
                <h1 className="text-lg md:text-xl font-semibold text-foreground leading-tight">GrantFlow</h1>
                <p className="text-xs text-muted-foreground">AI-assisted grant management workspace</p>
              </div>
            </div>
          <div className="flex items-center gap-2 md:gap-3">
            <Button
              variant="outline"
              size="sm"
              className="hidden md:inline-flex"
              onClick={triggerOnboardingVideo}
            >
              <Sparkles className="w-3.5 h-3.5 mr-2" />
              Tutorial
            </Button>
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
          </header>

          <div className="flex-1 overflow-auto bg-background text-foreground">
            <div className="min-h-full">
              <AutoTimeTracker />
              <ProBonoBanner />
              {children}
            </div>
          </div>
        </main>

        {/* Onboarding Flow */}
        <OnboardingFlow />

        {/* Anya AI Assistant Floating Button */}
        <AnyaFloatingButton profileId={activeProfileId} />
      </div>
    </SidebarProvider>
  );
}
