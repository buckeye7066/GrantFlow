# Real Web Crawlers Implementation

## Overview
Complete implementation of 6 specialized web crawlers for finding real funding opportunities based on profile criteria. All crawlers return only opportunities with **80%+ match scores** and exclude loans and matching funds.

## Crawler Types Implemented

### 1. **Local Funding Crawler** 🗺️
- **Scope**: 50-mile radius from profile ZIP or student's school ZIP
- **Sources**: 
  - Community Foundation Locator
  - United Way organizations
  - Local grant networks
- **Match Scoring**: Distance-weighted + profile alignment
- **File**: `backend/services/crawlers/localFundingCrawler.js`

### 2. **Government Funding Crawler** 🏛️
- **Scope**: Federal, State (profile state), Local government
- **Sources**:
  - Grants.gov API
  - NIH Grants
  - FEMA Grants  
  - SAMHSA Grants
  - Medicare/Medicaid (CMS)
  - State grant databases (e.g., Ohio)
- **Match Scoring**: Eligibility + focus area alignment
- **File**: `backend/services/crawlers/governmentFundingCrawler.js`

### 3. **Student Grants Crawler** 🎓
- **Scope**: Scholarships, FAFSA, school-specific aid
- **Sources**:
  - Federal Student Aid (Pell Grant, FSEOG)
  - College Board Scholarship Search
  - Fastweb
  - Scholarships.com
  - CommonApp
  - School-specific financial aid portals
- **Match Scoring**: GPA + test scores + interests + financial need
- **File**: `backend/services/crawlers/studentGrantsCrawler.js`

### 4. **ECF CHOICES Benefits Crawler** 💙
- **Scope**: Two branches
  - Individual benefits for ECF participants
  - Support/funding for family model CLS-FM homes
- **Sources**: State Medicaid waivers, disability services
- **File**: `backend/services/crawlers/ecfBenefitsCrawler.js`

### 5. **Item-Specific Funding Crawler** 📦
- **Scope**: Funding for specific items (vehicles, equipment, supplies)
- **Example**: 15-passenger van for mission-minded nonprofit
- **Match**: Both item AND profile criteria must match
- **File**: `backend/services/crawlers/itemFundingCrawler.js`

### 6. **Special Needs Funding Crawler** 👥
- **Scope**: Population-specific funding
  - Cancer survivors
  - Single parents
  - Disabled individuals
  - Other special circumstances
- **Sources**: Specialized foundations and support programs
- **File**: `backend/services/crawlers/specialNeedsCrawler.js`

## User Interface

### Crawler Selection Component
**File**: `src/components/discovery/CrawlerSelection.jsx`

Features:
- ✅ Individual checkboxes for each crawler
- ✅ "Select All" option
- ✅ Visual icons and descriptions
- ✅ Real-time progress indicators
- ✅ Results summary display
- ✅ Auto-add to pipeline for 80%+ matches

### Integration in Discover Grants Page
**File**: `src/pages/DiscoverGrants.jsx`

- Two-tab interface:
  1. **Template Search**: Existing AI-powered search
  2. **Real Web Crawlers**: New crawler system

## API Endpoints

**File**: `backend/routes/realCrawlers.js`

### POST `/api/crawlers/run`
Run a single crawler with profile data

### POST `/api/crawlers/run-batch`
Run multiple crawlers in parallel

### GET `/api/crawlers/status`
Get crawler availability and statistics

## Key Features

### Match Scoring Algorithm
Each crawler implements custom scoring based on:
- Profile type alignment (nonprofit, individual, student)
- Geographic proximity (for local funding)
- Focus area/interest matching
- Eligibility requirements
- Special criteria (test scores, financial need, etc.)

### Automatic Pipeline Integration
- Opportunities with **80%+ match** automatically added to pipeline
- Lower matches available for manual review
- Duplicate detection prevents redundant entries

### Exclusion Filters
All crawlers exclude:
- ❌ Loans (any type)
- ❌ Matching fund requirements
- ❌ Repayable grants

## Database Schema Updates

### funding_opportunities table
- Stores all discovered opportunities
- Includes match_score field
- Source tracking for crawler type

### grants table (pipeline)
- Auto-populated with 80%+ matches
- Links to organization via profile
- Includes match reasoning

### crawler_logs table
- Tracks crawler execution
- Performance metrics
- Result summaries

## Usage Flow

1. User selects profile in Discover Grants
2. Switches to "Real Web Crawlers" tab
3. Selects desired crawlers (or "Select All")
4. Clicks "Run Selected Crawlers"
5. System executes crawlers in parallel
6. Results filtered to 80%+ matches
7. Opportunities auto-added to pipeline
8. User sees summary of results

## Performance Optimizations

- Parallel crawler execution
- Request throttling to prevent blocking
- Caching of geocoding results
- Batch database inserts
- Progress streaming to UI

## Security & Compliance

- No storage of login credentials
- Respects robots.txt
- Rate limiting on external APIs
- User data isolation
- Audit logging of crawler runs

## Future Enhancements

1. **Schedule Crawlers**: Run automatically daily/weekly
2. **Custom Sources**: Add user-defined funding sources
3. **ML Scoring**: Learn from user feedback on matches
4. **Alert System**: Notify users of new opportunities
5. **API Integrations**: Direct integration with more databases

## Testing

To test the crawlers:

```bash
# Start development servers
npm run dev:full

# Navigate to Discover Grants
http://localhost:5173/grantflow/DiscoverGrants

# Select profile and switch to "Real Web Crawlers" tab
# Select crawlers and run
```

## Success Metrics

- ✅ 6 specialized crawlers implemented
- ✅ Real web sources integrated
- ✅ 80%+ match filtering working
- ✅ Automatic pipeline population
- ✅ No loans or matching funds included
- ✅ User-friendly checkbox interface
- ✅ Parallel execution capability

The system is now ready to discover real funding opportunities from actual web sources!