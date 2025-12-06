import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { DollarSign, FileText, Building2, AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { sumBy } from "lodash";
import StatCard from "@/components/shared/StatCard";
import { SkeletonCard, SkeletonGrantCard } from "@/components/shared/SkeletonCard";
import { useFilteredBudgets } from "@/components/hooks/useFilteredBudgets";
import { safeCurrency, safePercentage } from "@/components/shared/currencyUtils";
import { useAuthContext } from "@/components/hooks/useAuthRLS";

const LS_KEY = 'budgets:last_org_id';

export default function Budgets() {
  const [selectedOrgId, setSelectedOrgId] = useState('');

  // Central auth context
  const { user, isAdmin, isLoadingUser } = useAuthContext();

  // User-aware organization query
  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Organization.list('name')
      : base44.entities.Organization.filter({ created_by: user.email }, 'name'),
    enabled: !!user?.email,
  });

  // User-aware grants query
  const { data: grants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Grant.list()
      : base44.entities.Grant.filter({ created_by: user.email }),
    enabled: !!user?.email,
  });

  // RLS-safe budget and expense queries
  const { data: budgetItems = [], isLoading: isLoadingBudgets } = useQuery({
    queryKey: ['budgets', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Budget.list()
      : base44.entities.Budget.filter({ created_by: user.email }),
    enabled: !!user?.email,
  });

  const { data: expenses = [], isLoading: isLoadingExpenses } = useQuery({
    queryKey: ['expenses', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Expense.list()
      : base44.entities.Expense.filter({ created_by: user.email }),
    enabled: !!user?.email,
  });

  // Initialize selection from localStorage or first org; heal if selection disappears
  useEffect(() => {
    if (isLoadingUser || isLoadingOrgs) return;

    const ids = organizations.map((o) => String(o.id));
    if (ids.length === 0) {
      if (selectedOrgId) setSelectedOrgId('');
      return;
    }

    // If current selection is present, keep it
    if (selectedOrgId && ids.includes(String(selectedOrgId))) return;

    // Try restore last selection
    const saved = localStorage.getItem(LS_KEY);
    if (saved && ids.includes(saved)) {
      setSelectedOrgId(saved);
      return;
    }

    // Fallback to the first org
    setSelectedOrgId(ids[0]);
  }, [organizations, isLoadingUser, isLoadingOrgs, selectedOrgId]);

  // Persist selection
  useEffect(() => {
    if (selectedOrgId) {
      localStorage.setItem(LS_KEY, String(selectedOrgId));
    }
  }, [selectedOrgId]);

  const isLoading = isLoadingUser || isLoadingOrgs || isLoadingGrants || isLoadingBudgets || isLoadingExpenses;

  // Precompute per-grant budget and expense aggregates
  const budgetsByGrantId = useMemo(() => {
    const map = {};
    budgetItems.forEach(b => {
      if (!b.grant_id) return;
      if (!map[b.grant_id]) map[b.grant_id] = [];
      map[b.grant_id].push(b);
    });
    return map;
  }, [budgetItems]);

  const expensesByGrantId = useMemo(() => {
    const map = {};
    expenses.forEach(e => {
      if (!e.grant_id) return;
      if (!map[e.grant_id]) map[e.grant_id] = [];
      map[e.grant_id].push(e);
    });
    return map;
  }, [expenses]);

  // Use custom hook for filtered budget data
  const {
    awardedGrants,
    totalBudget,
    totalExpenses,
    remainingBudget
  } = useFilteredBudgets(grants, budgetItems, expenses, selectedOrgId);

  const hasSelectedOrg = !!selectedOrgId;
  const selectedOrg = organizations.find(o => o.id === selectedOrgId);

  // Memoize stats
  const stats = useMemo(() => [
    { title: "Total Budgeted", value: safeCurrency(totalBudget), icon: DollarSign, color: "text-blue-600" },
    { title: "Total Spent", value: safeCurrency(totalExpenses), icon: DollarSign, color: "text-amber-600" },
    { title: "Remaining Funds", value: safeCurrency(remainingBudget), icon: DollarSign, color: remainingBudget < 0 ? "text-red-600" : "text-emerald-600" },
  ], [totalBudget, totalExpenses, remainingBudget]);

  // Show skeleton loading
  if (isLoading) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
            <div>
              <h1 className="text-3xl font-bold text-slate-900 mb-2">Budgets & Expenses</h1>
              <p className="text-slate-600">Track budgets and spending for awarded grants.</p>
            </div>
            <div className="w-full md:w-80 h-10 bg-slate-200 rounded animate-pulse"></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            <SkeletonGrantCard />
            <SkeletonGrantCard />
            <SkeletonGrantCard />
          </div>
        </div>
      </div>
    );
  }

  // Empty state - no organizations
  if (organizations.length === 0) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold text-slate-900 mb-6">Budgets & Expenses</h1>
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Organizations Found</h3>
              <p className="text-slate-600 mb-6">
                Please create a profile to start managing budgets and expenses.
              </p>
              <Link to={createPageUrl("Organizations")}>
                <Button className="bg-blue-600 hover:bg-blue-700">
                  <Building2 className="w-4 h-4 mr-2" />
                  Create Organization
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 mb-2">Budgets & Expenses</h1>
            <p className="text-slate-600">Financial tracking for awarded grants</p>
          </div>
          
          <div className="w-full md:w-80">
            <Label htmlFor="org-select" className="sr-only">Select Organization Profile</Label>
            <Select value={String(selectedOrgId)} onValueChange={(v) => setSelectedOrgId(String(v))}>
              <SelectTrigger id="org-select" aria-label="Select organization profile">
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-slate-500" />
                  <SelectValue placeholder="Select a profile..." />
                </div>
              </SelectTrigger>
              <SelectContent>
                {organizations.map((org) => (
                  <SelectItem key={org.id} value={String(org.id)}>{org.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {!hasSelectedOrg ? (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Profile Selected</h3>
              <p className="text-slate-600">
                Please select a profile from the dropdown above to view budgets and expenses.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Overspent Alert */}
            {remainingBudget < 0 && (
              <Alert variant="destructive" className="mb-6">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <strong>Budget Exceeded:</strong> Total expenses have exceeded the budgeted amount by {safeCurrency(Math.abs(remainingBudget))}.
                </AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              {stats.map(stat => (
                <StatCard key={stat.title} {...stat} />
              ))}
            </div>

            <div>
              <h2 className="text-xl font-semibold text-slate-900 mb-4">
                {selectedOrg?.name} - Awarded Grants ({awardedGrants.length})
              </h2>
              {awardedGrants.length > 0 ? (
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {awardedGrants.map(grant => {
                    const grantBudgetItems = budgetsByGrantId[grant.id] || [];
                    const grantExpenses = expensesByGrantId[grant.id] || [];
                    const grantTotalBudget = sumBy(grantBudgetItems, 'total') || 0;
                    const grantTotalSpent = sumBy(grantExpenses, 'amount') || 0;
                    const grantRemaining = grantTotalBudget - grantTotalSpent;
                    const spentPercentage = safePercentage(grantTotalSpent, grantTotalBudget);
                    const isOverspent = grantRemaining < 0;

                    return (
                      <Card key={grant.id} className={`hover:shadow-xl transition-all flex flex-col ${isOverspent ? 'border-l-4 border-l-red-500' : ''}`}>
                        <CardHeader>
                          <div className="flex items-center gap-3 mb-2">
                            <FileText className={`w-5 h-5 ${isOverspent ? 'text-red-600' : 'text-emerald-600'}`} />
                            <CardTitle className="text-lg line-clamp-1">{grant.title}</CardTitle>
                          </div>
                          <p className="text-sm text-slate-600">{grant.funder}</p>
                        </CardHeader>
                        <CardContent className="flex-grow space-y-3">
                          {isOverspent && (
                            <Alert variant="destructive" className="py-2">
                              <AlertTriangle className="h-4 w-4" />
                              <AlertDescription className="text-xs">
                                Overspent by {safeCurrency(Math.abs(grantRemaining))}
                              </AlertDescription>
                            </Alert>
                          )}
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-slate-500">Budgeted</span>
                            <span className="font-semibold text-slate-800">{safeCurrency(grantTotalBudget)}</span>
                          </div>
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-slate-500">Spent</span>
                            <span className="font-semibold text-slate-800">{safeCurrency(grantTotalSpent)}</span>
                          </div>
                          <div className="relative pt-1">
                            <div className="overflow-hidden h-2 text-xs flex rounded bg-slate-200">
                              <div
                                style={{ width: `${spentPercentage}%` }}
                                className={`shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center ${
                                  isOverspent ? 'bg-red-500' : 'bg-emerald-500'
                                }`}
                              ></div>
                            </div>
                          </div>
                          <div className="flex justify-between items-center font-bold">
                            <span className="text-slate-500">Remaining</span>
                            <span className={isOverspent ? 'text-red-600' : 'text-emerald-600'}>
                              {safeCurrency(grantRemaining)}
                            </span>
                          </div>
                        </CardContent>
                        <CardFooter className="bg-slate-50 p-4 mt-4">
                          <Link to={createPageUrl("BudgetDetail") + `?id=${grant.id}`} className="w-full">
                            <Button variant="outline" className="w-full bg-white">
                              Manage Budget
                            </Button>
                          </Link>
                        </CardFooter>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                <Card className="shadow-lg border-0">
                  <CardContent className="p-12 text-center">
                    <DollarSign className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                    <h3 className="text-xl font-semibold text-slate-900 mb-2">No Awarded Grants</h3>
                    <p className="text-slate-600">
                      Once you win a grant and update its status to "Awarded" in the pipeline, you can manage its budget here.
                    </p>
                    <Link to={createPageUrl("Pipeline")}>
                      <Button variant="outline" className="mt-4">
                        View Pipeline
                      </Button>
                    </Link>
                  </CardContent>
                </Card>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}