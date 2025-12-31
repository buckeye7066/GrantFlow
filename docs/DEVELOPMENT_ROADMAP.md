# GrantFlow Development Roadmap

## Vision

Transform GrantFlow from a marketing site + backend foundation into a full-featured grant lifecycle management platform with feature parity to the Base44 reference implementation at https://grant-flow-736bafec.base44.app.

---

## Roadmap Phases

### Phase 1: Marketing Site + Backend Foundation ✅ **Current State**

**Status:** Complete  
**Timeline:** Completed  
**Goal:** Establish foundation infrastructure and marketing presence

#### Completed Features

**Frontend:**
- ✅ Marketing website with landing page
- ✅ Pricing page with subscription tiers
- ✅ Legal pages (Terms, Privacy, HIPAA, Data Retention)
- ✅ Basic Dashboard UI with grant statistics
- ✅ Organization management interface
- ✅ Responsive design with Tailwind CSS
- ✅ React 19 + TypeScript + Vite stack

**Backend:**
- ✅ RESTful API with Express.js
- ✅ SQLite database with WAL mode
- ✅ Profiles (organizations) API with CRUD operations
- ✅ Documents API with upload, parsing, extraction
- ✅ Opportunities API with database/JSON fallback
- ✅ Anya AI runtime foundation
- ✅ Admin authentication middleware
- ✅ Rate limiting and CORS security
- ✅ Health check endpoint

**Infrastructure:**
- ✅ Railway backend deployment
- ✅ Vercel frontend deployment
- ✅ Environment variable management
- ✅ Comprehensive deployment documentation
- ✅ Systemd service configuration
- ✅ Nginx reverse proxy setup

**Database Schema:**
- ✅ `profiles` - Organization and individual data
- ✅ `documents` - File storage and metadata
- ✅ `funding_sources` - Grant opportunities

**Documentation:**
- ✅ README with setup instructions
- ✅ Deployment guides
- ✅ GitHub secrets configuration

---

### Phase 2: Pipeline Dashboard 🚧 **Next Priority**

**Status:** Planned  
**Timeline:** 4-6 weeks  
**Goal:** Build core grant pipeline management with full lifecycle tracking

#### 2.1 Database Extensions (Week 1)

**New Tables:**
```sql
-- Core grant tracking
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  funding_source_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered',
  amount TEXT,
  deadline TEXT,
  notes TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  FOREIGN KEY(organization_id) REFERENCES profiles(id),
  FOREIGN KEY(funding_source_id) REFERENCES funding_sources(id)
);

-- Grant milestones
CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(grant_id) REFERENCES grants(id)
);

-- Expense tracking
CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  amount REAL NOT NULL,
  category TEXT,
  description TEXT,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(grant_id) REFERENCES grants(id)
);

-- Activity audit log
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  user_id TEXT,
  details TEXT,
  timestamp TEXT NOT NULL
);
```

**Migration Script:**
- Create schema migration tool
- Backward compatibility for existing data
- Data validation and integrity checks

#### 2.2 Backend API Development (Weeks 1-2)

**New Endpoints:**

**Grants Management:**
- `GET /api/grants` - List grants with filtering
  - Query params: `status`, `organization_id`, `sort`, `limit`
  - Response includes related data (organization, funding source)
- `POST /api/grants` - Create new grant
  - Validation: required fields, foreign key checks
  - Auto-generate activity log entry
- `GET /api/grants/:id` - Get grant details
  - Include milestones, expenses, activities
- `PATCH /api/grants/:id` - Update grant
  - Status transitions with validation
  - Activity logging
- `DELETE /api/grants/:id` - Soft delete grant
- `POST /api/grants/:id/move` - Change pipeline stage
  - Validate status transitions
  - Trigger notifications (future)

**Milestones:**
- `GET /api/grants/:grantId/milestones` - List milestones
- `POST /api/grants/:grantId/milestones` - Create milestone
- `PATCH /api/milestones/:id` - Update milestone
- `DELETE /api/milestones/:id` - Delete milestone

**Expenses:**
- `GET /api/grants/:grantId/expenses` - List expenses
- `POST /api/grants/:grantId/expenses` - Add expense
- `PATCH /api/expenses/:id` - Update expense
- `DELETE /api/expenses/:id` - Delete expense

**Activities:**
- `GET /api/activities` - List activities with filtering
- `GET /api/activities/:entityType/:entityId` - Entity-specific activities

