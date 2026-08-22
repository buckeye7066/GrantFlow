/**
 * Centralized navigation config for simplified UX.
 * Outcome terminology for non-technical users.
 * Max 5 primary sidebar items; rest under "More".
 */
import { createPageUrl } from "@/utils";
import {
  LayoutDashboard,
  Building2,
  Search,
  Kanban,
  FolderOpen,
  BarChart3,
  DollarSign,
  Calendar,
  FileText,
  CalendarClock,
  Megaphone,
  LineChart,
  Workflow,
  Layers,
  Database,
  DatabaseZap,
  Brain,
  FileStack,
  Settings,
  Beaker,
  Shield,
  Library,
} from "lucide-react";

/** Route path (no leading slash in key) → human label for breadcrumb/phase */
export const ROUTE_LABELS = {
  Dashboard: "Home",
  Organizations: "Your Organization",
  MyProfiles: "Your Organization",
  OrganizationProfile: "Organization",
  ProfileDetail: "Profile",
  Funder: "Funders",
  DiscoverGrants: "Find Grants",
  SmartMatcher: "Find Grants",
  FundingOpportunities: "Find Grants",
  FundingLibrary: "Funding Library",
  ItemFunding: "Item Funding",
  ProfileMatcher: "Match to Grants",
  Pipeline: "Your Applications",
  GrantDetail: "Grant",
  Apply: "Apply",
  VNextApplication: "Application",
  VNextFinishPacket: "Finish Application",
  Outreach: "Outreach",
  GrantDeadline: "Deadlines",
  GrantMonitoring: "Tracking",
  Proposals: "Proposals",
  Reports: "Reports & Analytics",
  AdvancedAnalytics: "Analytics",
  Billing: "Billing & Invoicing",
  Budgets: "Budgets",
  BudgetDetail: "Budget",
  Documents: "Prepare Materials",
  Calendar: "Calendar",
  Automation: "Automation",
  DataSources: "Data Sources",
  SourceDirectory: "Funding Sources",
  SourceRegistry: "Source Registry",
  PrintableApplication: "Printable Application",
  AIGrantScorer: "AI Scorer",
  NOFOParser: "Parse NOFO",
  CreateInvoice: "Create Invoice",
  InvoiceView: "Invoice",
  BillingSheet: "Billing Sheet",
  Settings: "Settings",
  Diagnostics: "Diagnostics",
  Admin: "Admin",
  ComplianceReportDetail: "Compliance",
  NewProject: "New Project",
  OneTimeFix: "One-Time Fix",
  BackfillContacts: "Backfill Contacts",
};

/** Grant lifecycle phases for persistent phase indicator */
export const LIFECYCLE_PHASES = [
  { id: "setup", label: "Set Up Organization", path: "/MyProfiles" },
  { id: "find", label: "Find Grants", path: "/DiscoverGrants" },
  { id: "review", label: "Review Fit", path: "/Pipeline" },
  { id: "prepare", label: "Prepare Materials", path: "/Documents" },
  { id: "submit", label: "Submit", path: "/Pipeline" },
  { id: "track", label: "Track Status", path: "/Pipeline" },
];

/** Primary nav: max 5 items, outcome-focused */
export const PRIMARY_NAV = [
  { title: "Home", url: createPageUrl("Dashboard"), icon: LayoutDashboard, route: "Dashboard" },
  { title: "Your Organization", url: createPageUrl("MyProfiles"), icon: Building2, route: "MyProfiles" },
  { title: "Find Grants", url: createPageUrl("DiscoverGrants"), icon: Search, route: "DiscoverGrants" },
  { title: "Your Applications", url: createPageUrl("Pipeline"), icon: Kanban, route: "Pipeline" },
  { title: "Prepare & Submit", url: createPageUrl("Documents"), icon: FolderOpen, route: "Documents" },
];

/** Secondary nav under "More" — outcome terminology where specified */
export const MORE_NAV = [
  { title: "Reports & Analytics", url: createPageUrl("Reports"), icon: BarChart3, route: "Reports" },
  { title: "Billing & Invoicing", url: createPageUrl("Billing"), icon: DollarSign, route: "Billing" },
  { title: "Budgets", url: createPageUrl("Budgets"), icon: DollarSign, route: "Budgets" },
  { title: "Calendar", url: createPageUrl("Calendar"), icon: Calendar, route: "Calendar" },
  { title: "Deadlines", url: createPageUrl("GrantDeadline"), icon: CalendarClock, route: "GrantDeadline" },
  { title: "Proposals", url: createPageUrl("Proposals"), icon: FileText, route: "Proposals" },
  { title: "Outreach", url: createPageUrl("Outreach"), icon: Megaphone, route: "Outreach" },
  { title: "Tracking", url: createPageUrl("GrantMonitoring"), icon: BarChart3, route: "GrantMonitoring" },
  { title: "Analytics", url: createPageUrl("AdvancedAnalytics"), icon: LineChart, route: "AdvancedAnalytics" },
  { title: "Automation", url: createPageUrl("Automation"), icon: Workflow, route: "Automation" },
  { title: "Funding Opportunities", url: createPageUrl("FundingOpportunities"), icon: Layers, route: "FundingOpportunities" },
  { title: "Funding Library", url: createPageUrl("FundingLibrary"), icon: Library, route: "FundingLibrary" },
  { title: "Match to Grants", url: createPageUrl("ProfileMatcher"), icon: Search, route: "ProfileMatcher" },
  { title: "Smart Match", url: createPageUrl("SmartMatcher"), icon: Brain, route: "SmartMatcher" },
  { title: "Item Funding", url: createPageUrl("ItemFunding"), icon: FileText, route: "ItemFunding" },
  { title: "Funding Sources", url: createPageUrl("SourceDirectory"), icon: DatabaseZap, route: "SourceDirectory" },
  { title: "Data Sources", url: createPageUrl("DataSources"), icon: Database, route: "DataSources" },
  { title: "Parse NOFO", url: createPageUrl("NOFOParser"), icon: FileStack, route: "NOFOParser" },
  { title: "AI Scorer", url: createPageUrl("AIGrantScorer"), icon: Brain, route: "AIGrantScorer" },
  { title: "Printable Application", url: createPageUrl("PrintableApplication"), icon: FileText, route: "PrintableApplication" },
  { title: "Settings", url: createPageUrl("Settings"), icon: Settings, route: "Settings" },
];

export const DEVELOPER_NAV = [
  { title: "Diagnostics", url: createPageUrl("Diagnostics"), icon: Beaker, route: "Diagnostics" },
];

export const ADMIN_NAV = [
  { title: "Admin Panel", url: createPageUrl("Admin"), icon: Shield, route: "Admin" },
];

/**
 * Get breadcrumb segments from pathname.
 * @param {string} pathname - e.g. "/Pipeline" or "/ProfileDetail"
 * @param {string} [search] - query string for current page label (e.g. id)
 * @returns {{ path: string, label: string }[]}
 */
export function getBreadcrumbFromPath(pathname, search = "") {
  const base = pathname.replace(/^\//, "").split("?")[0];
  const pageName = base || "Dashboard";
  const label = ROUTE_LABELS[pageName] ?? pageName;
  const home = { path: "/Dashboard", label: "Home" };
  if (pageName === "Dashboard" || pageName === "") {
    return [home];
  }
  return [home, { path: pathname + (search ? `?${search}` : ""), label }];
}
