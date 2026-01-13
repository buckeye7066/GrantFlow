import Layout from "./Layout.jsx";

import Dashboard from "./Dashboard";

import Organizations from "./Organizations";

import DiscoverGrants from "./DiscoverGrants";

import Pipeline from "./Pipeline";

import Proposals from "./Proposals";

import Budgets from "./Budgets";

import Documents from "./Documents";

import Calendar from "./Calendar";

import Reports from "./Reports";

import Billing from "./Billing";

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

import OrganizationProfile from "./pages/OrganizationProfile";

import { BrowserRouter as Router, Route, Routes, useLocation } from 'react-router-dom';

const PAGES = {
    
    Dashboard: Dashboard,
    
    Organizations: Organizations,
    
    DiscoverGrants: DiscoverGrants,
    
    Pipeline: Pipeline,
    
    Proposals: Proposals,
    
    Budgets: Budgets,
    
    Documents: Documents,
    
    Calendar: Calendar,
    
    Reports: Reports,
    
    Billing: Billing,
    
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
    
    GrantMonitoring: GrantMonitoring,
    
    PrintableApplication: PrintableApplication,
    
    BillingSheet: BillingSheet,
    
    OrganizationProfile: OrganizationProfile,
    
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
function PagesContent() {
    const location = useLocation();
    const currentPage = _getCurrentPage(location.pathname);
    
    return (
        <Layout currentPageName={currentPage}>
            <Routes>            
                
                    <Route path="/" element={<Dashboard />} />
                
                
                <Route path="/Dashboard" element={<Dashboard />} />
                
                <Route path="/Organizations" element={<Organizations />} />
                
                <Route path="/DiscoverGrants" element={<DiscoverGrants />} />
                
                <Route path="/Pipeline" element={<Pipeline />} />
                
                <Route path="/Proposals" element={<Proposals />} />
                
                <Route path="/Budgets" element={<Budgets />} />
                
                <Route path="/Documents" element={<Documents />} />
                
                <Route path="/Calendar" element={<Calendar />} />
                
                <Route path="/Reports" element={<Reports />} />
                
                <Route path="/Billing" element={<Billing />} />
                
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
                
                <Route path="/GrantMonitoring" element={<GrantMonitoring />} />
                
                <Route path="/PrintableApplication" element={<PrintableApplication />} />
                
                <Route path="/BillingSheet" element={<BillingSheet />} />
                
                <Route path="/OrganizationProfile" element={<OrganizationProfile />} />
                
            </Routes>
        </Layout>
    );
}

export default function Pages() {
    return (
        <Router>
            <PagesContent />
        </Router>
    );
}