**Technical Requirements:**
- Input validation with detailed error messages
- Transaction support for multi-table operations
- Pagination for list endpoints
- Proper HTTP status codes
- Comprehensive error handling
- Activity logging for all mutations

#### 2.3 Frontend Pipeline Dashboard (Weeks 3-5)

**New Components:**

**Pipeline View:**
- Kanban board with drag-and-drop
  - Columns: Discovered, Interested, Drafting, Submitted, Awarded, Declined
  - Grant cards with key information
  - Smooth animations and transitions
- List view with sorting and filtering
- Quick actions (edit, move, delete)
- Bulk operations

**Grant Detail View:**
- Full grant information display
- Tabbed interface:
  - Overview (basic info, status, amounts)
  - Milestones (timeline with completion status)
  - Expenses (budget tracking table)
  - Documents (related files)
  - Activity (audit trail)
- Inline editing capabilities
- Status change buttons with confirmation
- Notes section with rich text

**Grant Forms:**
- Create grant modal/page
  - Organization selection
  - Funding source linking
  - Basic information fields
  - Deadline picker
- Edit grant inline or modal
- Form validation with helpful messages
- Auto-save drafts (future enhancement)

**Milestone Management:**
- Milestone list within grant detail
- Add/edit milestone inline
- Due date calendar picker
- Completion tracking
- Visual timeline

**Expense Tracking:**
- Expense table with totals
- Add expense modal
- Category selection
- Budget vs. actual comparison
- Export to CSV (future)

**State Management:**
- React Query for server state
- Optimistic updates for better UX
- Cache invalidation strategies
- Loading and error states

**UI/UX Requirements:**
- Responsive design (mobile-friendly)
- Keyboard navigation support
- Accessibility (ARIA labels, focus management)
- Dark mode support (future)
- Smooth transitions and animations

#### 2.4 Enhanced Dashboard (Week 6)

**Improvements to Existing Dashboard:**
- Real grants data instead of Base44 API
- More detailed statistics
  - Conversion rates by stage
  - Average time in each stage
  - Success rate trends
- Interactive charts
  - Pipeline funnel visualization
  - Time-series grant activity
  - Status distribution pie chart
- Quick filters
  - By organization
  - By status
  - By deadline
- Recent activity feed
- Deadline alerts and reminders

**Dashboard Components:**
- Chart components using chart library (recharts or similar)
- Filter sidebar
- Activity feed component
- Alert banner for urgent items

#### Testing Requirements
- Unit tests for API endpoints
- Integration tests for database operations
- Frontend component tests
- End-to-end tests for critical workflows
- Load testing for pipeline operations

#### Documentation Requirements
- API documentation updates
- User guide for pipeline management
- Developer guide for extending pipeline
- Migration guide for existing data

---

### Phase 3: Proposal Drafting 📋 **Planned**

**Status:** Planned  
**Timeline:** 4-6 weeks  
**Goal:** AI-assisted proposal writing and template management

#### 3.1 Database Extensions (Week 1)

**New Tables:**
```sql
-- Proposal storage
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(grant_id) REFERENCES grants(id)
);

-- Proposal versions for history
CREATE TABLE proposal_versions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(proposal_id) REFERENCES proposals(id)
);

-- Proposal templates
CREATE TABLE proposal_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT,
  sections TEXT, -- JSON array of section definitions
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Proposal sections (for structured proposals)
CREATE TABLE proposal_sections (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  section_name TEXT NOT NULL,
  content TEXT,
  order_index INTEGER NOT NULL,
  word_count INTEGER DEFAULT 0,
  character_limit INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(proposal_id) REFERENCES proposals(id)
);
```

#### 3.2 AI Integration Enhancement (Weeks 1-2)

**Extend Anya Runtime:**
- New action: `generate-proposal-section`
  - Input: section description, context, organization profile
  - Output: Generated content with sources
- New action: `improve-proposal-text`
  - Input: existing text, improvement goals
  - Output: Revised text with explanation
- New action: `analyze-proposal`
  - Input: full proposal content
  - Output: Strengths, weaknesses, suggestions

**OpenAI Integration:**
- Prompt engineering for proposal generation
- Context management (organization profile, grant requirements)
- Token optimization for cost efficiency
- Streaming responses for better UX
- Rate limiting and quota management

