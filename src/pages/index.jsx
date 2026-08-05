import React, { Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { lazyWithRetry as lazy } from '@/utils/lazyWithRetry'
import { useAuthStore } from '@/stores/authStore'
import RouteErrorBoundary from '@/components/shared/RouteErrorBoundary'
import { RequirePaidAccess } from '@/components/auth/RequirePaidAccess'
import AdminPricingToastListener from '@/components/admin/AdminPricingToastListener'
import RouteDocumentMetadata from '@/components/shared/RouteDocumentMetadata.jsx'
import { hasFullAdminWorkspace } from '@/lib/workspaceAccess'
import Layout from './Layout.jsx'

const Dashboard = lazy(() => import('./Dashboard'), 'Dashboard')
const Organizations = lazy(() => import('./Organizations'), 'Organizations')
const MyProfiles = lazy(() => import('./MyProfiles'), 'MyProfiles')
const Funder = lazy(() => import('./Funder'), 'Funder')
const DiscoverGrants = lazy(() => import('./DiscoverGrants'), 'DiscoverGrants')
const SmartMatcher = lazy(() => import('./SmartMatcher'), 'SmartMatcher')
const ItemFunding = lazy(() => import('./ItemFunding'), 'ItemFunding')
const Pipeline = lazy(() => import('./Pipeline'), 'Pipeline')
const EndUserPipeline = lazy(() => import('./EndUserPipeline'), 'EndUserPipeline')
const HamiltonProcessing = lazy(() => import('./HamiltonProcessing'), 'HamiltonProcessing')
const Applications = lazy(() => import('./Applications'), 'Applications')
const Proposals = lazy(() => import('./Proposals'), 'Proposals')
const Outreach = lazy(() => import('./Outreach'), 'Outreach')
const GrantDeadline = lazy(() => import('./GrantDeadline'), 'GrantDeadline')
const Budgets = lazy(() => import('./Budgets'), 'Budgets')
const Documents = lazy(() => import('./Documents'), 'Documents')
const Calendar = lazy(() => import('./Calendar'), 'Calendar')
const EndUserCalendar = lazy(() => import('./EndUserCalendar'), 'EndUserCalendar')
const Reports = lazy(() => import('./Reports'), 'Reports')
const AdvancedAnalytics = lazy(() => import('./AdvancedAnalytics'), 'AdvancedAnalytics')
const Billing = lazy(() => import('./Billing'), 'Billing')
const Automation = lazy(() => import('./Automation'), 'Automation')
const NewProject = lazy(() => import('./NewProject'), 'NewProject')
const GrantDetail = lazy(() => import('./GrantDetail'), 'GrantDetail')
const Apply = lazy(() => import('./Apply'), 'Apply')
const VNextApplication = lazy(() => import('./VNextApplication'), 'VNextApplication')
const VNextFinishPacket = lazy(() => import('./VNextFinishPacket'), 'VNextFinishPacket')
const InvoiceView = lazy(() => import('./InvoiceView'), 'InvoiceView')
const CreateInvoice = lazy(() => import('./CreateInvoice'), 'CreateInvoice')
const NOFOParser = lazy(() => import('./NOFOParser'), 'NOFOParser')
const AIGrantScorer = lazy(() => import('./AIGrantScorer'), 'AIGrantScorer')
const BudgetDetail = lazy(() => import('./BudgetDetail'), 'BudgetDetail')
const PrintPipeline = lazy(() => import('./PrintPipeline'), 'PrintPipeline')
const PrintProfilePacket = lazy(() => import('./PrintProfilePacket'), 'PrintProfilePacket')
const PrintAwardSummary = lazy(() => import('./PrintAwardSummary'), 'PrintAwardSummary')
const OneTimeFix = lazy(() => import('./OneTimeFix'), 'OneTimeFix')
const DataSources = lazy(() => import('./DataSources'), 'DataSources')
const SourceRegistry = lazy(() => import('./SourceRegistry'), 'SourceRegistry')
const BackfillContacts = lazy(() => import('./BackfillContacts'), 'BackfillContacts')
const Stewardship = lazy(() => import('./Stewardship'), 'Stewardship')
const ProfileDetail = lazy(() => import('./ProfileDetail'), 'ProfileDetail')
const Diagnostics = lazy(() => import('./Diagnostics'), 'Diagnostics')
const CrawlCoverage = lazy(() => import('./CrawlCoverage'), 'CrawlCoverage')
const CoverageEvidence = lazy(() => import('./CoverageEvidence'), 'CoverageEvidence')
const ComplianceReportDetail = lazy(() => import('./ComplianceReportDetail'), 'ComplianceReportDetail')
const ProfileMatcher = lazy(() => import('./ProfileMatcher'), 'ProfileMatcher')
const SourceDirectory = lazy(() => import('./SourceDirectory'), 'SourceDirectory')
const GrantMonitoring = lazy(() => import('./GrantMonitoring'), 'GrantMonitoring')
const PrintableApplication = lazy(() => import('./PrintableApplication'), 'PrintableApplication')
const BillingSheet = lazy(() => import('./BillingSheet'), 'BillingSheet')
const OrganizationProfile = lazy(() => import('./OrganizationProfile'), 'OrganizationProfile')
const FundingOpportunities = lazy(() => import('./FundingOpportunities'), 'FundingOpportunities')
const FundingResults = lazy(() => import('./FundingResults'), 'FundingResults')
const FundingLibrary = lazy(() => import('./FundingLibrary'), 'FundingLibrary')
const Pricing = lazy(() => import('./Pricing'), 'Pricing')
const Services = lazy(() => import('./Services'), 'Services')
const Settings = lazy(() => import('./Settings'), 'Settings')
const Help = lazy(() => import('./Help'), 'Help')
const EndUserHelp = lazy(() => import('./EndUserHelp'), 'EndUserHelp')
const Admin = lazy(() => import('./Admin'), 'Admin')
const Incognito = lazy(() => import('./Incognito'), 'Incognito')
const Login = lazy(() => import('./Login'), 'Login')
const AuthCallback = lazy(() => import('./AuthCallback'), 'AuthCallback')
const ServiceApplication = lazy(() => import('./ServiceApplication'), 'ServiceApplication')
const SetPassword = lazy(() => import('./SetPassword'), 'SetPassword')
const Start = lazy(() => import('./Start'), 'Start')
const SavedGrants = lazy(() => import('./SavedGrants'), 'SavedGrants')
const FoundationSearch = lazy(() => import('./FoundationSearch'), 'FoundationSearch')
const AnyaIntakeResults = lazy(() => import('./AnyaIntakeResults'), 'AnyaIntakeResults')
const PricingRequired = lazy(() => import('./PricingRequired'), 'PricingRequired')
const ServiceAgreement = lazy(() => import('./ServiceAgreement'), 'ServiceAgreement')
const CheckoutRequired = lazy(() => import('./CheckoutRequired'), 'CheckoutRequired')
const HamiltonLiveLogin = lazy(() => import('./HamiltonLiveLogin'), 'HamiltonLiveLogin')
const Landing = lazy(() => import('./Landing'), 'Landing')
const PrivacyPolicy = lazy(() => import('./PrivacyPolicy'), 'PrivacyPolicy')

const ROUTE_NAMES = new Set([
  'Dashboard', 'Organizations', 'MyProfiles', 'Funder', 'DiscoverGrants',
  'FundingResults', 'SmartMatcher', 'ItemFunding', 'Pipeline',
  'HamiltonProcessing', 'Applications', 'Proposals', 'Outreach',
  'GrantDeadline', 'Budgets', 'Documents', 'Calendar', 'Reports',
  'AdvancedAnalytics', 'Billing', 'Automation', 'NewProject', 'GrantDetail',
  'Apply', 'VNextApplication', 'VNextFinishPacket', 'InvoiceView',
  'CreateInvoice', 'NOFOParser', 'AIGrantScorer', 'BudgetDetail',
  'PrintPipeline', 'PrintProfilePacket', 'PrintAwardSummary', 'OneTimeFix',
  'DataSources', 'SourceRegistry', 'BackfillContacts', 'Stewardship',
  'Settings', 'Help', 'Incognito', 'Diagnostics', 'CrawlCoverage',
  'CoverageEvidence', 'ComplianceReportDetail', 'ProfileMatcher',
  'SourceDirectory', 'FundingOpportunities', 'FundingLibrary',
  'GrantMonitoring', 'PrintableApplication', 'BillingSheet', 'ProfileDetail',
  'OrganizationProfile', 'Admin', 'Pricing', 'Services', 'SavedGrants',
  'FoundationSearch', 'AnyaIntakeResults', 'PricingRequired',
  'ServiceAgreement', 'CheckoutRequired',
])

function RouteLoading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center text-sm text-slate-500">
      Loading…
    </div>
  )
}

