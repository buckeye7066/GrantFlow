import React, { Suspense, lazy, useState } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import Layout from "./Layout.jsx";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";

import Dashboard from "./Dashboard";

import Organizations from "./Organizations";
import MyProfiles from "./MyProfiles";
import Funder from "./Funder";

import DiscoverGrants from "./DiscoverGrants";
import SmartMatcher from "./SmartMatcher";
import ItemFunding from "./ItemFunding";

import Pipeline from "./Pipeline";

import Proposals from "./Proposals";
import Outreach from "./Outreach";
import GrantDeadline from "./GrantDeadline";

import Budgets from "./Budgets";

const Documents = lazy(() => import("./Documents"));

import Calendar from "./Calendar";

const Reports = lazy(() => import("./Reports"));
import AdvancedAnalytics from "./AdvancedAnalytics";

import Billing from "./Billing";
import Automation from "./Automation";

import NewProject from "./NewProject";

import GrantDetail from "./GrantDetail";
import Apply from "./Apply";

import InvoiceView from "./InvoiceView";

import CreateInvoice from "./CreateInvoice";

import NOFOParser from "./NOFOParser";

import AIGrantScorer from "./AIGrantScorer";

import BudgetDetail from "./BudgetDetail";

import PrintPipeline from "./PrintPipeline";

import OneTimeFix from "./OneTimeFix";

import DataSources from "./DataSources";

import SourceRegistry from "./SourceRegistry";

import BackfillContacts from "./BackfillContacts";

import Stewardship from "./Stewardship";
const ProfileDetail = lazy(() => import("./ProfileDetail"));

const Diagnostics = lazy(() => import("./Diagnostics"));

import ComplianceReportDetail from "./ComplianceReportDetail";

import ProfileMatcher from "./ProfileMatcher";

import SourceDirectory from "./SourceDirectory";

const GrantMonitoring = lazy(() => import("./GrantMonitoring"));

import PrintableApplication from "./PrintableApplication";

import BillingSheet from "./BillingSheet";

import OrganizationProfile from "./OrganizationProfile";

const FundingOpportunities = lazy(() => import("./FundingOpportunities"));

import Pricing from "./Pricing";
import Services from "./Services";

import Settings from "./Settings";

const Admin = lazy(() => import("./Admin"));

import Login from "./Login";
import AuthCallback from "./AuthCallback";
import ServiceApplication from "./ServiceApplication";
import SetPassword from "./SetPassword";

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

function EnsureQueryClientProvider({ children }) {
    const [fallbackClient] = useState(() => new QueryClient());
    let hasClient = true;

    try {
        useQueryClient();
    } catch (error) {
        hasClient = false;
    }

    if (!hasClient) {
        return <QueryClientProvider client={fallbackClient}>{children}</QueryClientProvider>;
    }

    return children;
}

const PAGES = {
    
    Dashboard: Dashboard,
    
    Organizations: Organizations,
    
    MyProfiles: MyProfiles,
    
    Funder: Funder,
    
    DiscoverGrants: DiscoverGrants,
    
    SmartMatcher: SmartMatcher,
    
    ItemFunding: ItemFunding,
    
    Pipeline: Pipeline,
    
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

    if (!isAuthenticated && !sessionExpired) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    // Block dashboard access if user needs profile creation (unless admin)
    const isAdmin = user?.is_admin
    if (isAuthenticated && !isAdmin && needsProfileCreation && profiles.length === 0) {
        // Only allow access to Organizations page for profile creation
        if (!location.pathname.includes('/Organizations') && !location.pathname.includes('/MyProfiles')) {
            return <Navigate to="/Organizations" replace />;
        }
    }

    return (
        <EnsureQueryClientProvider>
            <Layout currentPageName={currentPage}>
                <Routes>

                <Route path="/" element={withBoundary(<Dashboard />, "Dashboard")} />


                <Route path="/Dashboard" element={withBoundary(<Dashboard />, "Dashboard")} />

                <Route path="/Organizations" element={withBoundary(<Organizations />, "Organizations")} />

                <Route path="/MyProfiles" element={withBoundary(<MyProfiles />, "MyProfiles")} />

                <Route path="/Funder" element={withBoundary(<Funder />, "Funder")} />

                <Route path="/DiscoverGrants" element={withBoundary(<DiscoverGrants />, "DiscoverGrants")} />

                <Route path="/SmartMatcher" element={withBoundary(<SmartMatcher />, "SmartMatcher")} />

                <Route path="/ItemFunding" element={withBoundary(<ItemFunding />, "ItemFunding")} />

                <Route path="/Pipeline" element={withBoundary(<Pipeline />, "Pipeline")} />

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

                </Routes>
            </Layout>
            <OnboardingFlow />
        </EnsureQueryClientProvider>
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