**AI Service Module:**
```javascript
// backend/services/aiProposalService.js
class AIProposalService {
  async generateSection(sectionType, context, profile) {}
  async improveText(text, goals) {}
  async analyzeProposal(proposalContent) {}
  async suggestStructure(grantRequirements) {}
}
```

#### 3.3 Backend API Development (Weeks 2-3)

**Proposals API:**
- `GET /api/proposals` - List proposals
- `POST /api/proposals` - Create proposal
- `GET /api/proposals/:id` - Get proposal with sections
- `PATCH /api/proposals/:id` - Update proposal
- `DELETE /api/proposals/:id` - Delete proposal
- `POST /api/proposals/:id/duplicate` - Clone proposal
- `GET /api/proposals/:id/versions` - Version history
- `POST /api/proposals/:id/revert/:version` - Revert to version

**Proposal Sections:**
- `GET /api/proposals/:id/sections` - List sections
- `POST /api/proposals/:id/sections` - Add section
- `PATCH /api/sections/:id` - Update section content
- `DELETE /api/sections/:id` - Delete section
- `POST /api/sections/:id/reorder` - Change section order

**AI Generation:**
- `POST /api/proposals/:id/generate-section` - Generate section content
- `POST /api/proposals/:id/improve` - Improve existing content
- `POST /api/proposals/:id/analyze` - Get AI analysis
- `GET /api/proposals/:id/suggestions` - Get improvement suggestions

**Templates:**
- `GET /api/proposal-templates` - List templates
- `POST /api/proposal-templates` - Create template
- `GET /api/proposal-templates/:id` - Get template
- `POST /api/proposals/from-template/:templateId` - Create from template

#### 3.4 Frontend Proposal Editor (Weeks 3-6)

**Rich Text Editor:**
- Choose editor library (e.g., Tiptap, Slate, Lexical)
- Formatting toolbar (bold, italic, lists, headings)
- Word count and character limits
- Auto-save functionality
- Collaborative editing preparation (conflict resolution)

**Proposal Editor UI:**
- Split-pane layout (sections list + editor)
- Section management sidebar
  - Add/remove sections
  - Reorder via drag-and-drop
  - Section-specific word limits
- Main editor area
  - Rich text editing
  - AI assistant panel
  - Version history access
- Header with proposal metadata
  - Title, status, last saved
  - Export button (PDF, DOCX)
  - Share/collaborate button (future)

**AI Assistant Panel:**
- Generate section button
  - Modal with section type and context
  - Loading state during generation
  - Accept/reject generated content
- Improve text button
  - Select text and request improvements
  - Show before/after comparison
  - Apply improvements inline
- Analyze proposal button
  - Run AI analysis
  - Display results in sidebar
  - Actionable suggestions
- Suggestions feed
  - Real-time suggestions as user types
  - Grammar and style improvements
  - Content recommendations

**Templates:**
- Template gallery
- Preview template before use
- Create proposal from template
- Save current proposal as template
- Edit templates (admin)

**Version Control:**
- Version history modal
- Side-by-side diff view
- Revert to previous version
- Version annotations

**Export Functionality:**
- Export to PDF
- Export to Word (.docx)
- Email integration (future)
- Direct submission (future)

#### Testing Requirements
- AI service unit tests with mocked OpenAI responses
- Proposal API integration tests
- Editor component tests
- End-to-end proposal creation workflow
- Version control testing

#### Documentation Requirements
- AI integration guide
- Proposal editor user manual
- Template creation guide
- API documentation for proposals

---

### Phase 4: Analytics & Reporting 📊 **Planned**

**Status:** Planned  
**Timeline:** 3-4 weeks  
**Goal:** Comprehensive reporting, analytics, and insights

#### 4.1 Analytics Backend (Weeks 1-2)

**Analytics Service:**
```javascript
// backend/services/analyticsService.js
class AnalyticsService {
  async getOverviewMetrics(dateRange) {}
  async getSuccessRates(filters) {}
  async getPipelineFunnel() {}
  async getTrends(metric, interval) {}
  async getOrganizationPerformance(orgId) {}
  async getFundingSourceEffectiveness() {}
}
```

**Analytics Endpoints:**
- `GET /api/analytics/overview` - Dashboard metrics
  - Total grants, success rate, avg. award amount
  - Stage distribution
  - Active vs. completed
