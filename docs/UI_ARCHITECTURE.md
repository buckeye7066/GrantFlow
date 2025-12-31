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

---

## References

- [Feature Parity Analysis](./FEATURE_PARITY.md)
- [Development Roadmap](./DEVELOPMENT_ROADMAP.md)
- [Backend Documentation](../backend/README.md)
- [Main README](../README.md)
