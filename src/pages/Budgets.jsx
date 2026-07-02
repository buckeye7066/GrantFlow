import React, { useState } from "react";
import client from '@/api/client';
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { DollarSign, FileText, TrendingUp, TrendingDown, Banknote, Building2, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { sumBy } from "@/utils/aggregate";

const StatCard = ({ title, value, icon: Icon, color }) => (
  <Card className="shadow-lg border-0">
    <CardContent className="p-6">
      <div className="flex justify-between items-start">
        <div>
          <p className={`text-sm font-medium ${color}`}>{title}</p>
          <p className="text-3xl font-bold text-slate-900 mt-2">${(value ?? 0).toLocaleString()}</p>
        </div>
        <div className="p-3 bg-slate-100 rounded-xl">
          <Icon className={`w-6 h-6 ${color}`} />
        </div>
      </div>
    </CardContent>
  </Card>
);

export default function Budgets() {
  const [selectedOrgId, setSelectedOrgId] = useState(null);

  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => client.entities.Organization.list('name'),
  });

  const { data: grants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants'],
    queryFn: () => client.entities.Grant.list(),
  });

  const { data: budgetItems = [], isLoading: isLoadingBudgets } = useQuery({
    queryKey: ['budgets'],
    queryFn: () => client.entities.Budget.list(),
  });

  const { data: expenses = [], isLoading: isLoadingExpenses } = useQuery({
    queryKey: ['expenses'],
    queryFn: () => client.entities.Expense.list(),
  });

  // Auto-select first organization if none selected
  React.useEffect(() => {
    if (!selectedOrgId && organizations.length > 0) {
      setSelectedOrgId(organizations[0].id);
    }
  }, [organizations, selectedOrgId]);

  const isLoading = isLoadingOrgs || isLoadingGrants || isLoadingBudgets || isLoadingExpenses;

  // Filter data by selected organization
  const filteredGrants = React.useMemo(() => {
    if (!selectedOrgId) return [];
    return grants.filter(g => g.organization_id === selectedOrgId);
  }, [grants, selectedOrgId]);

  const awardedGrants = filteredGrants.filter(g => g.status === 'awarded');
  
  const totalBudget = React.useMemo(() => {
    const relevantBudgets = budgetItems.filter(b => 
      filteredGrants.some(g => g.id === b.grant_id)
    );
    return sumBy(relevantBudgets, 'total');
  }, [budgetItems, filteredGrants]);

  const totalExpenses = React.useMemo(() => {
    const relevantExpenses = expenses.filter(e => 
      filteredGrants.some(g => g.id === e.grant_id)
    );
    return sumBy(relevantExpenses, 'amount');
  }, [expenses, filteredGrants]);

  const remainingBudget = totalBudget - totalExpenses;

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
            <h1 className="text-3xl font-bold text-slate-900 mb-2">Budgets & Expenses</h1>
            <p className="text-slate-600">Track budgets and spending for awarded grants.</p>
          </div>
          
          <div className="w-full md:w-80">
            <Select value={selectedOrgId || ""} onValueChange={setSelectedOrgId}>
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
          </div>
        </div>

        {!selectedOrgId ? (
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              <StatCard title="Total Budgeted" value={totalBudget} icon={Banknote} color="text-blue-600" />
              <StatCard title="Total Spent" value={totalExpenses} icon={TrendingDown} color="text-amber-600" />
              <StatCard title="Remaining Funds" value={remainingBudget} icon={DollarSign} color="text-emerald-600" />
            </div>

            <div>
              <h2 className="text-xl font-semibold text-slate-900 mb-4">
                {selectedOrg?.name} - Awarded Grants ({awardedGrants.length})
              </h2>
              {awardedGrants.length > 0 ? (
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {awardedGrants.map(grant => {
                    const grantBudgetItems = budgetItems.filter(b => b.grant_id === grant.id);
                    const grantExpenses = expenses.filter(e => e.grant_id === grant.id);
                    const grantTotalBudget = sumBy(grantBudgetItems, 'total');
                    const grantTotalSpent = sumBy(grantExpenses, 'amount');
                    const grantRemaining = grantTotalBudget - grantTotalSpent;

                    return (
                      <Card key={grant.id} className="hover:shadow-xl transition-all flex flex-col">
                        <CardHeader>
                          <div className="flex items-center gap-3 mb-2">
                            <FileText className="w-5 h-5 text-emerald-600" />
                            <CardTitle className="text-lg line-clamp-1">{grant.title}</CardTitle>
                          </div>
                          <p className="text-sm text-slate-600">{grant.funder}</p>
                        </CardHeader>
                        <CardContent className="flex-grow space-y-3">
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-slate-500">Budgeted</span>
                            <span className="font-semibold text-slate-800">${grantTotalBudget.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-slate-500">Spent</span>
                            <span className="font-semibold text-slate-800">${grantTotalSpent.toLocaleString()}</span>
                          </div>
                          <div className="relative pt-1">
                            <div className="overflow-hidden h-2 text-xs flex rounded bg-slate-200">
                              <div
                                style={{ width: `${Math.min(100, grantTotalBudget > 0 ? (grantTotalSpent / grantTotalBudget) * 100 : 0)}%` }}
                                className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-emerald-500"
                              ></div>
                            </div>
                          </div>
                          <div className="flex justify-between items-center font-bold">
                            <span className="text-slate-500">Remaining</span>
                            <span className={grantRemaining < 0 ? "text-red-600" : "text-emerald-600"}>
  {grantRemaining < 0 ? `-$${Math.abs(grantRemaining).toLocaleString()}` : `$${grantRemaining.toLocaleString()}`}
</span>
                          </div>
                        </CardContent>
                        <CardFooter className="bg-slate-50 p-4 mt-4">
                          <Link to={createPageUrl("BudgetDetail", { id: grant.id })} className="w-full">
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