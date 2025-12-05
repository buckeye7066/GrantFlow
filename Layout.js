import React, { useState, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import CrossPlatformInit from "@/components/shared/CrossPlatformInit";
import { safeLoginRedirect, isInAppBrowser } from "@/components/shared/safeNavigate";
import { isClientUser, ADMIN_ONLY_PAGES, getClientPrimaryOrganization } from "@/components/shared/clientUserUtils";
import { ThemeSettingsProvider } from "@/components/theme/ThemeSettingsProvider";

export const OWNER_EMAIL = 'buckeye7066@gmail.com';
export const SPECIAL_CLIENTS = {
  'avenell@example.com': { name: 'Avenell', welcomeMessage: 'Thank you for using GrantFlow!' }
};

const AVENELL_EMAILS = ['avenell@example.com'];
const MAINTENANCE_MODE = false;

function PWAHeadTags() {
  useEffect(() => {
    const head = document.head;
    const addMeta = (name, content, httpEquiv = false) => {
      const attr = httpEquiv ? 'http-equiv' : 'name';
      if (!head.querySelector(`meta[${attr}="${name}"]`)) {
        const meta = document.createElement('meta');
        meta[httpEquiv ? 'httpEquiv' : 'name'] = name;
        meta.content = content;
        head.appendChild(meta);
      }
    };
    const addLink = (rel, href, attrs = {}) => {
      if (!head.querySelector(`link[rel="${rel}"][href="${href}"]`)) {
        const link = document.createElement('link');
        link.rel = rel;
        link.href = href;
        Object.entries(attrs).forEach(([k, v]) => link.setAttribute(k, v));
        head.appendChild(link);
      }
    };
    addLink('manifest', '/manifest.json');
    addMeta('theme-color', '#1e3a8a');
    addMeta('apple-mobile-web-app-capable', 'yes');
    addMeta('apple-mobile-web-app-status-bar-style', 'default');
    addMeta('apple-mobile-web-app-title', 'GrantFlow');
    addLink('apple-touch-icon', '/icons/icon-192.png');
    addMeta('format-detection', 'telephone=no');
    addMeta('Content-Security-Policy', 'upgrade-insecure-requests', true);
    addMeta('referrer', 'no-referrer-when-downgrade');
    if (!head.querySelector('meta[name="viewport"]')) {
      addMeta('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    }
  }, []);
  return null;
}

export const isOwner = (user) => user?.email === OWNER_EMAIL || user?.role === 'admin';
import { LayoutDashboard, Building2, Search, Kanban, FileText, DollarSign, FolderOpen, Calendar, BarChart3, LogOut, Brain, FileStack, Database, DatabaseZap, ShieldCheck, Beaker, Target, Users, Layers, Package, Menu, X, Zap, Mail, Activity } from "lucide-react";
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
  const cleanPageName = pageName.replace(/^/+|/+$/g, '');
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
  
  const { data: user, isLoading: isLoadingUser } = useQuery({
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
            <p className="text-amber-100 text-lg mb-6">GrantFlow is currently undergoing scheduled maintenance.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
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
            <p className="text-slate-600 mb-6">Please sign in to access the application.</p>
            {isInAppBrowser() && <p className="text-xs text-amber-600 mb-4">For best experience, open in Safari or Chrome</p>}
            <Button onClick={handleLogin} className="w-full">Sign In</Button>
          </div>
        </div>
      </div>
    );
  }

  if (isPublicPage) {
    return (
      <AppErrorBoundary>
        <PWAHeadTags />
        <CrossPlatformInit />
        <div className="min-h-screen bg-slate-50">{children}</div>
      </AppErrorBoundary>
    );
  }

  return (
    <ThemeSettingsProvider>
      <AppErrorBoundary>
        <PWAHeadTags />
        <CrossPlatformInit />
        <ActivityTracker user={user} currentPageName={currentPageName} />
        <OnboardingManager user={user}>
          <WelcomeMessageHandler user={user} />
          <div className="min-h-screen bg-slate-50">
            <header className="bg-white border-b border-slate-200 sticky top-0 z-50 shadow-sm">
              <div className="flex items-center justify-between h-16 px-4 lg:px-6">
                <Link to={createPageUrl("Dashboard")} className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-blue-800 rounded-lg flex items-center justify-center shadow-lg">
                    <FileText className="w-5 h-5 text-white" />
                  </div>
                  <h1 className="font-bold text-slate-900 text-xl">GrantFlow</h1>
                </Link>
                <div className="flex items-center gap-3">
                  <ImmuneActivityIndicator />
                  <ThemeCustomizerPanel />
                  <OnboardingMenuButton />
                  <Button onClick={() => base44.auth.logout()}>Logout</Button>
                </div>
              </div>
            </header>
            {children}
          </div>
        </OnboardingManager>
      </AppErrorBoundary>
    </ThemeSettingsProvider>
  );
}