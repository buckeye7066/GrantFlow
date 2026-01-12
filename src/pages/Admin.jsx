import React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Shield, Activity, AlertCircle, Bot, DollarSign, Wrench, Workflow } from 'lucide-react';
import AdminDocumentUpload from '@/components/admin/AdminDocumentUpload';
import AdminDiagnostics from '@/components/admin/AdminDiagnostics';
import AdminGeoCrawl from '@/components/admin/AdminGeoCrawl';
import AdminMaintenance from '@/components/admin/AdminMaintenance';
import AdminAnyaConsole from '@/components/admin/AdminAnyaConsole';
import Billing from '@/pages/Billing';
import Automation from '@/pages/Automation';
import { useAuthStore } from '@/stores/authStore';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { isAdminUser } from '@/utils/isAdminUser';

export default function Admin() {
  const user = useAuthStore((state) => state.user);
  const isAdmin = isAdminUser(user);

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
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Shield className="w-8 h-8 text-blue-600" />
            Admin Panel
          </h1>
          <p className="text-slate-600 mt-2">
            Administrative tools and features
          </p>
        </div>

        <Tabs defaultValue="diagnostics" className="w-full">
          <TabsList>
            <TabsTrigger value="diagnostics">
              <Activity className="w-4 h-4 mr-2" />
              Diagnostics
            </TabsTrigger>
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
            <TabsTrigger value="billing">
              <DollarSign className="w-4 h-4 mr-2" />
              Billing
            </TabsTrigger>
            <TabsTrigger value="maintenance">
              <Wrench className="w-4 h-4 mr-2" />
              Maintenance
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="diagnostics" className="mt-6">
            <AdminDiagnostics />
          </TabsContent>
          
          <TabsContent value="upload" className="mt-6">
            <AdminDocumentUpload />
          </TabsContent>

          <TabsContent value="geo" className="mt-6">
            <AdminGeoCrawl />
          </TabsContent>

          <TabsContent value="automation" className="mt-6">
            <Automation />
          </TabsContent>

          <TabsContent value="anya" className="mt-6">
            <AdminAnyaConsole />
          </TabsContent>

          <TabsContent value="billing" className="mt-6">
            <Billing />
          </TabsContent>

          <TabsContent value="maintenance" className="mt-6">
            <AdminMaintenance />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
