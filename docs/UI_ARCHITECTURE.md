# GrantFlow UI Architecture

## Overview

This document outlines the UI architecture for GrantFlow, including current marketing site components and planned application components to achieve feature parity with the Base44 reference implementation.

---

## Current State: Hybrid Marketing + Application UI

### Technology Stack

**Core:**
- React 19.2.0
- TypeScript 5.9.3
- Vite 7.2.4 (build tool with HMR)
- React Router 7.11.0

**Styling:**
- Tailwind CSS 4.1.18
- Custom utility classes
- Responsive design (mobile-first)

**State Management:**
- React Query 5.62.7 (server state)
- React Context (auth, theme)
- Local component state (useState, useReducer)

**UI Components:**
- Lucide React 0.470.0 (icons)
- Custom component library
- No external UI framework (headless approach)

---

## Current Component Structure

### Marketing Site Components

Located in `src/pages/`:

**Public Pages:**
- `Home.jsx` - Landing page with hero, features, CTAs
- `Pricing.jsx` - Subscription tiers and pricing
- `Terms.jsx` - Terms of Service
- `Privacy.jsx` - Privacy Policy
- `HIPAA.jsx` - HIPAA Compliance information
- `DataRetention.jsx` - Data retention policy

**Layout Components:**
- `components/Navigation.jsx` - Main navigation bar
- `components/Footer.jsx` - Site footer with links

### Application Components

Located in `src/pages/` and `src/components/`:

**Application Pages:**
- `Dashboard.tsx` - Grant operations dashboard
- `Organizations.tsx` - Organization management
- `Login.tsx` - Authentication page

**Application Components:**
- `components/layout/AppShell.tsx` - Application layout wrapper
- `components/organizations/OrganizationCard.tsx` - Organization card display
- `components/organizations/OrganizationForm.tsx` - Create/edit organization
- `components/organizations/ComprehensiveApplicationForm.tsx` - Grant application form
- `components/organizations/UploadApplicationForm.tsx` - Document upload
- `components/anya/AnyaStatusPanel.tsx` - AI runtime status widget

**Context Providers:**
- `contexts/AdminContext.tsx` - Admin authentication state
# UI Architecture Plan

