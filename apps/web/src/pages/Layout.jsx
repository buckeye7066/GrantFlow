
/**
 * SYSTEM DIRECTIVE - MANDATORY COMPLIANCE
 * 
 * Before responding to ANY request:
 * 1. READ THE ACTUAL REQUEST - What did the user literally ask for? Do exactly that. Nothing more, nothing less.
 * 2. NO EXCUSES - Don't explain why something can't be done. Find a way or ask a clarifying question.
 * 3. NO SUGGESTIONS INSTEAD OF ACTION - If asked to do X, do X. Don't suggest alternatives unless X is truly impossible.
 * 4. READ YOUR OWN CODE - Before claiming something works, trace through the logic. Find bugs yourself.
 * 5. ONE RESPONSE, COMPLETE - Don't make the user ask twice. Get it done the first time.
 * 6. NO FILLER - Skip the "Great question!" and "I'd be happy to help!" Just do the work.
 * 7. VERIFY BEFORE RESPONDING - Did you actually do what was asked? Re-read the request before hitting send.
 * 
 * VIOLATION = FAILURE
 */

import React, { useState, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import CrossPlatformInit from "@/components/shared/CrossPlatformInit";
import { safeLoginRedirect, isInAppBrowser } from "@/components/shared/safeNavigate";
import { isClientUser, ADMIN_ONLY_PAGES, getClientPrimaryOrganization } from "@/components/shared/clientUserUtils";
import { ThemeSettingsProvider } from "@/components/theme/ThemeSettingsProvider";

// Owner email for global access bypass
export const OWNER_EMAIL = 'buckeye7066@gmail.com';

// Special client emails with personalized welcome
export const SPECIAL_CLIENTS = {
  'avenell@example.com': { name: 'Avenell', welcomeMessage: 'Thank you for using GrantFlow! We appreciate your trust in our service.' }
};

// Add Avenell's actual email here when known
const AVENELL_EMAILS = ['avenell@example.com']; // Update with her real email

// MAINTENANCE MODE - Only owner can access (disabled)
const MAINTENANCE_MODE = false;

/**
 * PWA & Cross-Platform Head Tags Component
 * Injects meta tags for PWA support, iOS standalone, and in-app browser compatibility
 */
function PWAHeadTags() {
  useEffect(() => {
    // Only run once on mount
    const head = document.head;
    
    // Helper to add meta tag if not exists
    const addMeta = (name, content, httpEquiv = false) => {
      const attr = httpEquiv ? 'http-equiv' : 'name';
      if (!head.querySelector(`meta[${attr}="${name}"]`)) {
        const meta = document.createElement('meta');
        meta[httpEquiv ? 'httpEquiv' : 'name'] = name;
        meta.content = content;
        head.appendChild(meta);
      }
    };
    
    // Helper to add link tag if not exists
    const addLink = (rel, href, attrs = {}) => {
      if (!head.querySelector(`link[rel="${rel}"][href="${href}"]`)) {
        const link = document.createElement('link');
        link.rel = rel;
        link.href = href;
        Object.entries(attrs).forEach(([k, v]) => link.setAttribute(k, v));
        head.appendChild(link);
      }
    };

    // PWA manifest
    addLink('manifest', '/manifest.json');
    
    // Theme color
    addMeta('theme-color', '#1e3a8a');
    
    // iOS PWA support
    addMeta('apple-mobile-web-app-capable', 'yes');
    addMeta('apple-mobile-web-app-status-bar-style', 'default');
    addMeta('apple-mobile-web-app-title', 'GrantFlow');
    addLink('apple-touch-icon', '/icons/icon-192.png');
    
    // Disable automatic phone-number linking
    addMeta('format-detection', 'telephone=no');
    
    // Security policy for embedded browsers
    addMeta('Content-Security-Policy', 'upgrade-insecure-requests', true);
    
    // Referrer policy for Messenger/IG/Facebook
    addMeta('referrer', 'no-referrer-when-downgrade');
    
    // Mobile viewport optimization
    if (!head.querySelector('meta[name="viewport"]')) {
      addMeta('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    }
    
  }, []);
  
  return null;
}

/**
 * Check if user is the owner with full access
 * @param {object} user - User object with email property
 * @returns {boolean}
 */
export const isOwner = (user) => 
  user?.email === OWNER_EMAIL || user?.role === 'admin';
import {
  LayoutDashboard,
  Building2,
  Search,
  Kanban,
  FileText,
  DollarSign,
  FolderOpen,
  Calendar,
  BarChart3,
  LogOut,
  Brain,
  FileStack,
  Database,
  DatabaseZap,
  ShieldCheck,
  Beaker,
  Target,
  Users,
  Layers,
  Package,
  Menu,
  X,
  Zap,
  Mail,
  Activity,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import AutoTimeTracker from "@/components/billing/AutoTimeTracker";
import AppErrorBoundary from "@/components/common/AppErrorBoundary";
import TierSimulator from "@/components/billing/TierSimulator";
import ActivityTracker from "@/components/shared/ActivityTracker";
import ImmuneActivityIndicator from "@/components/immune/ImmuneActivityIndicator";
import OnboardingManager from "@/components/onboarding/OnboardingManager";
import OnboardingMenuButton from "@/components/onboarding/OnboardingMenuButton";
import WelcomeMessageHandler from "@/components/welcome/WelcomeMessageHandler";
import ThemeCustomizerPanel from "@/components/theme/ThemeCustomizerPanel";
import { Loader2 } from "lucide-react";

const createPageUrl = (pageName) => {
  if (!pageName) return '/';
  const cleanPageName = pageName.replace(/^\/+|\/+$/g, '');
  return `/${cleanPageName.toLowerCase()}`;
};

const getUserInitials = (fullName) => {
  if (!fullName) return 'U';
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

export default function Layout({ children, currentPageName }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const isPublicPage = location.pathname.toLowerCase().startsWith('/publicapplication');
  
  // Check if user is client_user and redirect from admin pages
  const checkClientAccess = (user) => {
    if (!user) return;
    if (isClientUser(user) && ADMIN_ONLY_PAGES.includes(currentPageName)) {
      const primaryOrgId = getClientPrimaryOrganization(user);
      if (primaryOrgId) {
        navigate(`/organizationprofile?id=${primaryOrgId}`);
      } else {
        navigate('/organizations');
      }
    }
  };

  const { data: user, isLoading: isLoadingUser, error: userError } = useQuery({
    queryKey: ['currentUser'],
    queryFn: async () => {
      try {
        return await base44.auth.me();
      } catch (error) {
        console.error('[Layout] Auth error:', error);
        return null;
      }
    },
    retry: false,
  });

  console.log('[Layout] User data:', { user, isLoadingUser, userError, currentPageName });
  
  // Redirect client users from admin pages
  useEffect(() => {
    if (user && !isLoadingUser) {
      checkClientAccess(user);
    }
  }, [user, isLoadingUser, currentPageName]);

  // Loading state
  if (isLoadingUser) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-slate-600">Loading...</p>
        </div>
      </div>
    );
  }

  // MAINTENANCE MODE BLOCK
      if (MAINTENANCE_MODE && user?.email !== OWNER_EMAIL) {
        return (
          <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800">
            <CrossPlatformInit />
            <div className="text-center max-w-lg px-6">
              <div className="bg-amber-500/20 border-2 border-amber-500 rounded-2xl p-8 backdrop-blur-sm">
                <div className="w-20 h-20 bg-amber-500 rounded-full flex items-center justify-center mx-auto mb-6">
                  <Loader2 className="w-10 h-10 text-white animate-spin" />
                </div>
                <h1 className="text-3xl font-bold text-white mb-4">System Maintenance</h1>
                <p className="text-amber-100 text-lg mb-6">
                  GrantFlow is currently undergoing scheduled maintenance to improve your experience.
                </p>
                <p className="text-amber-200/80 text-sm">
                  We apologize for the inconvenience. Please check back shortly.
                </p>
                <div className="mt-8 pt-6 border-t border-amber-500/30">
                  <p className="text-amber-300/60 text-xs">
                    Expected completion: Within the next few hours
                  </p>
                </div>
              </div>
            </div>
          </div>
        );
      }

      // Not authenticated - redirect to login
      if (userError || !user) {
    // Handle login for in-app browsers (Messenger, Instagram, etc.)
    const handleLogin = () => {
      safeLoginRedirect(() => base44.auth.redirectToLogin());
    };

    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <CrossPlatformInit />
        <div className="text-center max-w-md">
          <div className="bg-white p-8 rounded-lg shadow-lg">
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <LogOut className="w-8 h-8 text-blue-600" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Sign In Required</h1>
            <p className="text-slate-600 mb-6">
              Please sign in to access the application.
            </p>
            {isInAppBrowser() && (
              <p className="text-xs text-amber-600 mb-4">
                For best experience, open in Safari or Chrome
              </p>
            )}
            <Button onClick={handleLogin} className="w-full">
              Sign In
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const handleLogout = () => {
    base44.auth.logout();
  };

  const userInitials = getUserInitials(user?.full_name);
  const displayName = user?.full_name || 'User';
  const displayEmail = user?.email || 'Loading...';

  const getNavLinkClass = (pageName) => {
    const baseClasses = "flex items-center gap-3 px-4 py-2 rounded-lg text-slate-700 hover:bg-blue-50 hover:text-blue-700 transition-colors";
    const activeClasses = "bg-blue-600 text-white hover:bg-blue-700 shadow-md";
    return currentPageName === pageName ? `${baseClasses} ${activeClasses}` : baseClasses;
  };

  // For public pages - simple layout
  if (isPublicPage) {
    console.log('[Layout] Rendering public page layout');
    return (
      <AppErrorBoundary>
        <PWAHeadTags />
        <CrossPlatformInit />
        <div className="min-h-screen bg-slate-50">
          {children}
        </div>
      </AppErrorBoundary>
    );
  }



  console.log('[Layout] Rendering admin layout for:', currentPageName);

  // Check if user is client_user for conditional nav rendering
  const isClient = isClientUser(user);
  const isAdmin = user?.role === 'admin' || user?.email === OWNER_EMAIL;

  // Render admin layout for all users
  return (
            <ThemeSettingsProvider>
            <AppErrorBoundary>
                <PWAHeadTags />
                <CrossPlatformInit />
                <ActivityTracker user={user} currentPageName={currentPageName} />
                <OnboardingManager user={user}>
                <WelcomeMessageHandler user={user} />
                <div className="min-h-screen bg-slate-50" style={{ minHeight: '100vh' }}>
        <header className="bg-white border-b border-slate-200 sticky top-0 z-50 shadow-sm">
          <div className="flex items-center justify-between h-16 px-4 lg:px-6">
            <div className="flex items-center gap-4">
              <button
                onClick={() => setIsSidebarOpen(true)}
                className="lg:hidden p-2 -ml-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                aria-label="Open sidebar"
              >
                <Menu className="w-6 h-6" />
              </button>
              <Link to={createPageUrl("Dashboard")} className="flex items-center gap-2" aria-label="Go to Dashboard">
                <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-blue-800 rounded-lg flex items-center justify-center shadow-lg">
                  <FileText className="w-5 h-5 text-white" />
                </div>
                <h1 className="font-bold text-slate-900 text-xl hidden md:block">GrantFlow</h1>
              </Link>
            </div>

            <div className="flex items-center gap-3">
                                {isAdmin && <ImmuneActivityIndicator />}
                                <ThemeCustomizerPanel />
                                <OnboardingMenuButton />
                                 <div className="flex-1 min-w-0 hidden md:block">
                                    <p className={`font-medium text-slate-900 text-sm truncate ${isLoadingUser ? 'animate-pulse' : ''}`}>
                                      {displayName}
                                    </p>
                                    <p className={`text-xs text-slate-500 truncate ${isLoadingUser ? 'animate-pulse' : ''}`}>
                                      {displayEmail}
                                    </p>
                                  </div>
                <div
                  className="w-9 h-9 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-full flex items-center justify-center flex-shrink-0"
                  aria-hidden="true"
                >
                  <span className="text-white font-semibold text-sm">
                    {userInitials}
                  </span>
                </div>
                <button
                  onClick={handleLogout}
                  className="p-2 hover:bg-slate-100 rounded-lg transition-colors flex-shrink-0"
                  title="Logout"
                  aria-label="Logout from GrantFlow"
                >
                  <LogOut className="w-5 h-5 text-slate-600" aria-hidden="true" />
                </button>
            </div>
          </div>
        </header>

        <div className="flex">
          <aside className={`${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 fixed lg:static inset-y-0 left-0 z-40 w-64 bg-white border-r border-slate-200 transition-transform duration-200 ease-in-out mt-16 lg:mt-0`}>
            <div className="flex items-center justify-between h-16 px-4 border-b border-slate-200 lg:hidden">
              <Link to={createPageUrl("Dashboard")} className="flex items-center gap-2" aria-label="Go to Dashboard">
                <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-blue-800 rounded-lg flex items-center justify-center shadow-lg">
                  <FileText className="w-5 h-5 text-white" />
                </div>
                <h2 className="font-bold text-slate-900 text-xl">GrantFlow</h2>
              </Link>
              <button
                onClick={() => setIsSidebarOpen(false)}
                className="p-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                aria-label="Close sidebar"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <nav className="p-4 space-y-1 h-full overflow-y-auto">
              <div className="pb-4">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 py-2">
                  {isClient ? 'My Portal' : 'Navigation'}
                </h3>
              </div>

              {/* CLIENT USER NAVIGATION - Simplified portal */}
              {isClient && (
                <>
                  <Link
                    to={createPageUrl("Dashboard")}
                    className={getNavLinkClass('Dashboard')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <LayoutDashboard className="w-5 h-5" />
                    <span>My Dashboard</span>
                  </Link>

                  <Link
                    to={createPageUrl('Organizations')}
                    className={getNavLinkClass('Organizations')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Users className="w-5 h-5" />
                    <span>My Profile</span>
                  </Link>

                  <Link
                    to={createPageUrl('Pipeline')}
                    className={getNavLinkClass('Pipeline')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Layers className="w-5 h-5" />
                    <span>My Grants</span>
                  </Link>

                  <Link
                    to={createPageUrl('Documents')}
                    className={getNavLinkClass('Documents')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <FileText className="w-5 h-5" />
                    <span>My Documents</span>
                  </Link>

                  <Link
                    to={createPageUrl('Billing')}
                    className={getNavLinkClass('Billing')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <DollarSign className="w-5 h-5" />
                    <span>Services & Billing</span>
                  </Link>

                  <Link
                    to={createPageUrl('SendMessage')}
                    className={getNavLinkClass('SendMessage')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Mail className="w-5 h-5" />
                    <span>Contact Admin</span>
                  </Link>

                  <div className="mt-4 pt-4 border-t border-slate-100 text-xs text-center text-slate-400">
                    Client Portal • v2.0
                  </div>
                </>
              )}

              {/* ADMIN/REGULAR USER NAVIGATION - Full access */}
              {!isClient && (
                <>
                  <Link
                    to={createPageUrl("Dashboard")}
                    className={getNavLinkClass('Dashboard')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <LayoutDashboard className="w-5 h-5" />
                    <span>Dashboard</span>
                  </Link>

                  <Link
                    to={createPageUrl('Organizations')}
                    className={getNavLinkClass('Organizations')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Users className="w-5 h-5" />
                    <span>Organizations</span>
                  </Link>

                  <Link
                    to={createPageUrl('Funders')}
                    className={getNavLinkClass('Funders')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Building2 className="w-5 h-5" />
                    <span>Funders</span>
                  </Link>

                  <Link
                    to={createPageUrl('DiscoverGrants')}
                    className={getNavLinkClass('DiscoverGrants')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Search className="w-5 h-5" />
                    <span>Discover Grants</span>
                  </Link>

                  <Link
                    to={createPageUrl('GrantReporting')}
                    className={getNavLinkClass('GrantReporting')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <FileText className="w-5 h-5" />
                    <span>Grant Reporting</span>
                  </Link>

                  <Link
                    to={createPageUrl('SmartMatcher')}
                    className={getNavLinkClass('SmartMatcher')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Brain className="w-5 h-5" />
                    <span>Smart Matcher</span>
                  </Link>

                  <Link
                    to={createPageUrl('ItemSearch')}
                    className={getNavLinkClass('ItemSearch')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Package className="w-5 h-5" />
                    <span>Item Funding</span>
                  </Link>

                  <Link
                    to={createPageUrl('ProfileMatcher')}
                    className={getNavLinkClass('ProfileMatcher')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Target className="w-5 h-5" />
                    <span>Profile Matcher</span>
                  </Link>

                  <Link
                    to={createPageUrl('Pipeline')}
                    className={getNavLinkClass('Pipeline')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Layers className="w-5 h-5" />
                    <span>Pipeline</span>
                  </Link>

                  <Link
                    to={createPageUrl('SendMessage')}
                    className={getNavLinkClass('SendMessage')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Mail className="w-5 h-5" />
                    <span>Contact Admin</span>
                  </Link>

                  <Link
                    to={createPageUrl('OutreachCampaigns')}
                    className={getNavLinkClass('OutreachCampaigns')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Mail className="w-5 h-5" />
                    <span>Outreach</span>
                  </Link>

                  <Link
                    to={createPageUrl('GrantDeadlines')}
                    className={getNavLinkClass('GrantDeadlines')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Calendar className="w-5 h-5" />
                    <span>Grant Deadlines</span>
                  </Link>

                  <Link
                    to={createPageUrl('GrantMonitoring')}
                    className={getNavLinkClass('GrantMonitoring')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <BarChart3 className="w-5 h-5" />
                    <span>Grant Monitoring</span>
                  </Link>

                  <Link
                    to={createPageUrl('Proposals')}
                    className={getNavLinkClass('Proposals')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <FileText className="w-5 h-5" />
                    <span>Proposals</span>
                  </Link>

                  <Link
                    to={createPageUrl('Stewardship')}
                    className={getNavLinkClass('Stewardship')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <ShieldCheck className="w-5 h-5" />
                    <span>Stewardship</span>
                  </Link>

                  <Link
                    to={createPageUrl('Reports')}
                    className={getNavLinkClass('Reports')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <BarChart3 className="w-5 h-5" />
                    <span>Reports & Analytics</span>
                  </Link>

                  <Link
                    to={createPageUrl('AdvancedAnalytics')}
                    className={getNavLinkClass('AdvancedAnalytics')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <BarChart3 className="w-5 h-5" />
                    <span>Advanced Analytics</span>
                  </Link>

                  <Link
                    to={createPageUrl('AutomationSettings')}
                    className={getNavLinkClass('AutomationSettings')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Zap className="w-5 h-5" />
                    <span>Automation</span>
                  </Link>

                  <Link
                    to={createPageUrl('PrintableApplication')}
                    className={getNavLinkClass('PrintableApplication')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <FileText className="w-5 h-5" />
                    <span>Printable Application</span>
                  </Link>

                  <Link
                    to={createPageUrl('AIGrantScorer')}
                    className={getNavLinkClass('AIGrantScorer')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Brain className="w-5 h-5" />
                    <span>AI Grant Scorer</span>
                  </Link>

                  <Link
                    to={createPageUrl('NOFOParser')}
                    className={getNavLinkClass('NOFOParser')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <FileStack className="w-5 h-5" />
                    <span>NOFO Parser</span>
                  </Link>

                  <Link
                    to={createPageUrl('DataSources')}
                    className={getNavLinkClass('DataSources')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Database className="w-5 h-5" />
                    <span>Data Sources</span>
                  </Link>

                  <Link
                    to={createPageUrl('SourceDirectory')}
                    className={getNavLinkClass('SourceDirectory')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <DatabaseZap className="w-5 h-5" />
                    <span>Source Directory</span>
                  </Link>

                  <Link
                    to={createPageUrl('FundingOpportunities')}
                    className={getNavLinkClass('FundingOpportunities')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Database className="w-5 h-5" />
                    <span>Funding Opportunities</span>
                  </Link>

                  <div className="pt-4 mt-4 border-t border-slate-100">
                    <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 py-2">
                      Developer
                    </h3>
                    <div className="px-3 py-2">
                      <TierSimulator />
                    </div>
                  </div>
                  <Link
                    to={createPageUrl('UserManagement')}
                    className={getNavLinkClass('UserManagement')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Users className="w-5 h-5" />
                    <span>User Management</span>
                  </Link>
                  <Link
                    to={createPageUrl('UserAnalytics')}
                    className={getNavLinkClass('UserAnalytics')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Activity className="w-5 h-5" />
                    <span>User Analytics</span>
                  </Link>
                  <Link
                    to={createPageUrl('AdminMessages')}
                    className={getNavLinkClass('AdminMessages')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Mail className="w-5 h-5" />
                    <span>Admin Messages</span>
                  </Link>
                  <Link
                    to={createPageUrl('Landing')}
                    className={getNavLinkClass('Landing')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <FileText className="w-5 h-5" />
                    <span>Landing Page</span>
                  </Link>
                  <Link
                    to={createPageUrl('Billing')}
                    className={getNavLinkClass('Billing')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <DollarSign className="w-5 h-5" />
                    <span>Billing & Invoicing</span>
                  </Link>
                  <Link
                    to={createPageUrl('TaxCenter')}
                    className={getNavLinkClass('TaxCenter')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <DollarSign className="w-5 h-5" />
                    <span>Tax Center</span>
                  </Link>


                  <Link
                    to={createPageUrl('SamMonitor')}
                    className={getNavLinkClass('SamMonitor')}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <Activity className="w-5 h-5" />
                    <span>Sam Monitor</span>
                  </Link>

                  <div className="mt-4 pt-4 border-t border-slate-100 text-xs text-center text-slate-400">
                    Created by <span className="font-semibold text-slate-600">John White</span> • v2.0
                  </div>
                </>
              )}
            </nav>
          </aside>

          <main className="flex-1 lg:ml-0">
            <div className="lg:hidden h-16"></div>
            {children}
          </main>
        </div>

        {isSidebarOpen && (
          <div
            className="fixed inset-0 bg-black bg-opacity-50 z-30 lg:hidden"
            onClick={() => setIsSidebarOpen(false)}
            aria-hidden="true"
          ></div>
        )}
        </div>
        </OnboardingManager>
        </AppErrorBoundary>
        </ThemeSettingsProvider>
        );
        }
