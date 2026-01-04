import { useState } from "react";
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
import ContactAdmin from "./ContactAdmin";
import Outreach from "./Outreach";
import GrantDeadline from "./GrantDeadline";

import Budgets from "./Budgets";

import Documents from "./Documents";

import Calendar from "./Calendar";

import Reports from "./Reports";
import AdvancedAnalytics from "./AdvancedAnalytics";

import Billing from "./Billing";
import Automation from "./Automation";

import NewProject from "./NewProject";

import GrantDetail from "./GrantDetail";

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

import Diagnostics from "./Diagnostics";

import ComplianceReportDetail from "./ComplianceReportDetail";

import ProfileMatcher from "./ProfileMatcher";

import SourceDirectory from "./SourceDirectory";

import GrantMonitoring from "./GrantMonitoring";

import PrintableApplication from "./PrintableApplication";

import BillingSheet from "./BillingSheet";

import OrganizationProfile from "./OrganizationProfile";

import FundingOpportunities from "./FundingOpportunities";

import Pricing from "./Pricing";

import Settings from "./Settings";

import Login from "./Login";
import AuthCallback from "./AuthCallback";

import { Route, Routes, useLocation, Navigate } from 'react-router-dom';
import { useAuthStore } from "@/stores/authStore";

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
    
    ContactAdmin: ContactAdmin,
    
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
    
    OrganizationProfile: OrganizationProfile,
    
    Pricing: Pricing,
    
    Settings: Settings,
    
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

                <Route path="/" element={<Dashboard />} />


                <Route path="/Dashboard" element={<Dashboard />} />

                <Route path="/Organizations" element={<Organizations />} />

                <Route path="/MyProfiles" element={<MyProfiles />} />

                <Route path="/Funder" element={<Funder />} />

                <Route path="/DiscoverGrants" element={<DiscoverGrants />} />

                <Route path="/SmartMatcher" element={<SmartMatcher />} />

                <Route path="/ItemFunding" element={<ItemFunding />} />

                <Route path="/Pipeline" element={<Pipeline />} />

                <Route path="/Proposals" element={<Proposals />} />

                <Route path="/ContactAdmin" element={<ContactAdmin />} />

                <Route path="/Outreach" element={<Outreach />} />

                <Route path="/GrantDeadline" element={<GrantDeadline />} />

                <Route path="/Budgets" element={<Budgets />} />

                <Route path="/Documents" element={<Documents />} />

                <Route path="/Calendar" element={<Calendar />} />

                <Route path="/Reports" element={<Reports />} />

                <Route path="/AdvancedAnalytics" element={<AdvancedAnalytics />} />

                <Route path="/Billing" element={<Billing />} />

                <Route path="/Automation" element={<Automation />} />

                <Route path="/NewProject" element={<NewProject />} />

                <Route path="/GrantDetail" element={<GrantDetail />} />

                <Route path="/InvoiceView" element={<InvoiceView />} />

                <Route path="/CreateInvoice" element={<CreateInvoice />} />

                <Route path="/NOFOParser" element={<NOFOParser />} />

                <Route path="/AIGrantScorer" element={<AIGrantScorer />} />

                <Route path="/BudgetDetail" element={<BudgetDetail />} />

                <Route path="/PrintPipeline" element={<PrintPipeline />} />

                <Route path="/OneTimeFix" element={<OneTimeFix />} />

                <Route path="/DataSources" element={<DataSources />} />

                <Route path="/SourceRegistry" element={<SourceRegistry />} />

                <Route path="/BackfillContacts" element={<BackfillContacts />} />

                <Route path="/Stewardship" element={<Stewardship />} />

                <Route path="/Diagnostics" element={<Diagnostics />} />

                <Route path="/ComplianceReportDetail" element={<ComplianceReportDetail />} />

                <Route path="/ProfileMatcher" element={<ProfileMatcher />} />

                <Route path="/SourceDirectory" element={<SourceDirectory />} />

                <Route path="/FundingOpportunities" element={<FundingOpportunities />} />

                <Route path="/GrantMonitoring" element={<GrantMonitoring />} />

                <Route path="/PrintableApplication" element={<PrintableApplication />} />

                <Route path="/BillingSheet" element={<BillingSheet />} />

                    <Route path="/OrganizationProfile" element={<OrganizationProfile />} />

                </Routes>
            </Layout>
            <OnboardingFlow />
        </EnsureQueryClientProvider>
    );
}

export default function Pages() {
    return (
        <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/*" element={<LayoutRoutes />} />
        </Routes>
    );
}