- `GET /api/analytics/success-rate` - Success rate analysis
  - By organization, funding source, grant type
  - Time-series success rate
  - Conversion rates by stage
- `GET /api/analytics/trends` - Trend analysis
  - Grant activity over time
  - Award amounts trends
  - Submission patterns
- `GET /api/analytics/funnel` - Pipeline funnel data
  - Grants by stage
  - Conversion rates between stages
  - Average time in each stage
- `GET /api/analytics/performance` - Performance metrics
  - Top performing organizations
  - Most successful funding sources
  - Fastest grant closures
- `POST /api/analytics/report` - Custom report generation
  - Flexible filters and grouping
  - Export to CSV/PDF

**Aggregation Queries:**
- Efficient SQL queries with proper indexing
- Caching for expensive computations
- Real-time vs. batch processing decisions
- Date range filtering optimization

#### 4.2 Frontend Analytics Dashboard (Weeks 2-4)

**Charting Library Integration:**
- Choose library (recharts, chart.js, or nivo)
- Create reusable chart components
- Responsive chart sizing
- Accessibility considerations

**Analytics Dashboard Page:**
- Overview section
  - Key metrics cards
  - Mini trend indicators
  - Period-over-period comparisons
- Pipeline funnel visualization
  - Funnel chart with stage counts
  - Clickable stages for drill-down
  - Conversion rate annotations
- Trend charts
  - Line charts for time-series data
  - Selectable date ranges
  - Multiple metric comparison
- Success rate analysis
  - Bar charts by organization/source
  - Success rate by quarter/year
  - Filters for segmentation
- Performance leaderboards
  - Top organizations
  - Best funding sources
  - Quick stats tables

**Custom Report Builder:**
- Report configuration interface
  - Select metrics and dimensions
  - Choose visualization type
  - Apply filters
- Preview report
- Save report configurations
- Schedule reports (future)

**Export Functionality:**
- Export charts as images
- Export data as CSV
- Generate PDF reports
- Email reports (future)

**Interactive Features:**
- Drill-down capabilities
- Date range selectors
- Filter panels
- Comparison modes
- Real-time updates

#### Testing Requirements
- Analytics service unit tests
- Query performance testing
- Chart rendering tests
- Export functionality tests

#### Documentation Requirements
- Analytics API documentation
- Reporting user guide
- Metrics definitions glossary

---

### Phase 5: Submission Tracking & Notifications 📤 **Planned**

**Status:** Planned  
**Timeline:** 3-4 weeks  
**Goal:** Complete submission workflow with tracking and reminders

#### 5.1 Database Extensions (Week 1)

**New Tables:**
```sql
-- Submission tracking
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  submission_date TEXT,
  status TEXT NOT NULL DEFAULT 'preparing',
  method TEXT, -- online, email, mail, in-person
  tracking_number TEXT,
  confirmation_received BOOLEAN DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(grant_id) REFERENCES grants(id)
);

-- Submission requirements checklist
CREATE TABLE submission_requirements (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  requirement_name TEXT NOT NULL,
  completed BOOLEAN DEFAULT 0,
  document_id TEXT,
  notes TEXT,
  order_index INTEGER NOT NULL,
  FOREIGN KEY(submission_id) REFERENCES submissions(id),
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

-- Follow-up activities
CREATE TABLE follow_ups (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  type TEXT NOT NULL, -- call, email, meeting, document
  description TEXT NOT NULL,
  due_date TEXT,
  completed BOOLEAN DEFAULT 0,
  completed_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(submission_id) REFERENCES submissions(id)
);

-- Notifications
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  type TEXT NOT NULL, -- deadline, follow_up, status_change
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  message TEXT NOT NULL,
  read BOOLEAN DEFAULT 0,
  action_url TEXT,
  created_at TEXT NOT NULL
);
```

#### 5.2 Backend API Development (Weeks 1-2)

**Submissions:**
- `GET /api/submissions` - List submissions
- `POST /api/submissions` - Create submission
- `GET /api/submissions/:id` - Get submission details
- `PATCH /api/submissions/:id` - Update submission
- `DELETE /api/submissions/:id` - Delete submission

**Requirements Checklist:**
- `GET /api/submissions/:id/requirements` - List requirements
- `POST /api/submissions/:id/requirements` - Add requirement
- `PATCH /api/requirements/:id` - Update requirement
- `POST /api/requirements/:id/complete` - Mark complete
- `DELETE /api/requirements/:id` - Delete requirement

