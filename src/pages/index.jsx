import React, { Suspense, lazy } from "react";
import Layout from "./Layout.jsx";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";

const Dashboard = lazy(() => import("./Dashboard"));
const Organizations = lazy(() => import("./Organizations"));
const MyProfiles = lazy(() => import("./MyProfiles"));
const Funder = lazy(() => import("./Funder"));
const DiscoverGrants = lazy(() => import("./DiscoverGrants"));
const SmartMatcher = lazy(() => import("./SmartMatcher"));
const ItemFunding = lazy(() => import("./ItemFunding"));
const Pipeline = lazy(() => import("./Pipeline"));
const Applications = lazy(() => import("./Applications"));
const Proposals = lazy(() => import("./Proposals"));
const Outreach = lazy(() => import("./Outreach"));
const GrantDeadline = lazy(() => import("./GrantDeadline"));
const Budgets = lazy(() => import("./Budgets"));
const Documents = lazy(() => import("./Documents"));
const Calendar = lazy(() => import("./Calendar"));
const Reports = lazy(() => import("./Reports"));
const AdvancedAnalytics = lazy(() => import("./AdvancedAnalytics"));
const Billing = lazy(() => import("./Billing"));
const Automation = lazy(() => import("./Automation"));
const NewProject = lazy(() => import("./NewProject"));
const GrantDetail = lazy(() => import("./GrantDetail"));
const Apply = lazy(() => import("./Apply"));
const VNextApplication = lazy(() => import("./VNextApplication"));
const VNextFinishPacket = lazy(() => import("./VNextFinishPacket"));
const InvoiceView = lazy(() => import("./InvoiceView"));
const CreateInvoice = lazy(() => import("./CreateInvoice"));
const NOFOParser = lazy(() => import("./NOFOParser"));
const AIGrantScorer = lazy(() => import("./AIGrantScorer"));
const BudgetDetail = lazy(() => import("./BudgetDetail"));
const PrintPipeline = lazy(() => import("./PrintPipeline"));
const OneTimeFix = lazy(() => import("./OneTimeFix"));
const DataSources = lazy(() => import("./DataSources"));
const SourceRegistry = lazy(() => import("./SourceRegistry"));
const BackfillContacts = lazy(() => import("./BackfillContacts"));
const Stewardship = lazy(() => import("./Stewardship"));
const ProfileDetail = lazy(() => import("./ProfileDetail"));
const Diagnostics = lazy(() => import("./Diagnostics"));
const ComplianceReportDetail = lazy(() => import("./ComplianceReportDetail"));
const ProfileMatcher = lazy(() => import("./ProfileMatcher"));
const SourceDirectory = lazy(() => import("./SourceDirectory"));
const GrantMonitoring = lazy(() => import("./GrantMonitoring"));
const PrintableApplication = lazy(() => import("./PrintableApplication"));
const BillingSheet = lazy(() => import("./BillingSheet"));
const OrganizationProfile = lazy(() => import("./OrganizationProfile"));
const FundingOpportunities = lazy(() => import("./FundingOpportunities"));
const FundingResults = lazy(() => import("./FundingResults"));
const Pricing = lazy(() => import("./Pricing"));
const Services = lazy(() => import("./Services"));
const Settings = lazy(() => import("./Settings"));
const Help = lazy(() => import("./Help"));
const Admin = lazy(() => import("./Admin"));
const Incognito = lazy(() => import("./Incognito"));
const Login = lazy(() => import("./Login"));
const AuthCallback = lazy(() => import("./AuthCallback"));
const ServiceApplication = lazy(() => import("./ServiceApplication"));
const SetPassword = lazy(() => import("./SetPassword"));
const SavedGrants = lazy(() => import("./SavedGrants"));

import { Route, Routes, useLocation, Navigate } from 'react-router-dom';
import { useAuthStore } from "@/stores/authStore";
import RouteErrorBoundary from "@/components/shared/RouteErrorBoundary";

function RouteLoading() {
    return (
        <div className="flex min-h-[50vh] items-center justify-center text-sm text-slate-500">
            Loading…
        </div>
    )
}