function currentPageName(pathname) {
  const segment = String(pathname || '/').replace(/^\//, '').split('/')[0] || 'Dashboard'
  for (const name of ROUTE_NAMES) {
    if (name.toLowerCase() === segment.toLowerCase()) return name
  }
  return 'Dashboard'
}

function withBoundary(element, routeName) {
  return (
    <RouteErrorBoundary routeName={routeName}>
      <Suspense fallback={<RouteLoading />}>{element}</Suspense>
    </RouteErrorBoundary>
  )
}

function withGate(element, routeName) {
  return (
    <RouteErrorBoundary routeName={routeName}>
      <Suspense fallback={<RouteLoading />}>
        <RequirePaidAccess fallback={<RouteLoading />}>{element}</RequirePaidAccess>
      </Suspense>
    </RouteErrorBoundary>
  )
}

function LayoutRoutes() {
  const location = useLocation()
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  const sessionExpired = useAuthStore((state) => state.sessionExpired)
  const needsProfileCreation = useAuthStore((state) => state.needsProfileCreation)
  const profiles = useAuthStore((state) => state.profiles)
  const user = useAuthStore((state) => state.user)
  const isAdmin = hasFullAdminWorkspace(user)

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location, sessionExpired }} replace />
  }

  if (!isAdmin && needsProfileCreation && profiles.length === 0) {
    return <Navigate to="/start" replace />
  }

  const pipelinePage = isAdmin ? <Pipeline /> : <EndUserPipeline />
  const calendarPage = isAdmin ? <Calendar /> : <EndUserCalendar />
  const helpPage = isAdmin ? <Help /> : <EndUserHelp />

  return (
    <Suspense fallback={<RouteLoading />}>
      <Layout currentPageName={currentPageName(location.pathname)}>
        <Routes key={location.pathname}>
          <Route path="/" element={withGate(<Dashboard />, 'Dashboard')} />
          <Route path="/Dashboard" element={withGate(<Dashboard />, 'Dashboard')} />
          <Route path="/Organizations" element={withBoundary(<Organizations />, 'Organizations')} />
          <Route path="/MyProfiles" element={withBoundary(<MyProfiles />, 'MyProfiles')} />
          <Route path="/Funder" element={withGate(<Funder />, 'Funder')} />
          <Route path="/DiscoverGrants" element={withGate(<DiscoverGrants />, 'DiscoverGrants')} />
          <Route path="/FundingResults" element={withGate(<FundingResults />, 'FundingResults')} />
          <Route path="/SmartMatcher" element={withGate(<SmartMatcher />, 'SmartMatcher')} />
          <Route path="/ItemFunding" element={withGate(<ItemFunding />, 'ItemFunding')} />
          <Route path="/Pipeline" element={withGate(pipelinePage, 'Pipeline')} />
          <Route path="/HamiltonProcessing" element={withGate(<HamiltonProcessing />, 'HamiltonProcessing')} />
          <Route path="/Applications" element={withGate(<Applications />, 'Applications')} />
          <Route path="/Proposals" element={withGate(<Proposals />, 'Proposals')} />
          <Route path="/Outreach" element={withGate(<Outreach />, 'Outreach')} />
          <Route path="/GrantDeadline" element={withGate(<GrantDeadline />, 'GrantDeadline')} />
          <Route path="/Budgets" element={withGate(<Budgets />, 'Budgets')} />
          <Route path="/Documents" element={withGate(<Documents />, 'Documents')} />
          <Route path="/Calendar" element={withGate(calendarPage, 'Calendar')} />
          <Route path="/Reports" element={withGate(<Reports />, 'Reports')} />
          <Route path="/AdvancedAnalytics" element={withGate(<AdvancedAnalytics />, 'AdvancedAnalytics')} />
          <Route path="/Billing" element={withGate(<Billing />, 'Billing')} />
          <Route path="/Automation" element={withGate(<Automation />, 'Automation')} />
          <Route path="/NewProject" element={withGate(<NewProject />, 'NewProject')} />
          <Route path="/GrantDetail" element={withGate(<GrantDetail />, 'GrantDetail')} />
          <Route path="/Apply" element={withGate(<Apply />, 'Apply')} />
          <Route path="/VNextApplication" element={withGate(<VNextApplication />, 'VNextApplication')} />
          <Route path="/VNextFinishPacket" element={withGate(<VNextFinishPacket />, 'VNextFinishPacket')} />
          <Route path="/InvoiceView" element={withGate(<InvoiceView />, 'InvoiceView')} />
          <Route path="/CreateInvoice" element={withGate(<CreateInvoice />, 'CreateInvoice')} />
          <Route path="/NOFOParser" element={withBoundary(<NOFOParser />, 'NOFOParser')} />
          <Route path="/AIGrantScorer" element={withBoundary(<AIGrantScorer />, 'AIGrantScorer')} />
          <Route path="/BudgetDetail" element={withBoundary(<BudgetDetail />, 'BudgetDetail')} />
          <Route path="/PrintPipeline" element={withBoundary(<PrintPipeline />, 'PrintPipeline')} />
          <Route path="/PrintProfilePacket" element={withBoundary(<PrintProfilePacket />, 'PrintProfilePacket')} />
          <Route path="/PrintAwardSummary" element={withBoundary(<PrintAwardSummary />, 'PrintAwardSummary')} />
          <Route path="/OneTimeFix" element={withBoundary(<OneTimeFix />, 'OneTimeFix')} />
          <Route path="/DataSources" element={withBoundary(<DataSources />, 'DataSources')} />
          <Route path="/SourceRegistry" element={withBoundary(<SourceRegistry />, 'SourceRegistry')} />
          <Route path="/BackfillContacts" element={withBoundary(<BackfillContacts />, 'BackfillContacts')} />
          <Route path="/Stewardship" element={withBoundary(<Stewardship />, 'Stewardship')} />
          <Route path="/Settings" element={withBoundary(<Settings />, 'Settings')} />
          <Route path="/Help" element={withBoundary(helpPage, 'Help')} />
          <Route path="/Incognito" element={withBoundary(<Incognito />, 'Incognito')} />
          <Route path="/Diagnostics" element={withBoundary(<Diagnostics />, 'Diagnostics')} />
          <Route path="/CrawlCoverage" element={withBoundary(<CrawlCoverage />, 'CrawlCoverage')} />
          <Route path="/CoverageEvidence" element={withGate(<CoverageEvidence />, 'CoverageEvidence')} />
          <Route path="/ComplianceReportDetail" element={withBoundary(<ComplianceReportDetail />, 'ComplianceReportDetail')} />
          <Route path="/ProfileMatcher" element={withBoundary(<ProfileMatcher />, 'ProfileMatcher')} />
          <Route path="/SourceDirectory" element={withGate(<SourceDirectory />, 'SourceDirectory')} />
          <Route path="/FundingOpportunities" element={withGate(<FundingOpportunities />, 'FundingOpportunities')} />
          <Route path="/FundingLibrary" element={withBoundary(<FundingLibrary />, 'FundingLibrary')} />
          <Route path="/GrantMonitoring" element={withGate(<GrantMonitoring />, 'GrantMonitoring')} />
          <Route path="/PrintableApplication" element={withGate(<PrintableApplication />, 'PrintableApplication')} />
          <Route path="/BillingSheet" element={withGate(<BillingSheet />, 'BillingSheet')} />
          <Route path="/ProfileDetail" element={withGate(<ProfileDetail />, 'ProfileDetail')} />
          <Route path="/OrganizationProfile" element={withBoundary(<OrganizationProfile />, 'OrganizationProfile')} />
          <Route path="/Admin" element={withBoundary(<Admin />, 'Admin')} />
          <Route path="/Admin/*" element={withBoundary(<Admin />, 'Admin')} />
          <Route path="/Pricing" element={withBoundary(<Pricing />, 'Pricing')} />
          <Route path="/Services" element={withBoundary(<Services />, 'Services')} />
          <Route path="/SavedGrants" element={withGate(<SavedGrants />, 'SavedGrants')} />
          <Route path="/FoundationSearch" element={withGate(<FoundationSearch />, 'FoundationSearch')} />
          <Route path="/AnyaIntakeResults" element={withBoundary(<AnyaIntakeResults />, 'AnyaIntakeResults')} />
          <Route path="/PricingRequired" element={withBoundary(<PricingRequired />, 'PricingRequired')} />
          <Route path="/ServiceAgreement" element={withBoundary(<ServiceAgreement />, 'ServiceAgreement')} />
          <Route path="/CheckoutRequired" element={withBoundary(<CheckoutRequired />, 'CheckoutRequired')} />
        </Routes>
      </Layout>
      <AdminPricingToastListener />
    </Suspense>
  )
}