**Follow-ups:**
- `GET /api/submissions/:id/follow-ups` - List follow-ups
- `POST /api/submissions/:id/follow-ups` - Add follow-up
- `PATCH /api/follow-ups/:id` - Update follow-up
- `POST /api/follow-ups/:id/complete` - Mark complete
- `DELETE /api/follow-ups/:id` - Delete follow-up

**Notifications:**
- `GET /api/notifications` - List user notifications
- `POST /api/notifications/:id/read` - Mark as read
- `POST /api/notifications/read-all` - Mark all as read
- `DELETE /api/notifications/:id` - Dismiss notification

**Notification Service:**
```javascript
// backend/services/notificationService.js
class NotificationService {
  async createDeadlineReminder(grant) {}
  async createFollowUpReminder(followUp) {}
  async notifyStatusChange(grant, oldStatus, newStatus) {}
  async getUnreadNotifications(userId) {}
}
```

**Scheduled Jobs:**
- Daily deadline check
- Follow-up reminders
- Overdue submission alerts
- Background job runner (node-cron or similar)

#### 5.3 Frontend Submission Tracking (Weeks 2-4)

**Submission Detail Page:**
- Submission overview
  - Status, method, tracking info
  - Submission date and confirmation
- Requirements checklist
  - Checkbox list with documents
  - Attach documents to requirements
  - Progress indicator
- Follow-up activities
  - Timeline view
  - Add follow-up modal
  - Mark complete
  - Due date indicators
- Related documents
  - Document list with preview
  - Upload documents
  - Link documents to requirements

**Notifications:**
- Notification bell icon in header
- Unread count badge
- Notification dropdown/panel
- Click to navigate to entity
- Mark as read functionality
- Clear all notifications

**Deadline Calendar:**
- Calendar view of all deadlines
- Color coding by urgency
- Click date to see deadlines
- Filter by grant status
- Month/week/day views

**Submission Workflow:**
- Guided submission wizard
  - Step 1: Review grant info
  - Step 2: Upload documents
  - Step 3: Complete checklist
  - Step 4: Submit and confirm
- Progress tracking
- Email confirmation (future)

#### Testing Requirements
- Notification service tests
- Scheduled job tests
- Submission workflow E2E tests
- Calendar component tests

#### Documentation Requirements
- Submission workflow guide
- Notification configuration
- Scheduled jobs documentation

---

### Phase 6: User Management & RBAC 🔐 **Planned**

**Status:** Planned  
**Timeline:** 3-4 weeks  
**Goal:** Multi-user support with role-based access control

#### 6.1 Authentication System (Weeks 1-2)

**Database Schema:**
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  last_login TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  permissions TEXT NOT NULL -- JSON array of permission strings
);

