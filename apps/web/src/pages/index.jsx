import Layout from "./Layout.jsx";

import Dashboard from "./Dashboard";

import Organizations from "./Organizations";

import DiscoverGrants from "./DiscoverGrants";

import Proposals from "./Proposals";

import Budgets from "./Budgets";

import Documents from "./Documents";

import Calendar from "./Calendar";

import Reports from "./Reports";

import Billing from "./Billing";

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

import ComplianceReportDetail from "./ComplianceReportDetail";

import ProfileMatcher from "./ProfileMatcher";

import SourceDirectory from "./SourceDirectory";

import GrantMonitoring from "./GrantMonitoring";

import PrintableApplication from "./PrintableApplication";

import BillingSheet from "./BillingSheet";

import OrganizationProfile from "./OrganizationProfile";

import ItemSearch from "./ItemSearch";

import GrantDeadlines from "./GrantDeadlines";

import AutomationSettings from "./AutomationSettings";

import SmartMatcher from "./SmartMatcher";

import TaxCenter from "./TaxCenter";

import OutreachCampaigns from "./OutreachCampaigns";

import PrintablePaymentOptions from "./PrintablePaymentOptions";

import PublicApplication from "./PublicApplication";

import Pricing from "./Pricing";

import Landing from "./Landing";

import Leads from "./Leads";

import LeadDetail from "./LeadDetail";

import TierDemo from "./TierDemo";

import UserManagement from "./UserManagement";

import Funders from "./Funders";

import FunderProfile from "./FunderProfile";

import GrantReporting from "./GrantReporting";

import SendMessage from "./SendMessage";

import AdminMessages from "./AdminMessages";

import NotifyNewUser from "./NotifyNewUser";

import AdvancedAnalytics from "./AdvancedAnalytics";

import UserAnalytics from "./UserAnalytics";

import Pipeline from "./Pipeline";

import FundingOpportunities from "./FundingOpportunities";

import FunctionCodeReview from "./FunctionCodeReview";

import ExportFunctions from "./ExportFunctions";

import GithubTunnel from "./GithubTunnel";

import NewProject from "./NewProject";

import PushToGithub from "./PushToGithub";

import AutoAdvanceRunner from "./AutoAdvanceRunner";

import ExportManager from "./ExportManager";

import SyncToGithub from "./SyncToGithub";

import TriggerGithubPush from "./TriggerGithubPush";

import TestGithubConnection from "./TestGithubConnection";

import SamMonitor from "./SamMonitor";

import { BrowserRouter as Router, Route, Routes, useLocation } from 'react-router-dom';

