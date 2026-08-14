import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Loader2, PlusCircle, FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import AddExpenseForm from '../budgets/AddExpenseForm'; // Assuming this exists for logging spend

const defaultPolicy = {
  categories: [
    { code: "PERSONNEL", label: "Personnel", max_pct: 60 },
    { code: "EQUIP", label: "Equipment", max_pct: 20 },
    { code: "ADMIN", label: "Administrative", max_pct: 10 }
  ],
  geofence: [],
  notes: "Follow 2 CFR 200 for federal grants."
};

export default function ComplianceTab({ grant }) {
  const queryClient = useQueryClient();
  const [showExpenseForm, setShowExpenseForm] = useState(false);

  const { data: award, isLoading: isLoadingAward, isError: isAwardError } = useQuery({
    queryKey: ['grantAward', grant.id],
    queryFn: () => client.entities.GrantAward.filter({ grant_id: grant.id }).then(res => res[0]),
    enabled: grant.status === 'awarded',
    retry: 1,
  });

  const { data: expenses = [], isLoading: isLoadingExpenses } = useQuery({
    queryKey: ['expenses', grant.id],
    queryFn: () => client.entities.Expense.filter({ grant_id: grant.id }),
    enabled: !!award?.id,
  });

  const createAwardMutation = useMutation({
    mutationFn: () => client.entities.GrantAward.create({
      grant_id: grant.id,
      organization_id: grant.organization_id,
      award_amount: 0, // Must be updated by user after receiving official award notice
      funder_name: grant.funder,
      start_date: grant.start_date || new Date().toISOString().split('T')[0],
      policy_json: JSON.stringify(defaultPolicy),
      reporting_cadence: 'quarterly',
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grantAward', grant.id] });
    },
    onError: (err) => {
      console.error('[ComplianceTab] Failed to create award record', err);
    },
  });

  if (grant.status !== 'awarded') {
    return (
      <div className="text-center py-10">
        <h3 className="text-lg font-medium text-slate-700">Compliance Tracking Not Active</h3>
        <p className="text-slate-500">Change the grant status to "Awarded" to activate post-award compliance tools.</p>
      </div>
    );
  }

  if (isLoadingAward) {
    return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }

  if (isAwardError) {
    return (
      <div className="text-center py-10 text-red-600">
        <h3 className="text-lg font-medium">Unable to Load Award Record</h3>
        <p className="text-sm mt-2">Could not retrieve the award for this grant. Please refresh or contact support before making changes.</p>
      </div>
    );
  }

  if (!award) {
    return (
      <div className="text-center py-10">
        <h3 className="text-lg font-medium text-slate-700">Activate Award</h3>
        <p className="text-slate-500 mb-4">Create an official award record to begin tracking.</p>
        <Button onClick={() => createAwardMutation.mutate()} disabled={createAwardMutation.isPending}>
          {createAwardMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlusCircle className="w-4 h-4 mr-2" />}
          Create Award Record
        </Button>
      </div>
    );
  }

  let policy = {};
try {
  policy = JSON.parse(award.policy_json || '{}');
} catch (e) {
  console.error('[ComplianceTab] Malformed policy_json for award', award.id, e);
  policy = { ...defaultPolicy, _parseError: true };
}
  const totalSpent = expenses.reduce((sum, ex) => sum + (parseFloat(ex.amount) || 0), 0);
  const awardAmount = parseFloat(award.award_amount) || 0;
const budgetRemaining = awardAmount - totalSpent;

  return (
    <div className="space-y-6">
      {policy._parseError && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="shrink-0">⚠️</span>
          <span>Using default compliance policy — custom policy could not be loaded.</span>
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Award Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div><span className="font-semibold">Total Award:</span> ${awardAmount.toLocaleString()}</div>
          <div><span className="font-semibold">Total Spent:</span> ${totalSpent.toLocaleString()}</div>
          <div className={budgetRemaining < 0 ? 'text-red-600 font-bold' : ''}>
  <span className="font-semibold">Remaining:</span> ${budgetRemaining.toLocaleString()}
  {budgetRemaining < 0 && <span className="ml-2 text-xs">(OVER BUDGET)</span>}
</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row justify-between items-center">
            <CardTitle>Spend Log</CardTitle>
            <Button onClick={() => setShowExpenseForm(true)}>Log Expense</Button>
        </CardHeader>
        <CardContent>
            {showExpenseForm && (
                <AddExpenseForm
                    grantId={grant.id}
                    organizationId={grant.organization_id}
                    onSave={() => {
                        setShowExpenseForm(false);
                        queryClient.invalidateQueries({ queryKey: ['expenses', grant.id] });
                    }}
                    onCancel={() => setShowExpenseForm(false)}
                />
            )}
            {isLoadingExpenses ? <Loader2 className="w-6 h-6 animate-spin" /> : (
                expenses.length === 0 ? (
                    <p className="text-center text-slate-500 py-4">No expenses logged yet. Use "Log Expense" to record spend against this award.</p>
                ) : (
                    <ul className="space-y-2">
                        {expenses.map(ex => (
                            <li key={ex.id} className="flex justify-between p-2 border-b">
                                <span>{ex.date ? ex.date : '—'}: {ex.description || '(no description)'}{ex.category ? ` [${ex.category}]` : ''}</span>
                                <span>${(parseFloat(ex.amount) || 0).toLocaleString()}</span>
                            </li>
                        ))}
                    </ul>
                )
            )}
        </CardContent>
      </Card>
      
      <Card>
          <CardHeader>
              <CardTitle>Compliance Reports</CardTitle>
              <CardDescription>Generate and track financial and performance reports.</CardDescription>
          </CardHeader>
          <CardContent>
              <div className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <FileText className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
                  <div>
                    <p className="font-medium text-slate-900">Reports are managed in Reports & Analytics.</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Open the working report workspace to schedule, draft, and review compliance reports for this awarded grant.
                    </p>
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Link to={createPageUrl("Reports", { organization_id: grant.organization_id, grant_id: grant.id, schedule: "1" })}>
                    <Button className="w-full sm:w-auto">
                      <PlusCircle className="mr-2 h-4 w-4" />
                      Schedule Report
                    </Button>
                  </Link>
                  <Link to={createPageUrl("Reports", { organization_id: grant.organization_id })}>
                    <Button variant="outline" className="w-full sm:w-auto">
                      <FileText className="mr-2 h-4 w-4" />
                      Open Reports
                    </Button>
                  </Link>
                </div>
              </div>
          </CardContent>
      </Card>
    </div>
  );
}
