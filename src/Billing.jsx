
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  DollarSign, 
  FileText, 
  Clock, 
  Receipt,
  AlertCircle,
  Plus,
  Building2,
  Loader2,
  Printer
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import TimeTrackingTab from "../components/billing/TimeTrackingTab";
import ProjectsTab from "../components/billing/ProjectsTab";
import InvoicesTab from "../components/billing/InvoicesTab";
import SettingsTab from "../components/billing/SettingsTab";

export default function Billing() {
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedOrgId, setSelectedOrgId] = useState(null);

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list('name'),
  });

  const { data: projects = [], isLoading: isLoadingProjects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => base44.entities.Project.list('-created_date'),
  });

  const { data: invoices = [], isLoading: isLoadingInvoices } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => base44.entities.Invoice.list('-issue_date'),
  });

  const { data: timeLogs = [], isLoading: isLoadingTime } = useQuery({
    queryKey: ['timeLogs'],
    queryFn: () => base44.entities.TimeEntry.filter({ billed: false }),
  });

  // Auto-select first organization if none selected
  useEffect(() => {
    if (!selectedOrgId && organizations.length > 0) {
      setSelectedOrgId(organizations[0].id);
    }
  }, [organizations, selectedOrgId]);

  // DIAGNOSIS: Check for weekly invoice generation
  useEffect(() => {
    const checkAndGenerateInvoices = async () => {
      console.log("Checking if draft invoices should be generated...");
      const nowInNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      const dayOfWeek = nowInNY.getDay();
      const hours = nowInNY.getHours();
      
      const isFriday = dayOfWeek === 5;
      const isAfterPrepareTime = hours >= 16;

      const lastCheck = localStorage.getItem('lastInvoiceGenerationCheck');
      const oneWeekAgo = new Date();
      oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

      if (isFriday && isAfterPrepareTime && (!lastCheck || new Date(lastCheck) < oneWeekAgo)) {
          console.log("It's time to generate draft invoices!");
          localStorage.setItem('lastInvoiceGenerationCheck', new Date().toISOString());
      }
    };
    checkAndGenerateInvoices();
  }, []);

  const isLoading = isLoadingOrgs || isLoadingProjects || isLoadingInvoices || isLoadingTime;

  // Filter data by selected organization
  const filteredProjects = React.useMemo(() => {
    if (!selectedOrgId) return [];
    return projects.filter(p => p.organization_id === selectedOrgId);
  }, [projects, selectedOrgId]);

  const filteredInvoices = React.useMemo(() => {
    if (!selectedOrgId) return [];
    return invoices.filter(i => i.organization_id === selectedOrgId);
  }, [invoices, selectedOrgId]);

  const filteredTimeLogs = React.useMemo(() => {
    if (!selectedOrgId) return [];
    return timeLogs.filter(t => t.organization_id === selectedOrgId);
  }, [timeLogs, selectedOrgId]);

  const unbilledTime = filteredTimeLogs.filter(t => t.billable);
  const unbilledAmount = unbilledTime.reduce((sum, t) => sum + (t.total_amount || 0), 0);
  
  const unpaidInvoices = filteredInvoices.filter(i => i.status !== 'paid' && i.status !== 'cancelled');
  const totalAR = unpaidInvoices.reduce((sum, i) => sum + (i.balance_due || 0), 0);

  const overdueInvoices = filteredInvoices.filter(i => 
    i.status === 'overdue' || 
    (i.due_date && !isNaN(new Date(i.due_date).getTime()) && new Date(i.due_date) < new Date() && i.status !== 'paid')
  );

  const selectedOrg = organizations.find(o => o.id === selectedOrgId);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Billing & Invoicing</h1>
            <p className="text-slate-600 mt-2">Ethical, transparent grant writing compensation</p>
          </div>
          
          <div className="flex gap-3 w-full md:w-auto">
            <Select value={selectedOrgId || ""} onValueChange={setSelectedOrgId} className="flex-1 md:flex-none md:w-64">
              <SelectTrigger>
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-slate-500" />
                  <SelectValue placeholder="Select a profile..." />
                </div>
              </SelectTrigger>
              <SelectContent>
                {organizations.map(org => (
                  <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            {selectedOrgId && (
              <>
                <Link to={createPageUrl(`BillingSheet?organization_id=${selectedOrgId}`)}>
                  <Button variant="outline" className="whitespace-nowrap">
                    <FileText className="w-4 h-4 mr-2" />
                    Billing Sheet
                  </Button>
                </Link>
                <Link to={createPageUrl("BillingSheet")}>
                  <Button variant="outline" className="whitespace-nowrap">
                    <Printer className="w-4 h-4 mr-2" />
                    Master Sheet
                  </Button>
                </Link>
                <Link to={createPageUrl(`CreateInvoice?organization_id=${selectedOrgId}`)}>
                  <Button className="bg-emerald-600 hover:bg-emerald-700 whitespace-nowrap">
                    <Plus className="w-4 h-4 mr-2" />
                    Invoice
                  </Button>
                </Link>
                <Link to={createPageUrl("NewProject")}>
                  <Button className="bg-blue-600 hover:bg-blue-700 whitespace-nowrap">
                    <Plus className="w-4 h-4 mr-2" />
                    Project
                  </Button>
                </Link>
              </>
            )}
          </div>
        </div>

        {/* Ethical Standards Banner */}
        <Card className="mb-6 border-l-4 border-l-emerald-600 bg-emerald-50 border-emerald-200">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-emerald-700 mt-0.5" />
              <div>
                <h3 className="font-semibold text-emerald-900 mb-1">Ethical Billing Standards</h3>
                <p className="text-sm text-emerald-800">
                  This system enforces ethical grant writing practices: <strong>No percentage-of-award fees</strong>. 
                  Only fixed-fee, hourly, or milestone billing. All costs must comply with funder rules.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {!selectedOrgId ? (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Profile Selected</h3>
              <p className="text-slate-600">
                Please select a profile from the dropdown above to view billing and invoicing information.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Stats Overview */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
              <Card className="border-0 shadow-lg">
                <CardContent className="p-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="text-sm text-slate-600">Active Projects</p>
                      <p className="text-3xl font-bold text-slate-900 mt-2">
                        {filteredProjects.filter(p => p.status === 'active').length}
                      </p>
                    </div>
                    <div className="p-3 bg-blue-50 rounded-xl">
                      <FileText className="w-6 h-6 text-blue-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-0 shadow-lg">
                <CardContent className="p-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="text-sm text-slate-600">Unbilled Time</p>
                      <p className="text-3xl font-bold text-slate-900 mt-2">
                        ${unbilledAmount.toLocaleString()}
                      </p>
                    </div>
                    <div className="p-3 bg-amber-50 rounded-xl">
                      <Clock className="w-6 h-6 text-amber-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-0 shadow-lg">
                <CardContent className="p-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="text-sm text-slate-600">Accounts Receivable</p>
                      <p className="text-3xl font-bold text-slate-900 mt-2">
                        ${totalAR.toLocaleString()}
                      </p>
                    </div>
                    <div className="p-3 bg-emerald-50 rounded-xl">
                      <DollarSign className="w-6 h-6 text-emerald-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-0 shadow-lg">
                <CardContent className="p-6">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="text-sm text-slate-600">Overdue Invoices</p>
                      <p className="text-3xl font-bold text-red-600 mt-2">
                        {overdueInvoices.length}
                      </p>
                    </div>
                    <div className="p-3 bg-red-50 rounded-xl">
                      <Receipt className="w-6 h-6 text-red-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="mb-6">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="projects">Projects</TabsTrigger>
                <TabsTrigger value="invoices">Invoices</TabsTrigger>
                <TabsTrigger value="time">Time Tracking</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>

              <TabsContent value="overview">
                <div className="grid lg:grid-cols-2 gap-6">
                  <Card className="shadow-lg border-0">
                    <CardHeader className="border-b border-slate-100">
                      <CardTitle>Recent Projects</CardTitle>
                    </CardHeader>
                    <CardContent className="p-6">
                      {filteredProjects.length === 0 ? (
                        <div className="text-center py-8 text-slate-500">
                          <FileText className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                          <p>No projects yet</p>
                          <Link to={createPageUrl("NewProject")}>
                            <Button variant="outline" size="sm" className="mt-3">
                              Create First Project
                            </Button>
                          </Link>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {filteredProjects.slice(0, 5).map(project => (
                            <div key={project.id} className="p-4 bg-slate-50 rounded-lg">
                              <div className="flex justify-between items-start mb-2">
                                <h4 className="font-semibold text-slate-900">{project.project_name}</h4>
                                <Badge variant="outline">{project.status}</Badge>
                              </div>
                              <p className="text-sm text-slate-600">{selectedOrg?.name}</p>
                              <div className="flex items-center gap-4 mt-2 text-sm">
                                <span className="text-slate-600">
                                  {project.pricing_model?.replace('_', ' ')}
                                </span>
                                {project.payment_option === 'bill_to_grant' && (
                                  <Badge className="bg-emerald-100 text-emerald-700">
                                    Grant Billable
                                  </Badge>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="shadow-lg border-0">
                    <CardHeader className="border-b border-slate-100">
                      <CardTitle>Recent Invoices</CardTitle>
                    </CardHeader>
                    <CardContent className="p-6">
                      {filteredInvoices.length === 0 ? (
                        <div className="text-center py-8 text-slate-500">
                          <Receipt className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                          <p>No invoices yet</p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {filteredInvoices.slice(0, 5).map(invoice => (
                            <div key={invoice.id} className="p-4 bg-slate-50 rounded-lg">
                              <div className="flex justify-between items-start mb-2">
                                <h4 className="font-semibold text-slate-900">{invoice.invoice_number}</h4>
                                <Badge 
                                  variant={invoice.status === 'paid' ? 'default' : 'outline'}
                                  className={invoice.status === 'overdue' ? 'bg-red-100 text-red-700' : ''}
                                >
                                  {invoice.status}
                                </Badge>
                              </div>
                              <div className="flex justify-between items-center text-sm">
                                <span className="text-slate-600">
                                  Due: {invoice.due_date && !isNaN(new Date(invoice.due_date)) ? new Date(invoice.due_date).toLocaleDateString() : 'N/A'}
                                </span>
                                <span className="font-bold text-slate-900">
                                  ${invoice.balance_due?.toLocaleString()}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="projects">
                <ProjectsTab projects={filteredProjects} organizations={[selectedOrg]} />
              </TabsContent>

              <TabsContent value="invoices">
                <InvoicesTab invoices={filteredInvoices} organizations={[selectedOrg]} />
              </TabsContent>

              <TabsContent value="time">
                <TimeTrackingTab timeLogs={filteredTimeLogs} projects={filteredProjects} />
              </TabsContent>

              <TabsContent value="settings">
                <SettingsTab />
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </div>
  );
}
