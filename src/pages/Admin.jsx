import React, { Suspense } from 'react';
import { lazyWithRetry } from '@/utils/lazyWithRetry';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Shield, Activity, AlertCircle, Bot, DollarSign, Mail, Wrench, Workflow, Users, Bell, Loader2, Search, KeyRound, Laptop } from 'lucide-react';
import AdminDocumentUpload from '@/components/admin/AdminDocumentUpload';
import AdminDiagnostics from '@/components/admin/AdminDiagnostics';
import AdminGeoCrawl from '@/components/admin/AdminGeoCrawl';
import AdminMaintenance from '@/components/admin/AdminMaintenance';
import AdminAnyaConsole from '@/components/admin/AdminAnyaConsole';
import AdminHamiltonHardStops from '@/components/admin/AdminHamiltonHardStops.jsx';
import AdminJohnConsole from '@/components/admin/AdminJohnConsole';
import AdminYanaConsole from '@/components/admin/AdminYanaConsole';
import AdminRobertConsole from '@/components/admin/AdminRobertConsole';
import AdminSamConsole from '@/components/admin/AdminSamConsole';
import AdminServiceApplications from '@/components/admin/AdminServiceApplications';
import AdminLoginNotifications from '@/components/admin/AdminLoginNotifications.jsx';
import AdminProfileDedupe from '@/components/admin/AdminProfileDedupe.jsx';
import AdminProfileIntegrity from '@/components/admin/AdminProfileIntegrity.jsx';
import AdminKnowledgeBase from '@/components/admin/AdminKnowledgeBase.jsx'
import AdminServiceCatalog from '@/components/admin/AdminServiceCatalog.jsx'
import AdminExclusionRules from '@/components/admin/AdminExclusionRules'
import AdminAgentMissionControl from '@/components/admin/AdminAgentMissionControl'
import AdminFundingTrace from '@/components/admin/AdminFundingTrace.jsx'
import AdminCredentialVault from '@/components/admin/AdminCredentialVault.jsx'
import AdminLaptopInbox from '@/components/admin/AdminLaptopInbox.jsx'
// Use lazyWithRetry (not raw React.lazy) so a stale-deploy chunk failure when
// switching to the Billing/Automation tabs auto-recovers with one reload
// instead of tripping the RouteErrorBoundary.
const Billing = lazyWithRetry(() => import('@/pages/Billing'), 'Admin:Billing');
const Automation = lazyWithRetry(() => import('@/pages/Automation'), 'Admin:Automation');
import { useAuthStore } from '@/stores/authStore';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { isHamiltonAdminEmail } from '../../shared/adminEmail.js';

