import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Loader2, PlusCircle, FileText } from 'lucide-react';
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

  const { data: award, isLoading: isLoadingAward } = useQuery({
    queryKey: ['grantAward', grant.id],
    queryFn: () => base44.entities.GrantAward.filter({ grant_id: grant.id }).then(res => res[0]),
    enabled: grant.status === 'awarded',
  });

  const { data: expenses = [], isLoading: isLoadingExpenses } = useQuery({
    queryKey: ['expenses', grant.id],
    queryFn: () => base44.entities.Expense.filter({ grant_id: grant.id }),
    enabled: !!award,
  });

  const createAwardMutation = useMutation({
    mutationFn: () => base44.entities.GrantAward.create({
      grant_id: grant.id,
      organization_id: grant.organization_id,
      award_amount: grant.typical_award || grant.award_ceiling || 0,
      funder_name: grant.funder,
      start_date: new Date().toISOString().split('T')[0],
      policy_json: JSON.stringify(defaultPolicy),
      reporting_cadence: 'quarterly',
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['grantAward', grant.id] });
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

  const policy = JSON.parse(award.policy_json || '{}');
  const totalSpent = expenses.reduce((sum, ex) => sum + ex.amount, 0);
  const budgetRemaining = award.award_amount - totalSpent;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Award Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div><span className="font-semibold">Total Award:</span> ${award.award_amount.toLocaleString()}</div>
          <div><span className="font-semibold">Total Spent:</span> ${totalSpent.toLocaleString()}</div>
          <div><span className="font-semibold">Remaining:</span> ${budgetRemaining.toLocaleString()}</div>
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
                <ul className="space-y-2">
                    {expenses.map(ex => (
                        <li key={ex.id} className="flex justify-between p-2 border-b">
                            <span>{ex.date}: {ex.description}</span>
                            <span>${ex.amount.toLocaleString()}</span>
                        </li>
                    ))}
                </ul>
            )}
        </CardContent>
      </Card>
      
      <Card>
          <CardHeader>
              <CardTitle>Compliance Reports</CardTitle>
              <CardDescription>Generate and track financial and performance reports.</CardDescription>
          </CardHeader>
          <CardContent>
              {/* Placeholder for report list and generation button */}
              <div className="text-center text-slate-500 py-6">
                <FileText className="mx-auto w-8 h-8 mb-2"/>
                <p>Report generation coming soon.</p>
              </div>
          </CardContent>
      </Card>
    </div>
  );
}