export default function Pages() {
  return (
    <>
      <RouteDocumentMetadata />
      <Routes>
        <Route path="/grantflow/welcome" element={<Navigate to="/welcome" replace />} />
        <Route path="/grantflow/privacy" element={<Navigate to="/privacy" replace />} />
        <Route path="/privacy" element={withBoundary(<PrivacyPolicy />, 'PrivacyPolicy')} />
        <Route path="/Privacy" element={withBoundary(<PrivacyPolicy />, 'PrivacyPolicy')} />
        <Route path="/welcome" element={withBoundary(<Landing />, 'Landing')} />
        <Route path="/start" element={withBoundary(<Start />, 'Start')} />
        <Route path="/login" element={withBoundary(<Login />, 'Login')} />
        <Route path="/HamiltonLiveLogin" element={withBoundary(<HamiltonLiveLogin />, 'HamiltonLiveLogin')} />
        <Route path="/set-password" element={withBoundary(<SetPassword />, 'SetPassword')} />
        <Route path="/ServiceApplication" element={withBoundary(<ServiceApplication />, 'ServiceApplication')} />
        <Route path="/auth/callback" element={withBoundary(<AuthCallback />, 'AuthCallback')} />
        <Route path="/*" element={withBoundary(<LayoutRoutes />, 'Layout')} />
      </Routes>
    </>
  )
}
