import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileText, Receipt } from "lucide-react";
import TimeTrackingTab from "./TimeTrackingTab";
import ProjectsTab from "./ProjectsTab";
import InvoicesTab from "./InvoicesTab";
import SettingsTab from "./SettingsTab";

/**
 * Billing tabs component with all tab content
 */
export default function BillingTabs({ 
  activeTab, 
  setActiveTab, 
  filteredProjects, 
  filteredInvoices, 
  filteredTimeLogs, 
  selectedOrg 
}) {
  return (
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
                  <p className="font-semibold mb-2">No Projects Yet</p>
                  <p className="text-sm mb-4">Create a project to start tracking work and billing.</p>
                  <Link to={createPageUrl("NewProject")}>
                    <Button variant="outline" size="sm">
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
                  <p className="font-semibold mb-2">No Invoices Yet</p>
                  <p className="text-sm mb-4">Invoices will appear here once they are generated.</p>
                  <Link to={createPageUrl("CreateInvoice")}>
                    <Button variant="outline" size="sm">
                      Create First Invoice
                    </Button>
                  </Link>
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
  );
}