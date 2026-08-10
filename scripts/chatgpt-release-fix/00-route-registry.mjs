import fs from 'node:fs'

const routeNames = [
  'Dashboard', 'Organizations', 'MyProfiles', 'Funder', 'DiscoverGrants',
  'FundingResults', 'SmartMatcher', 'ItemFunding', 'GreenHomePrograms', 'Pipeline',
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
]

const registryPath = 'src/pages/routeNames.js'
if (fs.existsSync(registryPath)) throw new Error('routeNames.js already exists')
fs.writeFileSync(
  registryPath,
  `export const ROUTE_NAMES = new Set(${JSON.stringify(routeNames, null, 2)})\n`,
)

const indexPath = 'src/pages/index.jsx'
let indexSource = fs.readFileSync(indexPath, 'utf8')
const importAnchor = "import Layout from './Layout.jsx'"
if (!indexSource.includes(importAnchor)) throw new Error('index Layout import anchor missing')
indexSource = indexSource.replace(
  importAnchor,
  `${importAnchor}\nimport { ROUTE_NAMES } from './routeNames.js'`,
)
const blockStart = indexSource.indexOf('export const ROUTE_NAMES = new Set([')
const blockEndMarker = '\n\nfunction RouteLoading() {'
const blockEnd = indexSource.indexOf(blockEndMarker, blockStart)
if (blockStart < 0 || blockEnd < 0) throw new Error('index ROUTE_NAMES block not found')
if (indexSource.indexOf('export const ROUTE_NAMES = new Set([', blockStart + 1) >= 0) {
  throw new Error('multiple ROUTE_NAMES blocks found')
}
indexSource = indexSource.slice(0, blockStart) + indexSource.slice(blockEnd + 2)
fs.writeFileSync(indexPath, indexSource)

const testPath = 'src/nav/greenHomeNavigation.test.js'
const testSource = fs.readFileSync(testPath, 'utf8')
const beforeImport = "import { ROUTE_NAMES } from '../pages/index.jsx'"
if (!testSource.includes(beforeImport)) throw new Error('navigation test route import missing')
fs.writeFileSync(
  testPath,
  testSource.replace(beforeImport, "import { ROUTE_NAMES } from '../pages/routeNames.js'"),
)

console.log('Applied pure route registry extraction.')