This document outlines the user interface architecture for GrantFlow, including component organization, design system, state management, and implementation guidelines.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Design System](#design-system)
3. [Component Library](#component-library)
4. [Page Structure](#page-structure)
5. [State Management](#state-management)
6. [Routing Strategy](#routing-strategy)
7. [Data Fetching](#data-fetching)
8. [Performance Optimization](#performance-optimization)
9. [Accessibility](#accessibility)
10. [Testing Strategy](#testing-strategy)

---

## Architecture Overview

### Technology Stack

- **Framework:** React 19.2.0
- **Build Tool:** Vite 7.2.4
- **Styling:** Tailwind CSS 4.1.18
- **Routing:** React Router DOM 7.11.0
- **State Management:** React Context + TanStack Query
- **Icons:** Lucide React
- **Type Safety:** TypeScript 5.9.3

### Project Structure

```
src/
├── components/          # Reusable UI components
│   ├── common/         # Generic components (Button, Input, Card)
│   ├── layout/         # Layout components (Header, Footer, Sidebar)
│   ├── grants/         # Grant-specific components
│   ├── applications/   # Application-specific components
│   ├── documents/      # Document management components
│   └── anya/           # ANYA AI chat components
├── pages/              # Page-level components
│   ├── HomePage.jsx
│   ├── Dashboard.jsx
│   ├── GrantSearch.jsx
│   ├── GrantDetail.jsx
│   ├── Applications.jsx
│   ├── Documents.jsx
│   ├── Profile.jsx
│   └── Settings.jsx
├── hooks/              # Custom React hooks
│   ├── useAuth.js
│   ├── useGrants.js
│   ├── useApplications.js
│   └── useNotifications.js
├── contexts/           # React Context providers
│   ├── AuthContext.jsx
│   ├── ThemeContext.jsx
│   └── NotificationContext.jsx
├── api/                # API client and utilities
│   ├── client.js       # Axios/fetch wrapper
│   ├── grants.js       # Grant API functions
│   ├── applications.js # Application API functions
│   └── documents.js    # Document API functions
├── utils/              # Utility functions
│   ├── formatters.js   # Date, currency formatters
│   ├── validators.js   # Form validation
│   └── constants.js    # App constants
├── styles/             # Global styles
│   ├── index.css       # Tailwind imports
│   └── custom.css      # Custom CSS if needed
└── App.jsx             # Root component
```

---

## Design System

### Color Palette

**Brand Colors:**
```css
--axiom-blue: #1e40af;        /* Primary brand color */
--axiom-light-blue: #3b82f6;  /* Secondary brand color */
```

**Semantic Colors (Tailwind):**
- `slate-*` - Neutral grays for text and backgrounds
- `emerald-*` - Success states
- `amber-*` - Warning states
- `red-*` - Error states
- `blue-*` - Info states

### Typography

**Font Stack:**
- System fonts (native, performant)
- Fallback: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif`

**Scale:**
- `text-xs` - 12px (0.75rem)
- `text-sm` - 14px (0.875rem)
- `text-base` - 16px (1rem)
- `text-lg` - 18px (1.125rem)
- `text-xl` - 20px (1.25rem)
- `text-2xl` - 24px (1.5rem)
- `text-3xl` - 30px (1.875rem)

### Spacing System

**Tailwind spacing scale (4px base):**
- `p-2` = 8px, `p-4` = 16px, `p-6` = 24px, `p-8` = 32px
- Consistent margin/padding across components

### Component Patterns

**Cards:**
```tsx
<Card>
  <CardHeader>
    <CardTitle>Title</CardTitle>
  </CardHeader>
  <CardContent>
    {/* Content */}
  </CardContent>
</Card>
```

**Buttons:**
```tsx
<Button variant="default|outline">
  Label
</Button>
```

**Badges:**
```tsx
<Badge variant="default|warning|success|neutral">
  Status
</Badge>
```

---

## Planned Application Components

Based on [Feature Parity Analysis](./FEATURE_PARITY.md) and [Development Roadmap](./DEVELOPMENT_ROADMAP.md).

### Phase 2: Pipeline Management Components

#### Pipeline Dashboard

**PipelineKanbanView.tsx**
- Kanban board with drag-and-drop
- Columns for each grant stage
- Grant cards with summary info
- Drag handlers with optimistic updates

```tsx
interface PipelineKanbanViewProps {
  grants: Grant[];
  onMoveGrant: (grantId: string, newStatus: GrantStatus) => void;
}

const PIPELINE_STAGES = [
  'discovered',
  'interested', 
  'drafting',
  'submitted',
  'awarded',
  'declined'
];
```

**PipelineListView.tsx**
- Tabular view with sorting
- Multi-column filter
- Bulk operations
- Export functionality

**GrantCard.tsx**
- Compact card for Kanban
- Organization name, grant title
- Amount, deadline
- Status badge
- Quick actions menu

#### Grant Detail

**GrantDetailPage.tsx**
- Full grant information
- Tabbed interface with sections
- Inline editing capability
- Status change controls

**GrantTabs:**
1. **OverviewTab.tsx** - Basic info, status, amounts
2. **MilestonesTab.tsx** - Timeline with milestones
3. **ExpensesTab.tsx** - Budget tracking
4. **DocumentsTab.tsx** - Related documents
5. **ActivityTab.tsx** - Audit trail

**MilestoneTimeline.tsx**
- Visual timeline of milestones
- Due dates and completion status
- Add/edit milestones inline
- Progress indicators

**ExpenseTable.tsx**
- Expense list with categories
- Add expense modal
- Budget vs. actual display
- Total calculations

**ActivityFeed.tsx**
- Chronological activity list
- User avatars and timestamps
- Filterable by action type
- Pagination

#### Grant Forms

**CreateGrantModal.tsx**
- Modal or side drawer
- Organization selection
- Funding source linking
- Form validation

**EditGrantForm.tsx**
- Inline or modal editing
- Field-level validation
- Auto-save drafts
- Cancel/save actions

---

### Phase 3: Proposal Drafting Components

#### Proposal Editor

**ProposalEditorPage.tsx**
- Split-pane layout
- Section management sidebar
- Rich text editor area
- AI assistant panel

**ProposalSidebar.tsx**
- Section list with navigation
- Add/remove/reorder sections
- Section metadata (word count, limits)
- Template selection

**RichTextEditor.tsx**
- Tiptap or Slate integration
- Formatting toolbar
- Word/character count
- Auto-save indicator

**AIAssistantPanel.tsx**
- Generate section button
- Improve text button
- Analyze proposal button
- Suggestions feed
- Loading states

**GenerateSectionModal.tsx**
- Section type selection
- Context inputs
- Generation options
- Preview and accept/reject

**ProposalTemplateGallery.tsx**
- Template cards with previews
- Create from template
- Template metadata
- Search and filter

**VersionHistoryModal.tsx**
- Version list with timestamps
- Side-by-side diff view
- Revert confirmation
- Version annotations

**ProposalExport.tsx**
- Export format selection (PDF, DOCX)
- Preview before export
- Download handler
- Email option (future)

---

### Phase 4: Analytics Components

#### Analytics Dashboard

**AnalyticsDashboardPage.tsx**
- Overview metrics cards
- Chart grid layout
- Filter controls
- Date range selector

**MetricsCards.tsx**
- Key metric displays
- Trend indicators (↑↓)
- Period comparisons
- Click to drill down

**Charts:**
- **PipelineFunnelChart.tsx** - Funnel visualization with conversion rates
- **TrendLineChart.tsx** - Time-series data with multiple metrics
- **SuccessRateBarChart.tsx** - Bar chart by organization/source
- **StatusPieChart.tsx** - Distribution of grant statuses

**AnalyticsFilters.tsx**
- Date range picker
- Organization filter
- Status filter
- Custom filter builder

**CustomReportBuilder.tsx**
- Metric selection
- Dimension selection
- Visualization type
- Report preview
- Save/schedule report

**ReportExport.tsx**
- Export to CSV
- Export to PDF
- Email delivery options
- Scheduled reports

---

### Phase 5: Submission Tracking Components

#### Submission Management

**SubmissionDetailPage.tsx**
- Submission overview
- Requirements checklist
- Follow-up activities
- Related documents

**RequirementsChecklist.tsx**
- Checkbox list
- Attach document to requirement
- Progress bar
- Completion tracking

**FollowUpTimeline.tsx**
- Timeline view of follow-ups
- Add follow-up modal
- Mark complete action
- Due date indicators
- Type icons (call, email, meeting)

**SubmissionWizard.tsx**
- Step-by-step submission flow
- Progress indicator
- Step validation
- Review and submit

**DeadlineCalendar.tsx**
- Calendar with deadline markers
- Color coding by urgency
- Click date to see details
- Month/week/day views
- Filter by status

---

### Phase 6: User Management Components

#### Authentication

**LoginPage.tsx**
- Email/password form
- Remember me option
- Forgot password link
- Error messaging

**RegisterPage.tsx**
- User registration form
- Password strength indicator
- Terms acceptance
- Email verification

**ForgotPasswordPage.tsx**
- Email input
- Reset link sent confirmation

**ResetPasswordPage.tsx**
- New password form
- Token validation
- Success redirect

#### User Management

**UserListPage.tsx** (Admin)
- User table with search
- Status indicators
- Quick actions
- Pagination

**UserForm.tsx** (Admin)
- Create/edit user
- Role assignment
- Organization access
- Permission management

**UserProfilePage.tsx**
- User information display
- Edit profile
- Change password
- Activity history

**PermissionManager.tsx** (Admin)
- Role definitions
- Permission checkboxes
- Preview permissions
- Save changes

---

## Shared Component Library

### Core Components

**Reusable UI components for consistency:**

#### Layout

```tsx
// AppShell.tsx
interface AppShellProps {
  children: ReactNode;
  sidebar?: ReactNode;
  header?: ReactNode;
}

// Page.tsx
interface PageProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}

// Section.tsx
interface SectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}
```

#### Data Display

```tsx
// Card.tsx
interface CardProps {
  children: ReactNode;
  className?: string;
}

// Table.tsx
interface TableProps<T> {
  data: T[];
  columns: Column<T>[];
  onRowClick?: (row: T) => void;
  sortable?: boolean;
  filterable?: boolean;
}

// Badge.tsx
interface BadgeProps {
  children: ReactNode;
  variant: 'default' | 'warning' | 'success' | 'neutral' | 'error';
}

// Avatar.tsx
interface AvatarProps {
  name: string;
  imageUrl?: string;
  size?: 'sm' | 'md' | 'lg';
}
```

#### Forms

```tsx
// Input.tsx
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

// Select.tsx
interface SelectProps {
  label?: string;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

// TextArea.tsx
interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

// DatePicker.tsx
interface DatePickerProps {
  value: Date | null;
  onChange: (date: Date | null) => void;
  label?: string;
  minDate?: Date;
  maxDate?: Date;
}
```

#### Feedback

```tsx
// Modal.tsx
interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

// Alert.tsx
interface AlertProps {
  type: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  message: string;
  dismissible?: boolean;
}

// Toast.tsx
interface ToastProps {
  message: string;
  type: 'success' | 'error' | 'info';
  duration?: number;
}

// LoadingSpinner.tsx
interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  message?: string;
}
```

#### Navigation

```tsx
// Tabs.tsx
interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (tabId: string) => void;
}

// Breadcrumbs.tsx
interface BreadcrumbsProps {
  items: BreadcrumbItem[];
}

// Pagination.tsx
interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}
```

---

## State Management Strategy

### Server State (React Query)

**Query Keys Organization:**
```typescript
const queryKeys = {
  profiles: ['profiles'],
  profile: (id: string) => ['profiles', id],
  grants: ['grants'],
  grant: (id: string) => ['grants', id],
  opportunities: ['opportunities'],
  documents: (profileId: string) => ['documents', profileId],
  // etc.
};
```

**Mutations with Optimistic Updates:**
```typescript
const updateGrant = useMutation({
  mutationFn: (data) => api.updateGrant(data),
  onMutate: async (newData) => {
    // Optimistic update
    await queryClient.cancelQueries({ queryKey: queryKeys.grant(id) });
    const previousGrant = queryClient.getQueryData(queryKeys.grant(id));
    queryClient.setQueryData(queryKeys.grant(id), newData);
    return { previousGrant };
  },
  onError: (err, newData, context) => {
    // Rollback on error
    queryClient.setQueryData(queryKeys.grant(id), context.previousGrant);
  },
  onSettled: () => {
    // Refetch after mutation
    queryClient.invalidateQueries({ queryKey: queryKeys.grants });
  },
});
```

### Client State (Context)

**AuthContext:**
```typescript
interface AuthContextValue {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
  hasPermission: (permission: string) => boolean;
}
```

**ThemeContext (Future):**
```typescript
interface ThemeContextValue {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}
```

**NotificationContext:**
```typescript
interface NotificationContextValue {
  notifications: Notification[];
  unreadCount: number;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
}
```

---

## Routing Structure

### Route Organization

```
/                           → Home (marketing)
/pricing                    → Pricing
/terms                      → Terms of Service
/privacy                    → Privacy Policy
/hipaa                      → HIPAA Compliance
/data-retention             → Data Retention

/login                      → Login
/register                   → Register (future)

/dashboard                  → Dashboard (auth required)
/organizations              → Organizations list
/organizations/:id          → Organization detail
/organizations/new          → Create organization

/grants                     → Pipeline dashboard (Phase 2)
/grants/:id                 → Grant detail
/grants/new                 → Create grant

/proposals                  → Proposals list (Phase 3)
/proposals/:id              → Proposal editor
/proposals/new              → Create proposal

/analytics                  → Analytics dashboard (Phase 4)
/analytics/reports          → Custom reports
/analytics/reports/:id      → Report detail

/submissions                → Submissions list (Phase 5)
/submissions/:id            → Submission detail

/settings                   → Settings (Phase 6)
/settings/profile           → User profile
/settings/users             → User management (admin)
/settings/permissions       → Permission management (admin)
```

### Protected Routes

```tsx
<Route element={<ProtectedRoute />}>
  <Route path="/dashboard" element={<Dashboard />} />
  <Route path="/organizations" element={<Organizations />} />
  {/* ... other protected routes */}
</Route>
```

**ProtectedRoute Component:**
```tsx
function ProtectedRoute({ requiredPermission }: { requiredPermission?: string }) {
  const { isAuthenticated, hasPermission } = useAuth();
  
  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }
  
  if (requiredPermission && !hasPermission(requiredPermission)) {
    return <AccessDenied />;
  }
  
  return <Outlet />;
}
```

---

## Responsive Design Strategy

### Breakpoints (Tailwind)

```css
sm: 640px   /* Small devices */
md: 768px   /* Medium devices */
lg: 1024px  /* Large devices */
xl: 1280px  /* Extra large devices */
2xl: 1536px /* 2X large devices */
```

### Mobile-First Approach

**Base styles for mobile, progressively enhance for larger screens:**

```tsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  {/* 1 column on mobile, 2 on tablet, 3 on desktop */}
</div>

<nav className="flex flex-col md:flex-row gap-4">
  {/* Vertical on mobile, horizontal on tablet+ */}
</nav>
```

### Mobile Considerations

- Touch-friendly tap targets (min 44x44px)
- Simplified navigation on mobile
- Swipe gestures for modals/drawers
- Responsive tables (scroll or stack)
- Optimized images for mobile bandwidth

---

## Accessibility (a11y)

### Guidelines

**WCAG 2.1 AA Compliance:**
- Keyboard navigation support
- Screen reader compatibility
- Sufficient color contrast (4.5:1 for text)
- Focus indicators visible
- ARIA labels and roles
- Semantic HTML

### Implementation

**Focus Management:**
```tsx
// Trap focus in modals
import { useFocusTrap } from './hooks/useFocusTrap';

function Modal({ isOpen, onClose, children }) {
  const modalRef = useFocusTrap(isOpen);
  
  return (
    <div ref={modalRef} role="dialog" aria-modal="true">
      {children}
    </div>
  );
}
```

**Keyboard Navigation:**
```tsx
// Support Escape to close
useEffect(() => {
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };
  
  if (isOpen) {
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }
}, [isOpen, onClose]);
```

**Screen Reader Text:**
```tsx
<span className="sr-only">Close modal</span>
**Primary Colors:**
```css
--blue-50:  #eff6ff;   /* Very light blue */
--blue-100: #dbeafe;   /* Light blue */
--blue-500: #3b82f6;   /* Primary blue */
--blue-600: #2563eb;   /* Darker blue */
--blue-700: #1d4ed8;   /* Dark blue */
```

**Semantic Colors:**
```css
--success: #10b981;    /* Green - Success states */
--warning: #f59e0b;    /* Amber - Warning states */
--error:   #ef4444;    /* Red - Error states */
--info:    #3b82f6;    /* Blue - Info states */
```

**Neutral Colors:**
```css
--gray-50:  #f9fafb;   /* Background light */
--gray-100: #f3f4f6;   /* Background */
--gray-200: #e5e7eb;   /* Border */
--gray-400: #9ca3af;   /* Muted text */
--gray-600: #4b5563;   /* Secondary text */
--gray-900: #111827;   /* Primary text */
```

### Typography

**Font Family:**
- Primary: `Inter, system-ui, sans-serif`
- Monospace: `'Courier New', monospace`

**Font Sizes:**
```css
--text-xs:   0.75rem;  /* 12px - Labels, captions */
--text-sm:   0.875rem; /* 14px - Body small */
--text-base: 1rem;     /* 16px - Body text */
--text-lg:   1.125rem; /* 18px - Subheadings */
--text-xl:   1.25rem;  /* 20px - Headings */
--text-2xl:  1.5rem;   /* 24px - Page titles */
--text-3xl:  1.875rem; /* 30px - Hero text */
--text-4xl:  2.25rem;  /* 36px - Large hero */
```

**Font Weights:**
- Normal: 400
- Medium: 500
- Semibold: 600
- Bold: 700

### Spacing Scale

Using Tailwind's default spacing (0.25rem = 4px base):
- `space-1`: 4px
- `space-2`: 8px
- `space-3`: 12px
- `space-4`: 16px
- `space-6`: 24px
- `space-8`: 32px
- `space-12`: 48px
- `space-16`: 64px

### Border Radius

```css
--rounded-sm:   0.125rem; /* 2px */
--rounded:      0.25rem;  /* 4px */
--rounded-md:   0.375rem; /* 6px */
--rounded-lg:   0.5rem;   /* 8px */
--rounded-xl:   0.75rem;  /* 12px */
--rounded-2xl:  1rem;     /* 16px */
--rounded-full: 9999px;   /* Fully rounded */
```

### Shadows

```css
--shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
--shadow:    0 1px 3px 0 rgb(0 0 0 / 0.1);
--shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1);
--shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1);
--shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1);
```

---

## Component Library

### Common Components

#### Button Component
```jsx
// src/components/common/Button.jsx
export default function Button({ 
  children, 
  variant = 'primary', 
  size = 'md', 
  disabled = false,
  loading = false,
  icon = null,
  onClick,
  ...props 
}) {
  const baseClasses = 'inline-flex items-center justify-center font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2';
  
  const variants = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500',
    secondary: 'bg-gray-200 text-gray-900 hover:bg-gray-300 focus:ring-gray-500',
    outline: 'border-2 border-blue-600 text-blue-600 hover:bg-blue-50 focus:ring-blue-500',
    ghost: 'text-gray-600 hover:bg-gray-100 focus:ring-gray-500',
    danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500'
  };
  
  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-base',
    lg: 'px-6 py-3 text-lg'
  };
  
  return (
    <button
      className={`${baseClasses} ${variants[variant]} ${sizes[size]} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      disabled={disabled || loading}
      onClick={onClick}
      {...props}
    >
      {loading && <LoadingSpinner size="sm" className="mr-2" />}
      {icon && <span className="mr-2">{icon}</span>}
      {children}
    </button>
  );
}
```

#### Input Component
```jsx
// src/components/common/Input.jsx
export default function Input({
  label,
  error,
  helperText,
  type = 'text',
  icon = null,
  ...props
}) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            {icon}
          </div>
        )}
        <input
          type={type}
          className={`
            block w-full rounded-lg border 
            ${icon ? 'pl-10' : 'pl-3'} pr-3 py-2 
            ${error ? 'border-red-500 focus:ring-red-500' : 'border-gray-300 focus:ring-blue-500'}
            focus:outline-none focus:ring-2 focus:border-transparent
            disabled:bg-gray-50 disabled:text-gray-500
          `}
          {...props}
        />
      </div>
      {helperText && !error && (
        <p className="mt-1 text-sm text-gray-500">{helperText}</p>
      )}
      {error && (
        <p className="mt-1 text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}
```

#### Card Component
```jsx
// src/components/common/Card.jsx
export default function Card({ 
  children, 
  title, 
  subtitle,
  actions,
  hover = false,
  className = ''
}) {
  return (
    <div className={`
      bg-white rounded-xl shadow-md overflow-hidden
      ${hover ? 'transition-shadow hover:shadow-lg' : ''}
      ${className}
    `}>
      {(title || subtitle || actions) && (
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            {title && <h3 className="text-lg font-semibold text-gray-900">{title}</h3>}
            {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
          </div>
          {actions && <div>{actions}</div>}
        </div>
      )}
      <div className="px-6 py-4">
        {children}
      </div>
    </div>
  );
}
```

#### Badge Component
```jsx
// src/components/common/Badge.jsx
export default function Badge({ 
  children, 
  variant = 'default',
  size = 'md'
}) {
  const variants = {
    default: 'bg-gray-100 text-gray-800',
    success: 'bg-green-100 text-green-800',
    warning: 'bg-yellow-100 text-yellow-800',
    error: 'bg-red-100 text-red-800',
    info: 'bg-blue-100 text-blue-800'
  };
  
  const sizes = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-2.5 py-1 text-sm',
    lg: 'px-3 py-1.5 text-base'
  };
  
  return (
    <span className={`inline-flex items-center font-medium rounded-full ${variants[variant]} ${sizes[size]}`}>
      {children}
    </span>
  );
}
```

### Grant-Specific Components

#### GrantCard Component
```jsx
// src/components/grants/GrantCard.jsx
export default function GrantCard({ grant, onBookmark, onView }) {
  return (
    <Card hover className="h-full">
      <div className="flex flex-col h-full">
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900 line-clamp-2">
            {grant.title}
          </h3>
          <button onClick={() => onBookmark(grant.id)}>
            <BookmarkIcon className={grant.bookmarked ? 'fill-blue-600' : ''} />
          </button>
        </div>
        
        <p className="text-sm text-gray-600 line-clamp-3 mb-4">
          {grant.description}
        </p>
        
        <div className="mt-auto">
          <div className="flex flex-wrap gap-2 mb-4">
            <Badge variant="info">{grant.category}</Badge>
            {grant.amount && (
              <Badge variant="success">
                {formatCurrency(grant.amount)}
              </Badge>
            )}
          </div>
          
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">
              Due: {formatDate(grant.deadline)}
            </span>
            <Button size="sm" onClick={() => onView(grant.id)}>
              View Details
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
```

#### GrantFilters Component
```jsx
// src/components/grants/GrantFilters.jsx
export default function GrantFilters({ filters, onFilterChange }) {
  return (
    <aside className="w-64 bg-white rounded-xl shadow-md p-6">
      <h2 className="text-lg font-semibold mb-4">Filters</h2>
      
      {/* Amount Range */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Award Amount
        </label>
        <Input
          type="number"
          placeholder="Min amount"
          value={filters.minAmount}
          onChange={(e) => onFilterChange('minAmount', e.target.value)}
        />
        <Input
          type="number"
          placeholder="Max amount"
          value={filters.maxAmount}
          onChange={(e) => onFilterChange('maxAmount', e.target.value)}
          className="mt-2"
        />
      </div>
      
      {/* Category */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Category
        </label>
        <select
          value={filters.category}
          onChange={(e) => onFilterChange('category', e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2"
        >
          <option value="">All Categories</option>
          <option value="education">Education</option>
          <option value="healthcare">Healthcare</option>
          <option value="business">Business</option>
          <option value="housing">Housing</option>
        </select>
      </div>
      
      {/* Location */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Location
        </label>
        <Input
          placeholder="State or City"
          value={filters.location}
          onChange={(e) => onFilterChange('location', e.target.value)}
        />
      </div>
      
      <Button variant="outline" className="w-full" onClick={() => onFilterChange('reset')}>
        Clear Filters
      </Button>
    </aside>
  );
}
```

---

## Page Structure

### HomePage
```jsx
// src/pages/HomePage.jsx
export default function HomePage() {
  return (
    <>
      {/* Hero Section */}
      <section className="bg-gradient-to-r from-blue-600 to-blue-800 text-white py-20">
        <div className="container mx-auto px-4">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            Find Funding for Your Dreams
          </h1>
          <p className="text-xl mb-8">
            AI-powered grant discovery and application assistance
          </p>
          <Button size="lg">Get Started Free</Button>
        </div>
      </section>
      
      {/* Features Section */}
      <section className="py-16">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-12">
            How GrantFlow Helps You
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard
              icon={<SearchIcon />}
              title="Discover Grants"
              description="Search thousands of grants tailored to your needs"
            />
            <FeatureCard
              icon={<BotIcon />}
              title="AI Assistant"
              description="ANYA helps you find and apply for the best grants"
            />
            <FeatureCard
              icon={<CheckIcon />}
              title="Track Applications"
              description="Manage your grant applications in one place"
            />
          </div>
        </div>
      </section>
      
      {/* CTA Section */}
      <section className="bg-blue-50 py-16">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold mb-4">
            Ready to Find Your Funding?
          </h2>
          <Button size="lg">Start Your Free Trial</Button>
        </div>
      </section>
    </>
  );
}
```

### Dashboard
```jsx
// src/pages/Dashboard.jsx
export default function Dashboard() {
  const { data: stats } = useQuery('dashboard-stats', fetchDashboardStats);
  
  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-8">Dashboard</h1>
      
      {/* Stats Grid */}
      <div className="grid md:grid-cols-4 gap-6 mb-8">
        <StatCard label="Saved Grants" value={stats?.savedGrants || 0} />
        <StatCard label="Applications" value={stats?.applications || 0} />
        <StatCard label="Awarded" value={formatCurrency(stats?.totalAwarded || 0)} />
        <StatCard label="Upcoming Deadlines" value={stats?.upcomingDeadlines || 0} />
      </div>
      
      {/* Main Content Grid */}
      <div className="grid lg:grid-cols-3 gap-8">
        {/* Left Column - 2/3 width */}
        <div className="lg:col-span-2 space-y-8">
          <Card title="Recommended Grants">
            <GrantList grants={recommendedGrants} />
          </Card>
          
          <Card title="Recent Activity">
            <ActivityTimeline activities={recentActivity} />
          </Card>
        </div>
        
        {/* Right Column - 1/3 width */}
        <div className="space-y-8">
          <Card title="Upcoming Deadlines">
            <DeadlineList deadlines={upcomingDeadlines} />
          </Card>
          
          <Card title="Quick Actions">
            <div className="space-y-2">
              <Button variant="outline" className="w-full">
                Search Grants
              </Button>
              <Button variant="outline" className="w-full">
                Upload Document
              </Button>
              <Button variant="outline" className="w-full">
                Chat with ANYA
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
```

---

## State Management

### Authentication Context
```jsx
// src/contexts/AuthContext.jsx
const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    // Check for existing session
    checkAuth();
  }, []);
  
  async function checkAuth() {
    try {
      const response = await api.get('/api/auth/me');
      setUser(response.data);
    } catch (error) {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }
  
  async function login(email, password) {
    const response = await api.post('/api/auth/login', { email, password });
    setUser(response.data.user);
    return response.data;
  }
  
  async function logout() {
    await api.post('/api/auth/logout');
    setUser(null);
  }
  
  return (
    <AuthContext.Provider value={{ user, loading, login, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
```

### TanStack Query Setup
```jsx
// src/main.jsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5 * 60 * 1000, // 5 minutes
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
```

---

## Routing Strategy

```jsx
// src/App.jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

function App() {
  return (
    <BrowserRouter basename="/grantflow">
      <Routes>
        {/* Public Routes */}
        <Route path="/" element={<HomePage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        
        {/* Protected Routes */}
        <Route element={<ProtectedRoute />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/grants" element={<GrantSearchPage />} />
          <Route path="/grants/:id" element={<GrantDetailPage />} />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/applications/:id" element={<ApplicationDetailPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        
        {/* 404 */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
```

---

## Data Fetching

### Custom Hooks with TanStack Query
```jsx
// src/hooks/useGrants.js
export function useGrants(filters) {
  return useQuery(
    ['grants', filters],
    () => api.getGrants(filters),
    {
      enabled: !!filters,
      keepPreviousData: true,
    }
  );
}

export function useGrant(id) {
  return useQuery(
    ['grants', id],
    () => api.getGrant(id),
    {
      enabled: !!id,
    }
  );
}

export function useBookmarkGrant() {
  const queryClient = useQueryClient();
  
  return useMutation(
    (grantId) => api.bookmarkGrant(grantId),
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['grants']);
        queryClient.invalidateQueries(['bookmarks']);
      },
    }
  );
}
```

---

## Performance Optimization

### Code Splitting

**Route-based splitting:**
```tsx
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Organizations = lazy(() => import('./pages/Organizations'));

<Suspense fallback={<LoadingSpinner />}>
  <Routes>
    <Route path="/dashboard" element={<Dashboard />} />
    <Route path="/organizations" element={<Organizations />} />
  </Routes>
</Suspense>
```

### Image Optimization

- Lazy loading with `loading="lazy"`
- Responsive images with `srcset`
- WebP format with fallbacks
- Optimize file sizes

### Memoization

```tsx
const memoizedValue = useMemo(() => expensiveCalculation(data), [data]);

const MemoizedComponent = memo(Component, (prevProps, nextProps) => {
  return prevProps.id === nextProps.id;
});
```

### Virtual Scrolling

For large lists (e.g., thousands of grants):
- React Virtual or Tanstack Virtual
- Only render visible items
- Smooth scrolling performance

---

## Testing Strategy

### Unit Tests

**Component Testing (React Testing Library):**
```tsx
import { render, screen } from '@testing-library/react';
import { GrantCard } from './GrantCard';

test('renders grant information', () => {
  const grant = { name: 'Test Grant', amount: '$50,000' };
  render(<GrantCard grant={grant} />);
  
  expect(screen.getByText('Test Grant')).toBeInTheDocument();
  expect(screen.getByText('$50,000')).toBeInTheDocument();
});
```

### Integration Tests

**Page-level testing:**
```tsx
test('dashboard displays grants', async () => {
  render(<Dashboard />);
  
  await waitFor(() => {
    expect(screen.getByText('Grant Operations Dashboard')).toBeInTheDocument();
  });
});
```

### End-to-End Tests

**Critical workflows (Playwright):**
- User login
- Create organization
- Create grant
- Move grant through pipeline
- Generate proposal
- Submit grant

---

## Design Alignment with Base44

### UX Principles

Based on the Base44 reference implementation:

1. **Clarity** - Clear information hierarchy
2. **Efficiency** - Minimize clicks to complete tasks
3. **Consistency** - Reusable patterns across features
4. **Feedback** - Immediate response to user actions
5. **Accessibility** - Usable by everyone

### Visual Consistency

- Professional, clean design
- Adequate whitespace
- Consistent spacing and sizing
- Clear typography hierarchy
- Intuitive iconography

### Interaction Patterns

- Optimistic UI updates
- Loading states for async operations
- Error boundaries for graceful failures
- Confirmation dialogs for destructive actions
- Keyboard shortcuts for power users

---

## Component Reusability Strategy

### Composition over Inheritance

**Build complex components from simple ones:**

```tsx
// Simple components
<Button />
<Card />
<Badge />

// Composed component
<GrantCard>
  <CardHeader>
    <Badge />
  </CardHeader>
  <CardContent>
    {/* Grant info */}
  </CardContent>
  <CardFooter>
    <Button />
  </CardFooter>
</GrantCard>
```

### Render Props Pattern

**Flexible, reusable components:**

```tsx
<DataTable
  data={grants}
  renderRow={(grant) => (
    <GrantRow grant={grant} />
  )}
/>
```

### Custom Hooks

**Share logic across components:**

```tsx
// useGrants.ts
export function useGrants() {
  const { data, isLoading } = useQuery(queryKeys.grants, fetchGrants);
  
  return {
    grants: data ?? [],
    isLoading,
  };
}

// In component
const { grants, isLoading } = useGrants();
```

---

## Documentation Standards

### Component Documentation

**JSDoc comments:**
```tsx
/**
 * GrantCard displays summary information for a grant in the pipeline.
 * 
 * @param grant - Grant object with name, amount, deadline
 * @param onMove - Callback when grant is moved to new stage
 * @param onClick - Callback when card is clicked
 */
interface GrantCardProps {
  grant: Grant;
  onMove: (newStatus: GrantStatus) => void;
  onClick: () => void;
}
```

### Storybook (Future)

- Visual component documentation
- Interactive examples
- Props playground
- Design system reference

---

## Migration Path

### From Marketing Site to Full Application

**Strategy:**
1. Keep existing marketing pages
2. Add application pages alongside
3. Conditionally show navigation based on auth state
4. Marketing nav for unauthenticated
5. Application nav for authenticated users

**Dual Navigation:**
```tsx
function Navigation() {
  const { isAuthenticated } = useAuth();
  
  return isAuthenticated ? <AppNav /> : <MarketingNav />;
}
```

---

## Future Enhancements

### Dark Mode

- Theme toggle in settings
- Persist preference in localStorage
- CSS variables for theme colors
- Respect system preference

### Offline Support

- Service Worker for offline functionality
- Local storage for cached data
- Sync when connection restored
- Offline indicator

### Real-time Updates

- WebSocket connection for live updates
- Optimistic UI with server reconciliation
- Presence indicators (who's online)
- Collaborative editing (Phase 3)

### Animations

- Smooth transitions (Framer Motion)
- Page transitions
- Loading animations
- Micro-interactions

---

## Conclusion

This UI architecture provides a solid foundation for building a full-featured grant management application with feature parity to the Base44 reference implementation. The component-based approach ensures consistency, reusability, and maintainability as new features are added.
```jsx
// Lazy load pages
const Dashboard = lazy(() => import('./pages/Dashboard'));
const GrantSearchPage = lazy(() => import('./pages/GrantSearchPage'));

// Use with Suspense
<Suspense fallback={<LoadingSpinner />}>
  <Dashboard />
</Suspense>
```

### Memoization
```jsx
// Expensive component
const ExpensiveComponent = memo(function ExpensiveComponent({ data }) {
  // Complex rendering logic
});

// Expensive calculation
const expensiveValue = useMemo(() => {
  return complexCalculation(data);
}, [data]);
```

### Virtual Scrolling
```jsx
// For long lists of grants
import { useVirtualizer } from '@tanstack/react-virtual';

function GrantList({ grants }) {
  const parentRef = useRef();
  
  const virtualizer = useVirtualizer({
    count: grants.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 200,
  });
  
  // Render only visible items
}
```

---

## Accessibility

### ARIA Labels
```jsx
<button aria-label="Bookmark this grant">
  <BookmarkIcon />
</button>

<input aria-describedby="email-help" />
<p id="email-help">We'll never share your email</p>
```

### Keyboard Navigation
```jsx
// Add keyboard handlers
<div
  role="button"
  tabIndex={0}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      handleClick();
    }
  }}
>
  Click me
</div>
```

### Focus Management
```jsx
// Trap focus in modals
import { useFocusTrap } from '@/hooks/useFocusTrap';

function Modal({ isOpen, onClose }) {
  const modalRef = useFocusTrap(isOpen);
  
  return (
    <div ref={modalRef} role="dialog" aria-modal="true">
      {/* Modal content */}
    </div>
  );
}
```

---

## Testing Strategy

### Component Tests
```jsx
// Button.test.jsx
import { render, screen, fireEvent } from '@testing-library/react';
import Button from './Button';

test('renders button with text', () => {
  render(<Button>Click me</Button>);
  expect(screen.getByText('Click me')).toBeInTheDocument();
});

test('calls onClick when clicked', () => {
  const handleClick = jest.fn();
  render(<Button onClick={handleClick}>Click me</Button>);
  fireEvent.click(screen.getByText('Click me'));
  expect(handleClick).toHaveBeenCalledTimes(1);
});
```

### Integration Tests
```jsx
// GrantSearch.test.jsx
test('search and filter grants', async () => {
  render(<GrantSearchPage />);
  
  // Enter search query
  const searchInput = screen.getByPlaceholderText('Search grants...');
  fireEvent.change(searchInput, { target: { value: 'education' } });
  
  // Wait for results
  await waitFor(() => {
    expect(screen.getByText('Education Grant')).toBeInTheDocument();
  });
});
```

---

## Implementation Guidelines

1. **Component Organization**: One component per file, named exports for utilities
2. **Props Validation**: Use TypeScript or PropTypes for all components
3. **Consistent Naming**: PascalCase for components, camelCase for functions
4. **CSS Classes**: Use Tailwind utility classes, avoid custom CSS when possible
5. **Error Boundaries**: Wrap major sections in error boundaries
6. **Loading States**: Always show loading indicators during async operations
7. **Empty States**: Provide helpful empty states with CTAs
8. **Mobile First**: Design for mobile, enhance for desktop
9. **Performance**: Monitor bundle size, lazy load heavy components
10. **Accessibility**: Test with screen readers and keyboard navigation

---

## Next Steps

1. Set up component library with Storybook (optional)
2. Create design tokens file for consistent theming
3. Implement base components (Button, Input, Card, Badge)
4. Build layout components (Header, Footer, Sidebar)
5. Create page templates following this architecture
6. Set up routing and state management
7. Implement data fetching hooks
8. Add accessibility features
9. Write component tests
10. Document component usage

---

## References

- [Feature Parity Analysis](./FEATURE_PARITY.md)
- [Development Roadmap](./DEVELOPMENT_ROADMAP.md)
- [Backend Documentation](../backend/README.md)
- [Main README](../README.md)
- [React Documentation](https://react.dev/)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [TanStack Query Documentation](https://tanstack.com/query/latest)
- [React Router Documentation](https://reactrouter.com/)
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
