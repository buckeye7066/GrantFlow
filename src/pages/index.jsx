import React, { Suspense } from "react";
import Layout from "./Layout.jsx";
// lazyWithRetry catches "stale chunk" failures after a deploy (the
// MIME-type / "Failed to fetch dynamically imported module" errors)
// and forces a single page reload so the user picks up the new
// index.html with the current chunk hashes.
import { lazyWithRetry as lazy } from "@/utils/lazyWithRetry";

const Dashboard = lazy(() => import("./Dashboard"), 'Dashboard');
const Organizations = lazy(() => import("./Organizations"), 'Organizations');
const MyProfiles = lazy(() => import("./MyProfiles"), 'MyProfiles');
const Funder = lazy(() => import("./Funder"), 'Funder');
const DiscoverGrants = lazy(() => import("./DiscoverGrants"), 'DiscoverGrants');
const SmartMatcher = lazy(() => import("./SmartMatcher"), 'SmartMatcher');
const ItemFunding = lazy(() => import("./ItemFunding"), 'ItemFunding');
const Pipeline = lazy(() => import("./Pipeline"), 'Pipeline');
const Applications = lazy(() => import("./Applications"), 'Applications');
const Proposals = lazy(() => import("./Proposals"), 'Proposals');
const Outreach = lazy(() => import("./Outreach"), 'Outreach');
const GrantDeadline = lazy(() => import("./GrantDeadline"), 'GrantDeadline');
const Budgets = lazy(() => import("./Budgets"), 'Budgets');
const Documents = lazy(() => import("./Documents"), 'Documents');
const Calendar = lazy(() => import("./Calendar"), 'Calendar');
const Reports = lazy(() => import("./Reports"), 'Reports');
const AdvancedAnalytics = lazy(() => import("./AdvancedAnalytics"), 'AdvancedAnalytics');
const Billing = lazy(() => import("./Billing"), 'Billing');
const Automation = lazy(() => import("./Automation"), 'Automation');
const NewProject = lazy(() => import("./NewProject"), 'NewProject');
const GrantDetail = lazy(() => import("./GrantDetail"), 'GrantDetail');
const Apply = lazy(() => import("./Apply"), 'Apply');
const VNextApplication = lazy(() => import("./VNextApplication"), 'VNextApplication');
const VNextFinishPacket = lazy(() => import("./VNextFinishPacket"), 'VNextFinishPacket');
const InvoiceView = lazy(() => import("./InvoiceView"), 'InvoiceView');
const CreateInvoice = lazy(() => import("./CreateInvoice"), 'CreateInvoice');
const NOFOParser = lazy(() => import("./NOFOParser"), 'NOFOParser');
const AIGrantScorer = lazy(() => import("./AIGrantScorer"), 'AIGrantScorer');
const BudgetDetail = lazy(() => import("./BudgetDetail"), 'BudgetDetail');
const PrintPipeline = lazy(() => import("./PrintPipeline"), 'PrintPipeline');
const PrintProfilePacket = lazy(() => import("./PrintProfilePacket"), 'PrintProfilePacket');
const OneTimeFix = lazy(() => import("./OneTimeFix"), 'OneTimeFix');
const DataSources = lazy(() => import("./DataSources"), 'DataSources');
const SourceRegistry = lazy(() => import("./SourceRegistry"), 'SourceRegistry');
const BackfillContacts = lazy(() => import("./BackfillContacts"), 'BackfillContacts');
const Stewardship = lazy(() => import("./Stewardship"), 'Stewardship');
const ProfileDetail = lazy(() => import("./ProfileDetail"), 'ProfileDetail');
const Diagnostics = lazy(() => import("./Diagnostics"), 'Diagnostics');
const ComplianceReportDetail = lazy(() => import("./ComplianceReportDetail"), 'ComplianceReportDetail');
const ProfileMatcher = lazy(() => import("./ProfileMatcher"), 'ProfileMatcher');
const SourceDirectory = lazy(() => import("./SourceDirectory"), 'SourceDirectory');
const GrantMonitoring = lazy(() => import("./GrantMonitoring"), 'GrantMonitoring');
const PrintableApplication = lazy(() => import("./PrintableApplication"), 'PrintableApplication');
const BillingSheet = lazy(() => import("./BillingSheet"), 'BillingSheet');
const OrganizationProfile = lazy(() => import("./OrganizationProfile"), 'OrganizationProfile');
const FundingOpportunities = lazy(() => import("./FundingOpportunities"), 'FundingOpportunities');
const FundingResults = lazy(() => import("./FundingResults"), 'FundingResults');
const Pricing = lazy(() => import("./Pricing"), 'Pricing');
const Services = lazy(() => import("./Services"), 'Services');
const Settings = lazy(() => import("./Settings"), 'Settings');
const Help = lazy(() => import("./Help"), 'Help');
const Admin = lazy(() => import("./Admin"), 'Admin');
const Incognito = lazy(() => import("./Incognito"), 'Incognito');
const Login = lazy(() => import("./Login"), 'Login');
const AuthCallback = lazy(() => import("./AuthCallback"), 'AuthCallback');
const ServiceApplication = lazy(() => import("./ServiceApplication"), 'ServiceApplication');
const SetPassword = lazy(() => import("./SetPassword"), 'SetPassword');
const SavedGrants = lazy(() => import("./SavedGrants"), 'SavedGrants');
const FoundationSearch = lazy(() => import("./FoundationSearch"), 'FoundationSearch');

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
    FoundationSearch: FoundationSearch,
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

    PrintProfilePacket: PrintProfilePacket,

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
                <Route path="/PrintProfilePacket" element={withBoundary(<PrintProfilePacket />, "PrintProfilePacket")} />

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

                <Route path="/Pricing" element={withBoundary(<Pricing />, "Pricing")} />
                <Route path="/Services" element={withBoundary(<Services />, "Services")} />

                <Route path="/SavedGrants" element={withBoundary(<SavedGrants />, "SavedGrants")} />
                <Route path="/FoundationSearch" element={withBoundary(<FoundationSearch />, "FoundationSearch")} />

                </Routes>
            </Layout>
            {/* OnboardingFlow is mounted ONCE inside Layout.jsx — do not
                re-mount here. Previously it was mounted in both places,
                which caused duplicate first-run modals and a race in
                completion-state writes. */}
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