import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { BarChart3, TrendingUp, DollarSign, Target, FileText, Loader2 } from "lucide-react";
import { useAuthContext } from "@/components/hooks/useAuthRLS";

const LS_KEY = 'reports:last_org_id';

// Import new report components
import PipelineVisualization from "@/components/reports/PipelineVisualization";
import PerformanceAnalytics from "@/components/reports/PerformanceAnalytics";
import FinancialReporting from "@/components/reports/FinancialReporting";
import CustomReportBuilder from "@/components/reports/CustomReportBuilder";

// Safe date parsing helper
const parseCreatedDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
};

export default function Reports() {
  const [selectedOrgId, setSelectedOrgId] = useState('all');
  const [dateRange, setDateRange] = useState('all');

  const { user, isAdmin, isLoadingUser } = useAuthContext();

  // Fetch data
  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Organization.list()
      : base44.entities.Organization.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  const { data: allGrants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Grant.list()
      : base44.entities.Grant.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  const { data: budgetItems = [] } = useQuery({
    queryKey: ['budgets', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Budget.list()
      : base44.entities.Budget.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Expense.list()
      : base44.entities.Expense.filter({ created_by: user?.email }),
    enabled: !!user?.email,
  });

  // Initialize selection from localStorage or first org; heal if selection disappears
  useEffect(() => {
    if (isLoadingUser || isLoadingOrgs) return;

    const ids = organizations.map((o) => String(o.id));
    // Include 'all' as a valid selection
    const validIds = ['all', ...ids];

    // If current selection is valid, keep it
    if (validIds.includes(String(selectedOrgId))) return;

    // Try restore last selection
    const saved = localStorage.getItem(LS_KEY);
    if (saved && validIds.includes(saved)) {
      setSelectedOrgId(saved);
      return;
    }

    // Fallback to 'all'
    setSelectedOrgId('all');
  }, [organizations, isLoadingUser, isLoadingOrgs, selectedOrgId]);

  // Persist selection
  useEffect(() => {
    if (selectedOrgId) {
      localStorage.setItem(LS_KEY, String(selectedOrgId));
    }
  }, [selectedOrgId]);

  // Filter grants by organization and date range
  const filteredGrants = useMemo(() => {
    let grants = allGrants;

    // Filter by organization
    if (selectedOrgId !== 'all') {
      grants = grants.filter(g => String(g.organization_id) === String(selectedOrgId));
    }

    // Filter by date range
    if (dateRange !== 'all') {
      const now = new Date();
      const cutoffDate = new Date();

      switch (dateRange) {
        case '30days':
          cutoffDate.setDate(now.getDate() - 30);
          break;
        case '90days':
          cutoffDate.setDate(now.getDate() - 90);
          break;
        case '1year':
          cutoffDate.setFullYear(now.getFullYear() - 1);
          break;
      }

      grants = grants.filter(g => {
        const created = parseCreatedDate(g.created_date);
        if (!created) return false;
        return created >= cutoffDate;
      });
    }

    return grants;
  }, [allGrants, selectedOrgId, dateRange]);

  // Filter budgets and expenses by selected grants (optimized with Set)
  const filteredBudgetItems = useMemo(() => {
    const grantIds = new Set(filteredGrants.map(g => String(g.id)));
    return budgetItems.filter(b => grantIds.has(String(b.grant_id)));
  }, [budgetItems, filteredGrants]);

  const filteredExpenses = useMemo(() => {
    const grantIds = new Set(filteredGrants.map(g => String(g.id)));
    return expenses.filter(e => grantIds.has(String(e.grant_id)));
  }, [expenses, filteredGrants]);

  const isLoading = isLoadingUser || isLoadingOrgs || isLoadingGrants;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <BarChart3 className="w-8 h-8 text-blue-600" />
            Reports & Analytics
          </h1>
          <p className="text-slate-600 mt-2">
            Comprehensive analytics for grant performance and financial tracking
          </p>
        </div>

        {/* Filters */}
        <Card className="mb-6">
          <CardContent className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Organization</Label>
                <Select value={String(selectedOrgId)} onValueChange={(v) => setSelectedOrgId(String(v))}>
                  <SelectTrigger className="mt-2">
                    <SelectValue placeholder="Select organization..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Organizations</SelectItem>
                    {organizations.map((org) => (
                      <SelectItem key={org.id} value={String(org.id)}>
                        {org.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Date Range</Label>
                <Select value={dateRange} onValueChange={setDateRange}>
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Time</SelectItem>
                    <SelectItem value="30days">Last 30 Days</SelectItem>
                    <SelectItem value="90days">Last 90 Days</SelectItem>
                    <SelectItem value="1year">Last Year</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Report Tabs */}
        <Tabs defaultValue="pipeline" className="space-y-6">
          <TabsList className="grid w-full grid-cols-4 lg:w-auto lg:inline-grid">
            <TabsTrigger value="pipeline" className="gap-2">
              <Target className="w-4 h-4" />
              Pipeline
            </TabsTrigger>
            <TabsTrigger value="performance" className="gap-2">
              <TrendingUp className="w-4 h-4" />
              Performance
            </TabsTrigger>
            <TabsTrigger value="financial" className="gap-2">
              <DollarSign className="w-4 h-4" />
              Financial
            </TabsTrigger>
            <TabsTrigger value="custom" className="gap-2">
              <FileText className="w-4 h-4" />
              Custom
            </TabsTrigger>
          </TabsList>

          {/* Pipeline Visualization */}
          <TabsContent value="pipeline" className="space-y-6">
            <PipelineVisualization grants={filteredGrants} />
          </TabsContent>

          {/* Performance Analytics */}
          <TabsContent value="performance" className="space-y-6">
            <PerformanceAnalytics 
              grants={filteredGrants}
              dateRange={dateRange}
            />
          </TabsContent>

          {/* Financial Reporting */}
          <TabsContent value="financial" className="space-y-6">
            <FinancialReporting 
              grants={filteredGrants}
              budgetItems={filteredBudgetItems}
              expenses={filteredExpenses}
            />
          </TabsContent>

          {/* Custom Report Builder */}
          <TabsContent value="custom" className="space-y-6">
            <CustomReportBuilder 
              grants={filteredGrants}
              organizations={organizations}
            />
          </TabsContent>
        </Tabs>

        {/* Empty State */}
        {filteredGrants.length === 0 && (
          <Card className="mt-6">
            <CardContent className="p-12 text-center">
              <BarChart3 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Data Available</h3>
              <p className="text-slate-600">
                {selectedOrgId !== 'all' 
                  ? 'No grants found for the selected organization and date range.'
                  : 'Add grants to your pipeline to see analytics and reports.'}
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}