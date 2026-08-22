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
  Sparkles,
  Activity,
} from "lucide-react";

/** @typedef {{ title: string, routeName: string, url: string, icon: import('lucide-react').LucideIcon, isAdminOnly?: boolean, isAdvanced?: boolean }} NavItem */
/** @typedef {{ groupId: string, label: string, icon?: import('lucide-react').LucideIcon, items: NavItem[] }} NavGroup */

/** All nav groups in order. Admin/Operations is gated by user.is_admin or showAdvancedTools. */
export const NAV_GROUPS = [
  {
    groupId: "home",
    label: "Home",
    groupI18nKey: "nav.group.home",
    icon: LayoutDashboard,
    items: [
      { title: "Dashboard", i18nKey: "nav.dashboard", routeName: "Dashboard", url: createPageUrl("Dashboard"), icon: LayoutDashboard },
      { title: "Calendar", i18nKey: "nav.calendar", routeName: "Calendar", url: createPageUrl("Calendar"), icon: Calendar },
    ],
  },
  {
    groupId: "help",
    label: "Help",
    groupI18nKey: "nav.group.help",
    icon: LifeBuoy,
    items: [
      { title: "Help Center", i18nKey: "nav.helpCenter", routeName: "Help", url: createPageUrl("Help"), icon: LifeBuoy },
    ],
  },
  {
    groupId: "setup",
    label: "Setup",
    groupI18nKey: "nav.group.setup",
    icon: Building2,
    items: [
      { title: "My Profiles", i18nKey: "nav.myProfiles", routeName: "MyProfiles", url: createPageUrl("MyProfiles"), icon: Building2 },
      { title: "Organizations", i18nKey: "nav.organizations", routeName: "Organizations", url: createPageUrl("Organizations"), icon: Building2 },
      { title: "Settings", i18nKey: "nav.settings", routeName: "Settings", url: createPageUrl("Settings"), icon: Settings },
    ],
  },
  {
    groupId: "find",
    label: "Find Funding",
    groupI18nKey: "nav.group.find",
    icon: Search,
    items: [
      { title: "Discover Grants", i18nKey: "nav.discoverGrants", routeName: "DiscoverGrants", url: createPageUrl("DiscoverGrants"), icon: Search },
      { title: "Saved Grants", i18nKey: "nav.savedGrants", routeName: "SavedGrants", url: createPageUrl("SavedGrants"), icon: Star },
      { title: "Funding Results", i18nKey: "nav.fundingResults", routeName: "FundingResults", url: createPageUrl("FundingResults"), icon: Search },
      { title: "Smart Matcher", i18nKey: "nav.smartMatcher", routeName: "SmartMatcher", url: createPageUrl("SmartMatcher"), icon: Brain },
      { title: "Profile Matcher", i18nKey: "nav.profileMatcher", routeName: "ProfileMatcher", url: createPageUrl("ProfileMatcher"), icon: Target },
      { title: "Funding Opportunities", i18nKey: "nav.fundingOpportunities", routeName: "FundingOpportunities", url: createPageUrl("FundingOpportunities"), icon: Layers },
      { title: "Funding Library", i18nKey: "nav.fundingLibrary", routeName: "FundingLibrary", url: createPageUrl("FundingLibrary"), icon: Library },
      { title: "Foundation Search", i18nKey: "nav.foundationSearch", routeName: "FoundationSearch", url: createPageUrl("FoundationSearch"), icon: Database },
      { title: "Funder", i18nKey: "nav.funder", routeName: "Funder", url: createPageUrl("Funder"), icon: HandCoins },
      { title: "Data Sources", i18nKey: "nav.dataSources", routeName: "DataSources", url: createPageUrl("DataSources"), icon: Database },
      { title: "Source Directory", i18nKey: "nav.sourceDirectory", routeName: "SourceDirectory", url: createPageUrl("SourceDirectory"), icon: DatabaseZap },
      { title: "NOFO Parser", i18nKey: "nav.nofoParser", routeName: "NOFOParser", url: createPageUrl("NOFOParser"), icon: FileStack, isAdvanced: true },
      { title: "AI Grant Scorer", i18nKey: "nav.aiGrantScorer", routeName: "AIGrantScorer", url: createPageUrl("AIGrantScorer"), icon: Brain, isAdvanced: true },
    ],
  },
  {
    groupId: "work",
    label: "Work",
    groupI18nKey: "nav.group.work",
    icon: Kanban,
    items: [
      { title: "Pipeline", i18nKey: "nav.pipeline", routeName: "Pipeline", url: createPageUrl("Pipeline"), icon: Kanban },
      { title: "Process with Hamilton", i18nKey: "nav.processWithHamilton", routeName: "HamiltonProcessing", url: createPageUrl("HamiltonProcessing"), icon: Sparkles },
      { title: "Applications", i18nKey: "nav.applications", routeName: "Applications", url: createPageUrl("Applications"), icon: ClipboardList },
      { title: "Proposals", i18nKey: "nav.proposals", routeName: "Proposals", url: createPageUrl("Proposals"), icon: FileText },
      { title: "Documents", i18nKey: "nav.documents", routeName: "Documents", url: createPageUrl("Documents"), icon: FolderOpen },
      { title: "Printable Application", i18nKey: "nav.printableApplication", routeName: "PrintableApplication", url: createPageUrl("PrintableApplication"), icon: FileText },
    ],
  },
  {
    groupId: "track",
    label: "Track & Report",
    groupI18nKey: "nav.group.track",
    icon: BarChart3,
    items: [
      { title: "Grant Deadline", i18nKey: "nav.grantDeadline", routeName: "GrantDeadline", url: createPageUrl("GrantDeadline"), icon: CalendarClock },
      { title: "Grant Monitoring", i18nKey: "nav.grantMonitoring", routeName: "GrantMonitoring", url: createPageUrl("GrantMonitoring"), icon: BarChart3 },
      { title: "Reports & Analytics", i18nKey: "nav.reports", routeName: "Reports", url: createPageUrl("Reports"), icon: BarChart3 },
      { title: "Advanced Analytics", i18nKey: "nav.advancedAnalytics", routeName: "AdvancedAnalytics", url: createPageUrl("AdvancedAnalytics"), icon: LineChart },
      { title: "Outreach", i18nKey: "nav.outreach", routeName: "Outreach", url: createPageUrl("Outreach"), icon: Megaphone },
    ],
  },
  {
    groupId: "admin",
    label: "Admin / Operations",
    groupI18nKey: "nav.group.admin",
    icon: Shield,
    items: [
      { title: "Automation", i18nKey: "nav.automation", routeName: "Automation", url: createPageUrl("Automation"), icon: Workflow },
      { title: "Billing & Invoicing", i18nKey: "nav.billing", routeName: "Billing", url: createPageUrl("Billing"), icon: DollarSign },
      { title: "Budgets", i18nKey: "nav.budgets", routeName: "Budgets", url: createPageUrl("Budgets"), icon: DollarSign },
      { title: "Diagnostics", i18nKey: "nav.diagnostics", routeName: "Diagnostics", url: createPageUrl("Diagnostics"), icon: Beaker },
      { title: "Crawl Coverage", i18nKey: "nav.crawlCoverage", routeName: "CrawlCoverage", url: createPageUrl("CrawlCoverage"), icon: Activity, isAdminOnly: true },
      { title: "Admin Panel", i18nKey: "nav.adminPanel", routeName: "Admin", url: createPageUrl("Admin"), icon: Shield, isAdminOnly: true },
      // Incognito extension (privacy/broker removal) - requires incognitoEnabled flag
      { title: "Incognito", i18nKey: "nav.incognito", routeName: "Incognito", url: createPageUrl("Incognito"), icon: ShieldCheck, requiresIncognitoEnabled: true },
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
  SmartMatcher: "Smart Matcher",
  ProfileMatcher: "Profile Matcher",
  Pipeline: "Pipeline",
  HamiltonProcessing: "Process with Hamilton",
  Applications: "Applications",
  GrantDetail: "Grant",
  Apply: "Apply",
  VNextApplication: "Application",
  VNextFinishPacket: "Finish Application",
  Outreach: "Outreach",
  GrantDeadline: "Grant Deadline",
  GrantMonitoring: "Grant Monitoring",
  Proposals: "Proposals",
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
  CrawlCoverage: "Crawl Coverage",
  Admin: "Admin",
  Incognito: "Incognito",
  Help: "Help Center",
  HelpCenter: "Help Center",
};

/**
 * Parallel i18n keys for breadcrumb / page labels. When a route has an entry
 * here, the breadcrumb is rendered through t() so it follows the active
 * language. Routes without an entry fall back to the English ROUTE_LABELS text.
 */
export const ROUTE_LABEL_I18N = {
  Dashboard: "breadcrumb.home",
  Organizations: "nav.organizations",
  MyProfiles: "nav.myProfiles",
  OrganizationProfile: "route.organization",
  ProfileDetail: "route.profile",
  Funder: "nav.funder",
  DiscoverGrants: "nav.discoverGrants",
  SavedGrants: "nav.savedGrants",
  FundingResults: "nav.fundingResults",
  FoundationSearch: "nav.foundationSearch",
  FundingOpportunities: "nav.fundingOpportunities",
  FundingLibrary: "nav.fundingLibrary",
  ItemFunding: "route.itemFunding",
  SmartMatcher: "nav.smartMatcher",
  ProfileMatcher: "nav.profileMatcher",
  Pipeline: "nav.pipeline",
  HamiltonProcessing: "nav.processWithHamilton",
  Applications: "nav.applications",
  GrantDetail: "route.grant",
  Apply: "route.apply",
  VNextApplication: "route.application",
  VNextFinishPacket: "route.finishApplication",
  Outreach: "nav.outreach",
  GrantDeadline: "nav.grantDeadline",
  GrantMonitoring: "nav.grantMonitoring",
  Proposals: "nav.proposals",
  Reports: "nav.reports",
  AdvancedAnalytics: "nav.advancedAnalytics",
  Billing: "nav.billing",
  Budgets: "nav.budgets",
  Documents: "nav.documents",
  Calendar: "nav.calendar",
  Automation: "nav.automation",
  DataSources: "nav.dataSources",
  SourceDirectory: "nav.sourceDirectory",
  PrintableApplication: "nav.printableApplication",
  AIGrantScorer: "nav.aiGrantScorer",
  NOFOParser: "nav.nofoParser",
  Settings: "nav.settings",
  Diagnostics: "nav.diagnostics",
  CrawlCoverage: "nav.crawlCoverage",
  Admin: "nav.adminPanel",
  Incognito: "nav.incognito",
  Help: "nav.helpCenter",
  HelpCenter: "nav.helpCenter",
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
  const pageLabelI18nKey = ROUTE_LABEL_I18N[routeName];
  const home = { path: createPageUrl("Dashboard"), label: "Home", labelI18nKey: "breadcrumb.home" };
  if (routeName === "Dashboard" || routeName === "") {
    return [home];
  }
  const groupLabel = group?.label ?? "App";
  const groupLabelI18nKey = group?.groupI18nKey;
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
      { path: currentPath, label: pageLabel, labelI18nKey: pageLabelI18nKey, isCurrent: true },
    ];
  }

  return [
    home,
    { path: groupPath, label: groupLabel, labelI18nKey: groupLabelI18nKey },
    { path: currentPath, label: pageLabel, labelI18nKey: pageLabelI18nKey, isCurrent: true },
  ];
}
