/**
 * Single source of truth for sidebar navigation.
 * Groups are collapsible; only Admin/Operations is gated (is_admin or advanced tools).
 */
import { createPageUrl } from "@/utils";
import {
  LayoutDashboard,
  LifeBuoy,
  Building2,
  Search,
  Kanban,
  FolderOpen,
  FileText,
  ClipboardList,
  Calendar,
  CalendarClock,
  BarChart3,
  LineChart,
  Megaphone,
  DollarSign,
  Workflow,
  Beaker,
  Shield,
  Settings,
  Layers,
  Database,
  DatabaseZap,
  Brain,
  FileStack,
  Target,
  HandCoins,
  ShieldCheck,
  Star,
  Library,
} from "lucide-react";

/** @typedef {{ title: string, routeName: string, url: string, icon: import('lucide-react').LucideIcon, isAdminOnly?: boolean, isAdvanced?: boolean }} NavItem */
/** @typedef {{ groupId: string, label: string, icon?: import('lucide-react').LucideIcon, items: NavItem[] }} NavGroup */

/** All nav groups in order. Admin/Operations is gated by user.is_admin or showAdvancedTools. */
export const NAV_GROUPS = [
  {
    groupId: "home",
    label: "Home",
    icon: LayoutDashboard,
    items: [
      { title: "Dashboard", routeName: "Dashboard", url: createPageUrl("Dashboard"), icon: LayoutDashboard },
      { title: "Calendar", routeName: "Calendar", url: createPageUrl("Calendar"), icon: Calendar },
    ],
  },
  {
    groupId: "help",
    label: "Help",
    icon: LifeBuoy,
    items: [
      { title: "Help Center", routeName: "Help", url: createPageUrl("Help"), icon: LifeBuoy },
    ],
  },
  {
    groupId: "setup",
    label: "Setup",
    icon: Building2,
    items: [
      { title: "My Profiles", routeName: "MyProfiles", url: createPageUrl("MyProfiles"), icon: Building2 },
      { title: "Organizations", routeName: "Organizations", url: createPageUrl("Organizations"), icon: Building2 },
      { title: "Settings", routeName: "Settings", url: createPageUrl("Settings"), icon: Settings },
    ],
  },
  {
    groupId: "find",
    label: "Find Funding",
    icon: Search,
    items: [
      { title: "Discover Grants", routeName: "DiscoverGrants", url: createPageUrl("DiscoverGrants"), icon: Search },
      { title: "Saved Grants", routeName: "SavedGrants", url: createPageUrl("SavedGrants"), icon: Star },
      { title: "Funding Results", routeName: "FundingResults", url: createPageUrl("FundingResults"), icon: Search },
      { title: "Smart Matcher", routeName: "SmartMatcher", url: createPageUrl("SmartMatcher"), icon: Brain },
      { title: "Profile Matcher", routeName: "ProfileMatcher", url: createPageUrl("ProfileMatcher"), icon: Target },
      { title: "Funding Opportunities", routeName: "FundingOpportunities", url: createPageUrl("FundingOpportunities"), icon: Layers },
      { title: "Funding Library", routeName: "FundingLibrary", url: createPageUrl("FundingLibrary"), icon: Library },
      { title: "Foundation Search", routeName: "FoundationSearch", url: createPageUrl("FoundationSearch"), icon: Database },
      { title: "Funder", routeName: "Funder", url: createPageUrl("Funder"), icon: HandCoins },
      { title: "Data Sources", routeName: "DataSources", url: createPageUrl("DataSources"), icon: Database },
      { title: "Source Directory", routeName: "SourceDirectory", url: createPageUrl("SourceDirectory"), icon: DatabaseZap },
      { title: "NOFO Parser", routeName: "NOFOParser", url: createPageUrl("NOFOParser"), icon: FileStack, isAdvanced: true },
      { title: "AI Grant Scorer", routeName: "AIGrantScorer", url: createPageUrl("AIGrantScorer"), icon: Brain, isAdvanced: true },
    ],
  },
  {
    groupId: "work",
    label: "Work",
    icon: Kanban,
    items: [
      { title: "Pipeline", routeName: "Pipeline", url: createPageUrl("Pipeline"), icon: Kanban },
      { title: "Applications", routeName: "Applications", url: createPageUrl("Applications"), icon: ClipboardList },
      { title: "Proposals", routeName: "Proposals", url: createPageUrl("Proposals"), icon: FileText },
      { title: "Documents", routeName: "Documents", url: createPageUrl("Documents"), icon: FolderOpen },
      { title: "Printable Application", routeName: "PrintableApplication", url: createPageUrl("PrintableApplication"), icon: FileText },
    ],
  },
  {
    groupId: "track",
    label: "Track & Report",
    icon: BarChart3,
    items: [
      { title: "Grant Deadline", routeName: "GrantDeadline", url: createPageUrl("GrantDeadline"), icon: CalendarClock },
      { title: "Grant Monitoring", routeName: "GrantMonitoring", url: createPageUrl("GrantMonitoring"), icon: BarChart3 },
      { title: "Reports & Analytics", routeName: "Reports", url: createPageUrl("Reports"), icon: BarChart3 },
      { title: "Advanced Analytics", routeName: "AdvancedAnalytics", url: createPageUrl("AdvancedAnalytics"), icon: LineChart },
      { title: "Outreach", routeName: "Outreach", url: createPageUrl("Outreach"), icon: Megaphone },
      { title: "Stewardship", routeName: "Stewardship", url: createPageUrl("Stewardship"), icon: ShieldCheck },
    ],
  },
  {
    groupId: "admin",
    label: "Admin / Operations",
    icon: Shield,
    items: [
      { title: "Automation", routeName: "Automation", url: createPageUrl("Automation"), icon: Workflow },
      { title: "Billing & Invoicing", routeName: "Billing", url: createPageUrl("Billing"), icon: DollarSign },
      { title: "Budgets", routeName: "Budgets", url: createPageUrl("Budgets"), icon: DollarSign },
      { title: "Diagnostics", routeName: "Diagnostics", url: createPageUrl("Diagnostics"), icon: Beaker },
      { title: "Admin Panel", routeName: "Admin", url: createPageUrl("Admin"), icon: Shield, isAdminOnly: true },
      // Incognito extension (privacy/broker removal) - requires incognitoEnabled flag
      { title: "Incognito", routeName: "Incognito", url: createPageUrl("Incognito"), icon: ShieldCheck, requiresIncognitoEnabled: true },
    ],
  },
];