export default function Admin() {
  const user = useAuthStore((state) => state.user);
  // Use Boolean coercion to align with backend truthy checks - not strict equality
  const isAdmin = Boolean(user?.is_admin) || user?.role === 'admin';
  // Yana operator dashboard is restricted to the single canonical admin email.
  const isYanaOperator = isHamiltonAdminEmail(user?.email || user?.primary_email);

  if (!isAdmin) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-2xl mx-auto">
          <Alert variant="destructive">
            <AlertCircle className="w-4 h-4" />
            <AlertDescription>
              Access Denied - This area is restricted to administrators only.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
            <Shield className="w-8 h-8 text-primary" />
            Admin Panel
          </h1>
          <p className="text-muted-foreground mt-2">
            Administrative tools and features
          </p>
        </div>

        <Tabs defaultValue="applications" className="w-full">
          {/* Single-row, horizontally scrollable tablist. `flex-wrap` previously
              wrapped tabs into rows that overlapped the panel (fixed-height
              container) and made lower-row tabs unclickable. flex-nowrap +
              overflow-x-auto keeps every tab on one scrollable row; shrink-0
              stops triggers from compressing so labels stay readable. */}
          <TabsList className="flex w-full max-w-full justify-start flex-nowrap overflow-x-auto overflow-y-hidden [&>button]:shrink-0">
            <TabsTrigger value="applications">
              <Users className="w-4 h-4 mr-2" />
              Applications
            </TabsTrigger>
            <TabsTrigger value="logins">
              <Bell className="w-4 h-4 mr-2" />
              Logins
            </TabsTrigger>
            <TabsTrigger value="profiles">
              <Users className="w-4 h-4 mr-2" />
              Profiles
            </TabsTrigger>
            <TabsTrigger value="diagnostics">
              <Activity className="w-4 h-4 mr-2" />
              Diagnostics
            </TabsTrigger>
            <TabsTrigger value="knowledge">Knowledge Base</TabsTrigger>
            <TabsTrigger value="upload">Upload Profile Document</TabsTrigger>
            <TabsTrigger value="geo">Geo Crawl</TabsTrigger>
            <TabsTrigger value="automation">
              <Workflow className="w-4 h-4 mr-2" />
              Automation
            </TabsTrigger>
            <TabsTrigger value="anya">
              <Bot className="w-4 h-4 mr-2" />
              Anya
            </TabsTrigger>
            {isYanaOperator && (
              <TabsTrigger value="hamilton_hard_stops">
                <AlertCircle className="w-4 h-4 mr-2" />
                Hamilton hard stops
              </TabsTrigger>
            )}
            <TabsTrigger value="agents">
              <Activity className="w-4 h-4 mr-2" />
              Mission Control
            </TabsTrigger>
            <TabsTrigger value="john">
              <Bot className="w-4 h-4 mr-2" />
              John
            </TabsTrigger>
            <TabsTrigger value="yana-leads">
              <Mail className="w-4 h-4 mr-2" />
              Yana
            </TabsTrigger>
            <TabsTrigger value="robert">
              <Bot className="w-4 h-4 mr-2" />
              Robert
            </TabsTrigger>
            <TabsTrigger value="sam">
              <Wrench className="w-4 h-4 mr-2" />
              Sam
            </TabsTrigger>
            <TabsTrigger value="billing">
              <DollarSign className="w-4 h-4 mr-2" />
              Billing
            </TabsTrigger>
            <TabsTrigger value="services">
              <DollarSign className="w-4 h-4 mr-2" />
              Services
            </TabsTrigger>
            <TabsTrigger value="vault">
              <KeyRound className="w-4 h-4 mr-2" />
              Credential vault
            </TabsTrigger>
            <TabsTrigger value="maintenance">
              <Wrench className="w-4 h-4 mr-2" />
              Maintenance
            </TabsTrigger>
            <TabsTrigger value="exclusions">Exclusions</TabsTrigger>
            <TabsTrigger value="funding_trace">
              <Search className="w-4 h-4 mr-2" />
              Funding Trace
            </TabsTrigger>
            <TabsTrigger value="laptop_inbox">
              <Laptop className="w-4 h-4 mr-2" />
              Laptop Inbox
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="applications" className="mt-6">
            <AdminServiceApplications />
          </TabsContent>

          <TabsContent value="logins" className="mt-6">
            <AdminLoginNotifications />
          </TabsContent>

          <TabsContent value="profiles" className="mt-6">
            <div className="space-y-6">
              <AdminProfileIntegrity />
              <AdminProfileDedupe />
            </div>
          </TabsContent>

          <TabsContent value="diagnostics" className="mt-6">
            <AdminDiagnostics />
          </TabsContent>

          <TabsContent value="knowledge" className="mt-6">
            <AdminKnowledgeBase />
          </TabsContent>
          
          <TabsContent value="upload" className="mt-6">
            <AdminDocumentUpload />
          </TabsContent>

          <TabsContent value="geo" className="mt-6">
            <AdminGeoCrawl />
          </TabsContent>

          <TabsContent value="automation" className="mt-6">
            <Suspense fallback={<div className="flex justify-center p-12"><Loader2 className="animate-spin h-8 w-8 text-blue-600" /></div>}>
              <Automation />
            </Suspense>
          </TabsContent>

          <TabsContent value="anya" className="mt-6">
            <AdminAnyaConsole />
          </TabsContent>

          {isYanaOperator && (
            <TabsContent value="hamilton_hard_stops" className="mt-6">
              <AdminHamiltonHardStops />
            </TabsContent>
          )}

          <TabsContent value="agents" className="mt-6">
            <AdminAgentMissionControl />
          </TabsContent>

          <TabsContent value="john" className="mt-6">
            <AdminJohnConsole />
          </TabsContent>

          <TabsContent value="yana-leads" className="mt-6">
            <AdminYanaConsole />
          </TabsContent>

          <TabsContent value="robert" className="mt-6">
            <AdminRobertConsole />
          </TabsContent>

          <TabsContent value="sam" className="mt-6">
            <AdminSamConsole />
          </TabsContent>

          <TabsContent value="billing" className="mt-6">
            <Suspense fallback={<div className="flex justify-center p-12"><Loader2 className="animate-spin h-8 w-8 text-blue-600" /></div>}>
              <Billing />
            </Suspense>
          </TabsContent>

          <TabsContent value="services" className="mt-6">
            <AdminServiceCatalog />
          </TabsContent>

          <TabsContent value="vault" className="mt-6">
            <AdminCredentialVault />
          </TabsContent>

          <TabsContent value="maintenance" className="mt-6">
            <AdminMaintenance />
          </TabsContent>

          <TabsContent value="exclusions" className="mt-6">
            <AdminExclusionRules />
          </TabsContent>

          <TabsContent value="funding_trace" className="mt-6">
            <AdminFundingTrace />
          </TabsContent>

          <TabsContent value="laptop_inbox" className="mt-6">
            <AdminLaptopInbox />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
