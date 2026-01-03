
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
  Settings,
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
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuthStore } from "@/stores/authStore";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import AnyaFloatingButton from "@/components/anya/AnyaFloatingButton";

const navigationItems = [
  {
    title: "Dashboard",
    url: createPageUrl("Dashboard"),
    icon: LayoutDashboard,
  },
  {
    title: "Organizations",
    url: createPageUrl("Organizations"),
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
    title: "Contact Admin",
    url: createPageUrl("ContactAdmin"),
    icon: MessageSquare,
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

export default function Layout({ children, currentPageName }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { state: dashboardPrefs } = useDashboardPreferences();
  const { user, profiles, activeProfileId, setActiveProfileId, logout } = useAuthStore((state) => ({
    user: state.user,
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
    setActiveProfileId: state.setActiveProfileId,
    logout: state.logout,
  }));

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
    setActiveProfileId(value || null);
    if (value) {
      navigate(`/OrganizationProfile?id=${value}`);
    }
  };

  const handleLogout = () => {
    logout();
  };

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-gradient-to-br from-slate-50 via-blue-50 to-slate-50">
        <Sidebar className="border-r border-slate-200 bg-white">
          <SidebarHeader className="border-b border-slate-200 p-6">
            <Link to={createPageUrl("Dashboard")} className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-blue-800 rounded-xl flex items-center justify-center shadow-lg">
                <FileText className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="font-bold text-slate-900 text-lg">GrantFlow</h2>
                <p className="text-xs text-slate-500">Grant Management Suite</p>
              </div>
            </Link>
          </SidebarHeader>
          
          <SidebarContent className="p-3">
            <SidebarGroup>
              <SidebarGroupLabel className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 py-2">
                Navigation
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navigationItems.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton 
                        asChild 
                        className={`hover:bg-blue-50 hover:text-blue-700 transition-all duration-200 rounded-lg mb-1 ${
                          location.pathname === item.url ? 'bg-blue-600 text-white hover:bg-blue-700 hover:text-white shadow-md' : ''
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
              <SidebarGroupLabel className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 py-2">
                Developer
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {developerItems.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton 
                        asChild 
                        className={`hover:bg-blue-50 hover:text-blue-700 transition-all duration-200 rounded-lg mb-1 ${
                          location.pathname === item.url ? 'bg-blue-600 text-white hover:bg-blue-700 hover:text-white shadow-md' : ''
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
          </SidebarContent>

          <SidebarFooter className="border-t border-slate-200 p-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-9 h-9 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-full flex items-center justify-center">
                  <span className="text-white font-semibold text-sm">{initials}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-900 text-sm truncate">{displayName}</p>
                  {displayEmail ? <p className="text-xs text-slate-500 truncate">{displayEmail}</p> : null}
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
                title="Logout"
              >
                <LogOut className="w-4 h-4 text-slate-600" />
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
                  </SelectContent>
                </Select>
                <p className="mt-2 text-[11px] text-slate-500">
                  Workspace shows data for{' '}
                  <span className="font-medium text-slate-700">
                    {profiles.find((p) => p.id === activeProfileId)?.display_name ??
                      profiles[0]?.display_name ??
                      'your organization'}
                  </span>
                </p>
              </div>
            ) : null}
            <div className="pt-3 border-t border-slate-100 text-center text-xs text-slate-400">
              Created by <span className="font-semibold text-slate-600">John White</span>
            </div>
          </SidebarFooter>
        </Sidebar>

        <main className="flex-1 flex flex-col overflow-hidden">
          <header className="bg-white/80 backdrop-blur border-b border-slate-200 px-4 md:px-6 py-3 flex items-center justify-between sticky top-0 z-20">
            <div className="flex items-center gap-3 md:gap-4">
              <SidebarTrigger className="hover:bg-slate-100 p-2 rounded-lg transition-colors duration-200 md:hidden" />
              <div>
                <h1 className="text-lg md:text-xl font-semibold text-slate-900 leading-tight">GrantFlow</h1>
                <p className="text-xs text-slate-500">AI-assisted grant management workspace</p>
              </div>
            </div>
            <div className="flex items-center gap-2 md:gap-3">
              <Button variant="outline" size="sm" className="hidden md:inline-flex">
                <Sparkles className="w-3.5 h-3.5 mr-2" />
                Tutorial
              </Button>
              <Button variant="outline" size="icon">
                <Sun className="w-4 h-4" />
              </Button>
              <Button variant="ghost" className="flex items-center gap-2 px-2">
                <Avatar className="w-8 h-8">
                  <AvatarImage src={user?.avatar_url ?? ''} alt={displayName} />
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
                <div className="hidden md:block text-left">
                  <p className="text-sm font-medium text-slate-900">{displayName}</p>
                  {displayEmail ? <p className="text-xs text-slate-500">{displayEmail}</p> : null}
                </div>
              </Button>
            </div>
          </header>

          <div className={`flex-1 overflow-auto ${dashboardPrefs.darkMode ? 'bg-slate-950' : 'bg-slate-50'}`}>
            <div className="min-h-full">
              <AutoTimeTracker />
              {children}
            </div>
          </div>
        </main>

        {/* Anya AI Assistant Floating Button */}
        <AnyaFloatingButton profileId={activeProfileId} />
      </div>
    </SidebarProvider>
  );
}
