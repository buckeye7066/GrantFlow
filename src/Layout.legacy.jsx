/**
 * DEPRECATED: Canonical layout is src/pages/Layout.jsx (used by src/pages/index.jsx).
 * This file is kept for reference only. Do not import.
 */
import React from "react";
import { Link, useLocation } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { 
  LayoutDashboard, 
  Building2, 
  Search, 
  Kanban, 
  FileText, 
  DollarSign, 
  FolderOpen, 
  Calendar,
  BarChart3,
  LogOut,
  Brain,
  FileStack,
  Database,
  DatabaseZap,
  ShieldCheck,
  Beaker,
  Target,
} from "lucide-react";
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
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import AutoTimeTracker from "@/components/billing/AutoTimeTracker";

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
    title: "Discover Grants",
    url: createPageUrl("DiscoverGrants"),
    icon: Search,
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
    title: "Billing & Invoicing",
    url: createPageUrl("Billing"),
    icon: DollarSign,
  },
  {
    title: "Services",
    url: createPageUrl("Services"),
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
    title: "Data Sources",
    url: createPageUrl("DataSources"),
    icon: Database,
  },
  {
    title: "Source Directory",
    url: createPageUrl("SourceDirectory"),
    icon: DatabaseZap,
  },
];

const developerItems = [
  {
    title: "Printable Application",
    url: createPageUrl("PrintableApplication"),
    icon: FileText,
  },
  {
    title: "Diagnostics",
    url: createPageUrl("Diagnostics"),
    icon: Beaker,
  },
];

export default function Layout({ children, currentPageName }) {
  const location = useLocation();

  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
    retry: false,
  });

  const handleLogout = () => {
    base44.auth.logout();
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

          <SidebarFooter className="border-t border-slate-200 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-9 h-9 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-full flex items-center justify-center">
                  <span className="text-white font-semibold text-sm">
                    {user?.full_name?.[0]?.toUpperCase() || 'U'}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-900 text-sm truncate">
                    {user?.full_name || 'User'}
                  </p>
                  <p className="text-xs text-slate-500 truncate">{user?.email || 'Loading...'}</p>
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
            <div className="mt-3 pt-3 border-t border-slate-100">
              <p className="text-xs text-center text-slate-400">
                Created by <span className="font-semibold text-slate-600">John White</span>
              </p>
            </div>
          </SidebarFooter>
        </Sidebar>

        <main className="flex-1 flex flex-col overflow-hidden">
          <header className="bg-white border-b border-slate-200 px-6 py-4 md:hidden">
            <div className="flex items-center gap-4">
              <SidebarTrigger className="hover:bg-slate-100 p-2 rounded-lg transition-colors duration-200" />
              <h1 className="text-xl font-bold text-slate-900">GrantFlow</h1>
            </div>
          </header>

          <div className="flex-1 overflow-auto">
            {/* Auto Time Tracker - tracks time spent on organization pages */}
            <AutoTimeTracker />
            {children}
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