const PAGES = {
    
    Dashboard: Dashboard,
    
    Organizations: Organizations,
    
    MyProfiles: MyProfiles,
    
    Funder: Funder,
    
    DiscoverGrants: DiscoverGrants,
    SavedGrants: SavedGrants,
    FundingResults: FundingResults,
    
    ItemFunding: ItemFunding,
    
    Pipeline: Pipeline,

    Applications: Applications,

    Proposals: Proposals,
    
    Outreach: Outreach,
    
    GrantDeadline: GrantDeadline,
    
    Budgets: Budgets,
    
    Documents: Documents,
    
    Calendar: Calendar,
    
    Reports: Reports,
    
    AdvancedAnalytics: AdvancedAnalytics,
    
    Billing: Billing,
    
    Automation: Automation,
    
    NewProject: NewProject,
    
    GrantDetail: GrantDetail,
    VNextApplication: VNextApplication,
    VNextFinishPacket: VNextFinishPacket,
    
    InvoiceView: InvoiceView,
    
    CreateInvoice: CreateInvoice,
    
    NOFOParser: NOFOParser,
    
    AIGrantScorer: AIGrantScorer,
    
    BudgetDetail: BudgetDetail,
    
    PrintPipeline: PrintPipeline,
    
    OneTimeFix: OneTimeFix,
    
    DataSources: DataSources,
    
    SourceRegistry: SourceRegistry,
    
    BackfillContacts: BackfillContacts,
    
    Stewardship: Stewardship,
    
    Diagnostics: Diagnostics,
    
    ComplianceReportDetail: ComplianceReportDetail,
    
    ProfileMatcher: ProfileMatcher,
    
    SourceDirectory: SourceDirectory,
    
    FundingOpportunities: FundingOpportunities,
    
    GrantMonitoring: GrantMonitoring,
    
    PrintableApplication: PrintableApplication,
    
    BillingSheet: BillingSheet,
    
    ProfileDetail: ProfileDetail,
    
    OrganizationProfile: OrganizationProfile,
    
    Pricing: Pricing,
    Services: Services,
    
    Settings: Settings,
    
    Help: Help,
    
    Admin: Admin,
    
}

function _getCurrentPage(url) {
    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }
    let urlLastPart = url.split('/').pop();
    if (urlLastPart.includes('?')) {
        urlLastPart = urlLastPart.split('?')[0];
    }

    const pageName = Object.keys(PAGES).find(page => page.toLowerCase() === urlLastPart.toLowerCase());
    return pageName || Object.keys(PAGES)[0];
}

function withBoundary(element, routeName) {
    return (
        <RouteErrorBoundary routeName={routeName}>
            <Suspense fallback={<RouteLoading />}>
                {element}
            </Suspense>
        </RouteErrorBoundary>
    )
}