const PAGES = {
    
    Dashboard: Dashboard,
    
    Organizations: Organizations,
    
    DiscoverGrants: DiscoverGrants,
    
    Proposals: Proposals,
    
    Budgets: Budgets,
    
    Documents: Documents,
    
    Calendar: Calendar,
    
    Reports: Reports,
    
    Billing: Billing,
    
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
    
    ComplianceReportDetail: ComplianceReportDetail,
    
    ProfileMatcher: ProfileMatcher,
    
    SourceDirectory: SourceDirectory,
    
    GrantMonitoring: GrantMonitoring,
    
    PrintableApplication: PrintableApplication,
    
    BillingSheet: BillingSheet,
    
    OrganizationProfile: OrganizationProfile,
    
    ItemSearch: ItemSearch,
    
    GrantDeadlines: GrantDeadlines,
    
    AutomationSettings: AutomationSettings,
    
    SmartMatcher: SmartMatcher,
    
    TaxCenter: TaxCenter,
    
    OutreachCampaigns: OutreachCampaigns,
    
    PrintablePaymentOptions: PrintablePaymentOptions,
    
    PublicApplication: PublicApplication,
    
    Pricing: Pricing,
    
    Landing: Landing,
    
    Leads: Leads,
    
    LeadDetail: LeadDetail,
    
    TierDemo: TierDemo,
    
    UserManagement: UserManagement,
    
    Funders: Funders,
    
    FunderProfile: FunderProfile,
    
    GrantReporting: GrantReporting,
    
    SendMessage: SendMessage,
    
    AdminMessages: AdminMessages,
    
    NotifyNewUser: NotifyNewUser,
    
    AdvancedAnalytics: AdvancedAnalytics,
    
    UserAnalytics: UserAnalytics,
    
    Pipeline: Pipeline,
    
    FundingOpportunities: FundingOpportunities,
    
    FunctionCodeReview: FunctionCodeReview,
    
    ExportFunctions: ExportFunctions,
    
    GithubTunnel: GithubTunnel,
    
    NewProject: NewProject,
    
    PushToGithub: PushToGithub,
    
    AutoAdvanceRunner: AutoAdvanceRunner,
    
    ExportManager: ExportManager,
    
    SyncToGithub: SyncToGithub,
    
    TriggerGithubPush: TriggerGithubPush,
    
    TestGithubConnection: TestGithubConnection,
    
    SamMonitor: SamMonitor,
    
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
                
                <Route path="/Proposals" element={<Proposals />} />
                
                <Route path="/Budgets" element={<Budgets />} />
                
                <Route path="/Documents" element={<Documents />} />
                
                <Route path="/Calendar" element={<Calendar />} />
                
                <Route path="/Reports" element={<Reports />} />
                
                <Route path="/Billing" element={<Billing />} />
                
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
                
                <Route path="/ComplianceReportDetail" element={<ComplianceReportDetail />} />
                
                <Route path="/ProfileMatcher" element={<ProfileMatcher />} />
                
                <Route path="/SourceDirectory" element={<SourceDirectory />} />
                
                <Route path="/GrantMonitoring" element={<GrantMonitoring />} />
                
                <Route path="/PrintableApplication" element={<PrintableApplication />} />
                
                <Route path="/BillingSheet" element={<BillingSheet />} />
                
                <Route path="/OrganizationProfile" element={<OrganizationProfile />} />
                
                <Route path="/ItemSearch" element={<ItemSearch />} />
                
                <Route path="/GrantDeadlines" element={<GrantDeadlines />} />
                
                <Route path="/AutomationSettings" element={<AutomationSettings />} />
                
                <Route path="/SmartMatcher" element={<SmartMatcher />} />
                
                <Route path="/TaxCenter" element={<TaxCenter />} />
                
                <Route path="/OutreachCampaigns" element={<OutreachCampaigns />} />
                
                <Route path="/PrintablePaymentOptions" element={<PrintablePaymentOptions />} />
                
                <Route path="/PublicApplication" element={<PublicApplication />} />
                
                <Route path="/Pricing" element={<Pricing />} />
                
                <Route path="/Landing" element={<Landing />} />
                
                <Route path="/Leads" element={<Leads />} />
                
                <Route path="/LeadDetail" element={<LeadDetail />} />
                
                <Route path="/TierDemo" element={<TierDemo />} />
                
                <Route path="/UserManagement" element={<UserManagement />} />
                
                <Route path="/Funders" element={<Funders />} />
                
                <Route path="/FunderProfile" element={<FunderProfile />} />
                
                <Route path="/GrantReporting" element={<GrantReporting />} />
                
                <Route path="/SendMessage" element={<SendMessage />} />
                
                <Route path="/AdminMessages" element={<AdminMessages />} />
                
                <Route path="/NotifyNewUser" element={<NotifyNewUser />} />
                
                <Route path="/AdvancedAnalytics" element={<AdvancedAnalytics />} />
                
                <Route path="/UserAnalytics" element={<UserAnalytics />} />
                
                <Route path="/Pipeline" element={<Pipeline />} />
                
                <Route path="/FundingOpportunities" element={<FundingOpportunities />} />
                
                <Route path="/FunctionCodeReview" element={<FunctionCodeReview />} />
                
                <Route path="/ExportFunctions" element={<ExportFunctions />} />
                
                <Route path="/GithubTunnel" element={<GithubTunnel />} />
                
                <Route path="/NewProject" element={<NewProject />} />
                
                <Route path="/PushToGithub" element={<PushToGithub />} />
                
                <Route path="/AutoAdvanceRunner" element={<AutoAdvanceRunner />} />
                
                <Route path="/ExportManager" element={<ExportManager />} />
                
                <Route path="/SyncToGithub" element={<SyncToGithub />} />
                
                <Route path="/TriggerGithubPush" element={<TriggerGithubPush />} />
                
                <Route path="/TestGithubConnection" element={<TestGithubConnection />} />
                
                <Route path="/SamMonitor" element={<SamMonitor />} />
                
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