CREATE TABLE user_organizations (
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, organization_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(organization_id) REFERENCES profiles(id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
```

**Auth Service:**
- Password hashing with bcrypt
- JWT token generation and validation
- Session management
- Password reset flow
- Email verification (optional)

**Auth Endpoints:**
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `POST /api/auth/refresh` - Refresh token
- `POST /api/auth/forgot-password` - Password reset request
- `POST /api/auth/reset-password` - Reset password with token
- `GET /api/auth/me` - Get current user

#### 6.2 Authorization & Permissions (Week 2)

**Permission System:**
```javascript
// Permission constants
const PERMISSIONS = {
  GRANTS_VIEW: 'grants:view',
  GRANTS_CREATE: 'grants:create',
  GRANTS_EDIT: 'grants:edit',
  GRANTS_DELETE: 'grants:delete',
  PROPOSALS_VIEW: 'proposals:view',
  PROPOSALS_EDIT: 'proposals:edit',
  ORGANIZATIONS_MANAGE: 'organizations:manage',
  USERS_MANAGE: 'users:manage',
  ANALYTICS_VIEW: 'analytics:view',
  SETTINGS_MANAGE: 'settings:manage',
};

// Role definitions
const ROLES = {
  ADMIN: {
    name: 'admin',
    permissions: Object.values(PERMISSIONS), // All permissions
  },
  MANAGER: {
    name: 'manager',
    permissions: [
      PERMISSIONS.GRANTS_VIEW,
      PERMISSIONS.GRANTS_CREATE,
      PERMISSIONS.GRANTS_EDIT,
      PERMISSIONS.PROPOSALS_VIEW,
      PERMISSIONS.PROPOSALS_EDIT,
      PERMISSIONS.ORGANIZATIONS_MANAGE,
      PERMISSIONS.ANALYTICS_VIEW,
    ],
  },
  MEMBER: {
    name: 'member',
    permissions: [
      PERMISSIONS.GRANTS_VIEW,
      PERMISSIONS.PROPOSALS_VIEW,
      PERMISSIONS.PROPOSALS_EDIT,
    ],
  },
  VIEWER: {
    name: 'viewer',
    permissions: [
      PERMISSIONS.GRANTS_VIEW,
      PERMISSIONS.PROPOSALS_VIEW,
      PERMISSIONS.ANALYTICS_VIEW,
    ],
  },
};
```

**Authorization Middleware:**
```javascript
// backend/middleware/authorize.js
function authorize(...requiredPermissions) {
  return (req, res, next) => {
    // Check if user has required permissions
    // Allow/deny access
  };
}

// Usage
app.get('/api/grants', authenticate, authorize('grants:view'), grantsController.list);
app.post('/api/grants', authenticate, authorize('grants:create'), grantsController.create);
```

**User API:**
- `GET /api/users` - List users (admin)
- `POST /api/users` - Create user (admin)
- `GET /api/users/:id` - Get user details
- `PATCH /api/users/:id` - Update user
- `DELETE /api/users/:id` - Deactivate user (admin)
- `GET /api/users/:id/permissions` - Get user permissions
- `POST /api/users/:id/organizations` - Add to organization

#### 6.3 Frontend Auth & User Management (Weeks 3-4)

**Authentication UI:**
- Login page
  - Email/password form
  - "Remember me" option
  - Forgot password link
  - Error handling
- Registration page
  - User information form
  - Password strength indicator
  - Terms acceptance
  - Email verification (optional)
- Password reset flow
  - Request reset page
  - Reset with token page

**User Context:**
```typescript
// src/contexts/UserContext.tsx
interface User {
  id: string;
  email: string;
  fullName: string;
  role: string;
  permissions: string[];
}

interface UserContextValue {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  hasPermission: (permission: string) => boolean;
  hasRole: (role: string) => boolean;
}
```

**Protected Routes:**
- Route guards based on permissions
- Redirect to login if unauthenticated
- Show "Access Denied" for unauthorized
- Permission-based UI elements

**User Management (Admin):**
- User list page
  - Search and filter users
  - User status indicators
  - Quick actions (edit, deactivate)
- Create user modal
- Edit user modal
  - Update role and permissions
  - Manage organization access
- User profile page
  - View user activity
  - Organization memberships
  - Permission overview

**Permission-Based UI:**
- Conditional rendering based on permissions
- Disabled buttons for unauthorized actions
- Hide entire sections if no permission
- Permission helper utilities

#### Testing Requirements
- Authentication flow tests
- Authorization middleware tests
- Permission checking tests
- Login/logout E2E tests
- Role-based access E2E tests

#### Documentation Requirements
- Authentication guide
- Permission system documentation
- User management manual
- Security best practices

---

### Phase 7: Advanced Features 🚀 **Future**

**Status:** Future Enhancements  
**Timeline:** TBD  
**Goal:** Polish and advanced capabilities

#### Potential Features
- **Email Integration**: Send notifications, reminders via email
- **Calendar Sync**: Integrate with Google Calendar, Outlook
- **Document Collaboration**: Real-time collaborative editing
- **Mobile App**: Native iOS/Android applications
- **API Webhooks**: Integrate with external systems
- **Advanced Search**: Full-text search across all entities
- **Bulk Operations**: Import/export grants, batch updates
- **Audit Logs**: Comprehensive activity tracking
- **Custom Fields**: User-defined fields for grants/organizations
- **Workflow Automation**: Automated actions based on triggers
- **Integration Marketplace**: Connect with CRMs, accounting software
- **Multi-language Support**: Internationalization (i18n)
- **Advanced Reporting**: Custom dashboards, scheduled reports
- **AI Insights**: Predictive analytics, success probability
- **Document OCR**: Advanced document parsing and extraction
- **Budget Forecasting**: Predict future grant revenue

---

## Technical Requirements (All Phases)

### Development Standards
- **Code Quality**: ESLint, Prettier, TypeScript strict mode
- **Testing**: Unit, integration, E2E tests with >80% coverage
- **Documentation**: JSDoc comments, API documentation, user guides
- **Performance**: Page load <2s, API response <200ms
- **Accessibility**: WCAG 2.1 AA compliance
- **Security**: OWASP Top 10 compliance, regular audits

### Infrastructure Requirements
- **Database**: Migrate to PostgreSQL for production scale (optional)
- **Caching**: Redis for session storage and caching
- **File Storage**: S3 or similar for document storage at scale
- **Background Jobs**: Queue system for async tasks (Bull, BullMQ)
- **Monitoring**: Error tracking (Sentry), analytics (Plausible/Google Analytics)
- **Logging**: Structured logging with log aggregation
- **CI/CD**: Automated testing and deployment pipelines

### Security Requirements
- **Authentication**: Secure password storage, session management
- **Authorization**: Row-level security, permission checks
- **Data Protection**: Encryption at rest and in transit
- **Input Validation**: Sanitize all user inputs
- **Rate Limiting**: Protect against abuse
- **Security Headers**: CSP, HSTS, X-Frame-Options
- **Regular Updates**: Keep dependencies up to date
- **Penetration Testing**: Regular security audits

---

## Success Metrics

### Phase 2 Success Criteria
- [ ] All grant CRUD operations functional
- [ ] Pipeline dashboard with drag-and-drop working
- [ ] Grant detail page with all tabs
- [ ] Activity logging on all mutations
- [ ] <500ms API response time
- [ ] Mobile-responsive design
- [ ] >85% test coverage

### Phase 3 Success Criteria
- [ ] Proposal editor with rich text
- [ ] AI section generation working
- [ ] Template system functional
- [ ] Version control operational
- [ ] Export to PDF/DOCX
- [ ] <3s AI response time
- [ ] User satisfaction >4/5

### Phase 4 Success Criteria
- [ ] All analytics endpoints functional
- [ ] Interactive charts rendering
- [ ] Custom report generation working
- [ ] Export functionality operational
- [ ] <1s chart load time
- [ ] Accurate metrics calculations

### Overall Success Criteria
- [ ] Feature parity with Base44 reference implementation
- [ ] User adoption >80% of target audience
- [ ] System uptime >99.5%
- [ ] Average page load <2s
- [ ] User satisfaction score >4/5
- [ ] Zero critical security vulnerabilities

---

## Resources & Dependencies

### Development Team Needs
- **Backend Developer**: API development, database design
- **Frontend Developer**: UI components, state management
- **Full-Stack Developer**: Integration, end-to-end features
- **UX Designer**: User flows, interface design
- **QA Engineer**: Testing, quality assurance

### Third-Party Services
- **OpenAI API**: AI-powered features ($20-200/month estimated)
- **Email Service**: Transactional emails (SendGrid, Mailgun)
- **File Storage**: S3 or similar for documents
- **Monitoring**: Error tracking and analytics
- **SSL Certificates**: HTTPS encryption

### Budget Estimates (Optional)
- **Phase 2**: 160-240 development hours
- **Phase 3**: 160-240 development hours
- **Phase 4**: 120-160 development hours
- **Phase 5**: 120-160 development hours
- **Phase 6**: 120-160 development hours

---

## Risk Management

### Technical Risks
- **Database Performance**: Monitor query performance, add indexes as needed
- **AI API Costs**: Implement caching, optimize prompts
- **Browser Compatibility**: Test across browsers
- **Mobile Performance**: Optimize for mobile devices

### Mitigation Strategies
- Regular performance testing
- Cost monitoring and alerts
- Progressive enhancement approach
- Responsive design from the start

---

## Conclusion

This roadmap provides a clear, actionable path from the current marketing site + backend foundation to a full-featured grant lifecycle management platform with complete feature parity to the Base44 reference implementation.

**Next Immediate Steps:**
1. Set up development environment for Phase 2
2. Create database migration for grants, milestones, expenses tables
3. Begin backend API development for grants management
4. Design UI mockups for pipeline dashboard

---

## References

- [Feature Parity Analysis](./FEATURE_PARITY.md)
- [Backend Documentation](../backend/README.md)
- [UI Architecture Plan](./UI_ARCHITECTURE.md)
- [Base44 Reference Implementation](https://grant-flow-736bafec.base44.app)