const STORAGE_KEY = "grantflow:nav-groups-open";

/** Get persisted open group IDs (set of groupId). */
export function getNavGroupsOpen() {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

/** Persist which groups are open. */
export function setNavGroupsOpen(openSet) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...openSet]));
  } catch { /* ignore */ }
}

/** Resolve route path (e.g. "Pipeline") to groupId for breadcrumb / expand-active. */
export function getGroupIdForRoute(pathname) {
  const segment = pathname.replace(/^\//, "").split("/")[0] || "Dashboard";
  const routeName = segment.split("?")[0];
  for (const group of NAV_GROUPS) {
    if (group.items.some((item) => item.routeName === routeName)) return group.groupId;
  }
  return "home";
}

/** Route name → human label for breadcrumb / page title. */
export const ROUTE_LABELS = {
  Dashboard: "Home",
  Organizations: "Organizations",
  MyProfiles: "My Profiles",
  OrganizationProfile: "Organization",
  ProfileDetail: "Profile",
  Funder: "Funders",
  DiscoverGrants: "Discover Grants",
  SavedGrants: "Saved Grants",
  FundingResults: "Funding Results",
  FoundationSearch: "Foundation Search",
  FundingOpportunities: "Funding Opportunities",
  FundingLibrary: "Funding Library",
  ItemFunding: "Item Funding",
  ProfileMatcher: "Profile Matcher",
  Pipeline: "Pipeline",
  Applications: "Applications",
  GrantDetail: "Grant",
  Apply: "Apply",
  VNextApplication: "Application",
  VNextFinishPacket: "Finish Application",
  Outreach: "Outreach",
  GrantDeadline: "Grant Deadline",
  GrantMonitoring: "Grant Monitoring",
  Proposals: "Proposals",
  Stewardship: "Stewardship",
  Reports: "Reports",
  AdvancedAnalytics: "Advanced Analytics",
  Billing: "Billing & Invoicing",
  Budgets: "Budgets",
  Documents: "Documents",
  Calendar: "Calendar",
  Automation: "Automation",
  DataSources: "Data Sources",
  SourceDirectory: "Source Directory",
  SourceRegistry: "Source Registry",
  PrintableApplication: "Printable Application",
  AIGrantScorer: "AI Grant Scorer",
  NOFOParser: "NOFO Parser",
  Settings: "Settings",
  Diagnostics: "Diagnostics",
  Admin: "Admin",
  Incognito: "Incognito",
  Help: "Help Center",
  HelpCenter: "Help Center",
};

/** Grant lifecycle for header phase indicator. */
export const LIFECYCLE_PHASES = [
  { id: "setup", label: "Set Up Organization", path: "/MyProfiles" },
  { id: "find", label: "Find Grants", path: "/DiscoverGrants" },
  { id: "review", label: "Review Fit", path: "/Pipeline" },
  { id: "prepare", label: "Prepare Materials", path: "/Documents" },
  { id: "submit", label: "Submit", path: "/Applications" },
  { id: "track", label: "Track Status", path: "/Applications" },
];

/**
 * Breadcrumb segments: Home › Group › Page.
 * Group links to first item in that group; Page is current (no link).
 */
export function getBreadcrumbSegments(pathname, search = "") {
  const segment = pathname.replace(/^\//, "").split("/")[0] || "Dashboard";
  const routeName = segment.split("?")[0];
  const groupId = getGroupIdForRoute(pathname);
  const group = NAV_GROUPS.find((g) => g.groupId === groupId);
  const pageLabel = ROUTE_LABELS[routeName] ?? routeName;
  const home = { path: createPageUrl("Dashboard"), label: "Home" };
  if (routeName === "Dashboard" || routeName === "") {
    return [home];
  }
  const groupLabel = group?.label ?? "App";
  const groupPath = group?.items?.[0]?.url ?? createPageUrl("Dashboard");
  const currentPath = pathname + (search ? `?${search}` : "");

  // Skip the group breadcrumb segment in two cases, to avoid a redundant middle crumb:
  //  1. Single-item groups (e.g. "Home > Help > Help Center" -> "Home > Help Center").
  //  2. The "home" group itself, whose label is literally "Home" — the fixed first
  //     crumb already represents it, so without this Calendar rendered
  //     "Home > Home > Calendar". Show "Home > Calendar" instead.
  const isSingleItemGroup = group?.items?.length === 1;
  const isHomeGroup = groupId === "home";
  if (isSingleItemGroup || isHomeGroup) {
    return [
      home,
      { path: currentPath, label: pageLabel, isCurrent: true },
    ];
  }

  return [
    home,
    { path: groupPath, label: groupLabel },
    { path: currentPath, label: pageLabel, isCurrent: true },
  ];
}