// Create a wrapper component that uses useLocation inside the Router context
function LayoutRoutes() {
    const location = useLocation();
    const currentPage = _getCurrentPage(location.pathname);
    const { isAuthenticated, sessionExpired, needsProfileCreation, profiles, user } = useAuthStore((state) => ({
        isAuthenticated: state.isAuthenticated,
        sessionExpired: state.sessionExpired,
        needsProfileCreation: state.needsProfileCreation,
        profiles: state.profiles,
        user: state.user,
    }));

    if (!isAuthenticated) {
        return <Navigate to="/login" state={{ from: location, sessionExpired }} replace />;
    }

    // Block dashboard access if user needs profile creation (unless admin)
    const isAdmin = user?.is_admin
    if (isAuthenticated && !isAdmin && needsProfileCreation && profiles.length === 0) {
        const ALLOWED_DURING_ONBOARDING = ['/Organizations', '/MyProfiles', '/Help', '/Settings', '/Pricing', '/Services'];
        const isAllowed = ALLOWED_DURING_ONBOARDING.some(p => location.pathname.startsWith(p));
        if (!isAllowed) {
            return <Navigate to="/Organizations" replace />;
        }
    }

    return (
        <Suspense fallback={<RouteLoading />}>
            <Layout currentPageName={currentPage}>
                <Routes>

                <Route path="/" element={withBoundary(<Dashboard />, "Dashboard")} />


                <Route path="/Dashboard" element={withBoundary(<Dashboard />, "Dashboard")} />

                <Route path="/Organizations" element={withBoundary(<Organizations />, "Organizations")} />

                <Route path="/MyProfiles" element={withBoundary(<MyProfiles />, "MyProfiles")} />

                <Route path="/Funder" element={withBoundary(<Funder />, "Funder")} />

                <Route path="/DiscoverGrants" element={withBoundary(<DiscoverGrants />, "DiscoverGrants")} />
                <Route path="/FundingResults" element={withBoundary(<FundingResults />, "FundingResults")} />

                <Route path="/SmartMatcher" element={withBoundary(<SmartMatcher />, "SmartMatcher")} />

                <Route path="/ItemFunding" element={withBoundary(<ItemFunding />, "ItemFunding")} />

                <Route path="/Pipeline" element={withBoundary(<Pipeline />, "Pipeline")} />

                <Route path="/Applications" element={withBoundary(<Applications />, "Applications")} />

                <Route path="/Proposals" element={withBoundary(<Proposals />, "Proposals")} />

                <Route path="/Outreach" element={withBoundary(<Outreach />, "Outreach")} />

                <Route path="/GrantDeadline" element={withBoundary(<GrantDeadline />, "GrantDeadline")} />

                <Route path="/Budgets" element={withBoundary(<Budgets />, "Budgets")} />

                <Route path="/Documents" element={withBoundary(<Documents />, "Documents")} />

                <Route path="/Calendar" element={withBoundary(<Calendar />, "Calendar")} />

                <Route path="/Reports" element={withBoundary(<Reports />, "Reports")} />

                <Route path="/AdvancedAnalytics" element={withBoundary(<AdvancedAnalytics />, "AdvancedAnalytics")} />

                <Route path="/Billing" element={withBoundary(<Billing />, "Billing")} />

                <Route path="/Automation" element={withBoundary(<Automation />, "Automation")} />

                <Route path="/NewProject" element={withBoundary(<NewProject />, "NewProject")} />

                <Route path="/GrantDetail" element={withBoundary(<GrantDetail />, "GrantDetail")} />
                <Route path="/Apply" element={withBoundary(<Apply />, "Apply")} />
                <Route path="/VNextApplication" element={withBoundary(<VNextApplication />, "VNextApplication")} />
                <Route path="/VNextFinishPacket" element={withBoundary(<VNextFinishPacket />, "VNextFinishPacket")} />

                <Route path="/InvoiceView" element={withBoundary(<InvoiceView />, "InvoiceView")} />

                <Route path="/CreateInvoice" element={withBoundary(<CreateInvoice />, "CreateInvoice")} />

                <Route path="/NOFOParser" element={withBoundary(<NOFOParser />, "NOFOParser")} />

                <Route path="/AIGrantScorer" element={withBoundary(<AIGrantScorer />, "AIGrantScorer")} />

                <Route path="/BudgetDetail" element={withBoundary(<BudgetDetail />, "BudgetDetail")} />

                <Route path="/PrintPipeline" element={withBoundary(<PrintPipeline />, "PrintPipeline")} />

                <Route path="/OneTimeFix" element={withBoundary(<OneTimeFix />, "OneTimeFix")} />

                <Route path="/DataSources" element={withBoundary(<DataSources />, "DataSources")} />

                <Route path="/SourceRegistry" element={withBoundary(<SourceRegistry />, "SourceRegistry")} />

                <Route path="/BackfillContacts" element={withBoundary(<BackfillContacts />, "BackfillContacts")} />

                <Route path="/Stewardship" element={withBoundary(<Stewardship />, "Stewardship")} />

                <Route path="/Settings" element={withBoundary(<Settings />, "Settings")} />

                <Route path="/Help" element={withBoundary(<Help />, "Help")} />
                <Route path="/Incognito" element={withBoundary(<Incognito />, "Incognito")} />

                <Route path="/Diagnostics" element={withBoundary(<Diagnostics />, "Diagnostics")} />

                <Route path="/ComplianceReportDetail" element={withBoundary(<ComplianceReportDetail />, "ComplianceReportDetail")} />

                <Route path="/ProfileMatcher" element={withBoundary(<ProfileMatcher />, "ProfileMatcher")} />

                <Route path="/SourceDirectory" element={withBoundary(<SourceDirectory />, "SourceDirectory")} />

                <Route path="/FundingOpportunities" element={withBoundary(<FundingOpportunities />, "FundingOpportunities")} />

                <Route path="/GrantMonitoring" element={withBoundary(<GrantMonitoring />, "GrantMonitoring")} />

                <Route path="/PrintableApplication" element={withBoundary(<PrintableApplication />, "PrintableApplication")} />

                <Route path="/BillingSheet" element={withBoundary(<BillingSheet />, "BillingSheet")} />

                <Route path="/ProfileDetail" element={withBoundary(<ProfileDetail />, "ProfileDetail")} />

                <Route path="/OrganizationProfile" element={withBoundary(<OrganizationProfile />, "OrganizationProfile")} />

                <Route path="/Admin" element={withBoundary(<Admin />, "Admin")} />

                <Route path="/SavedGrants" element={withBoundary(<SavedGrants />, "SavedGrants")} />

                </Routes>
            </Layout>
            <OnboardingFlow />
        </Suspense>
    );
}

export default function Pages() {
    return (
        <Routes>
            <Route path="/login" element={withBoundary(<Login />, "Login")} />
            <Route path="/set-password" element={withBoundary(<SetPassword />, "SetPassword")} />
            <Route path="/ServiceApplication" element={withBoundary(<ServiceApplication />, "ServiceApplication")} />
            <Route path="/auth/callback" element={withBoundary(<AuthCallback />, "AuthCallback")} />
            <Route path="/*" element={withBoundary(<LayoutRoutes />, "Layout")} />
        </Routes>
    );
}