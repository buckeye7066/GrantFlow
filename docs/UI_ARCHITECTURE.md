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

- [React Documentation](https://react.dev/)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [TanStack Query Documentation](https://tanstack.com/query/latest)
- [React Router Documentation](https://reactrouter.com/)
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
