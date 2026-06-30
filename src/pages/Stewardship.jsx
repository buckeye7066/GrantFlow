import React, { useState, useMemo, useEffect } from "react";
import client from '@/api/client';
import { useQuery } from "@tanstack/react-query";
import { Loader2, ShieldCheck, Inbox, DollarSign, CalendarCheck, BarChart3 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import KPIWidget from "../components/stewardship/KPIWidget";
import BurnRateCard from "../components/stewardship/BurnRateCard";
import ComplianceFeed from "../components/stewardship/ComplianceFeed";
import UpcomingMilestones from "../components/stewardship/UpcomingMilestones";

const PageLoading = () => (
    <div className="flex items-center justify-center h-screen">
        <div className="text-center">
            <Loader2 className="w-12 h-12 animate-spin text-slate-400" />
            <p className="mt-4 text-slate-600">Loading Stewardship Data...</p>
        </div>
    </div>
);

const EmptyState = () => (
    <div className="text-center py-20 px-6 bg-slate-50 rounded-lg">
        <Inbox className="w-16 h-16 mx-auto text-slate-400" />
        <h3 className="mt-4 text-xl font-semibold text-slate-800">No Awarded Grants Found</h3>
        <p className="mt-2 text-slate-500">Your awarded grants will appear here. Once a grant is moved to "Awarded" in the pipeline, you can manage it from this dashboard.</p>
    </div>
);

export default function Stewardship() {
    const [selectedGrantId, setSelectedGrantId] = useState(null);

    const { data, isLoading } = useQuery({
        queryKey: ['stewardshipData'],
        queryFn: async () => {
            const [grants, milestones, reports, budgets, expenses] = await Promise.all([
                client.entities.Grant.filter({ status: 'awarded' }),
                client.entities.Milestone.list(),
                client.entities.ComplianceReport.list(),
                client.entities.Budget.list(),
                client.entities.Expense.list(),
            ]);
            return { grants, milestones, reports, budgets, expenses };
        }
    });

    const selectedGrant = useMemo(() => {
        if (!data || !selectedGrantId) return null;
        return data.grants.find(g => g.id === selectedGrantId);
    }, [data, selectedGrantId]);
    
    // Set the first grant as selected by default
    useEffect(() => {
      if (data?.grants?.length > 0 && !selectedGrantId) {
        setSelectedGrantId(data.grants[0].id);
      }
    }, [data, selectedGrantId]);

    const filteredData = useMemo(() => {
        if (!selectedGrant) return null;
        return {
            milestones: data.milestones.filter(m => m.grant_id === selectedGrant.id),
            reports: data.reports.filter(r => r.grant_id === selectedGrant.id),
            budgetItems: data.budgets.filter(b => b.grant_id === selectedGrant.id),
            expenses: data.expenses.filter(e => e.grant_id === selectedGrant.id),
        };
    }, [selectedGrant, data]);

    if (isLoading) return <PageLoading />;
    
    if (!data || data.grants.length === 0) {
        return (
            <div className="p-6 md:p-8">
                 <header className="mb-8">
                    <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-3"><ShieldCheck className="w-8 h-8 text-emerald-600" />Grant Stewardship</h1>
                    <p className="text-slate-600 mt-2">Manage compliance, reporting, and budgets for your awarded grants.</p>
                </header>
                <EmptyState />
            </div>
        );
    }

    return (
        <div className="p-6 md:p-8 space-y-8">
            <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-3"><ShieldCheck className="w-8 h-8 text-emerald-600" />Grant Stewardship</h1>
                    <p className="text-slate-600 mt-2">Manage compliance, reporting, and budgets for your awarded grants.</p>
                </div>
                <div className="w-full md:w-80">
                    <Select onValueChange={setSelectedGrantId} value={selectedGrantId}>
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select an awarded grant..." />
                        </SelectTrigger>
                        <SelectContent>
                            {data.grants.map(grant => (
                                <SelectItem key={grant.id} value={grant.id}>{grant.title}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </header>

            {selectedGrant && filteredData ? (
                 <div className="space-y-6">
                    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                        <KPIWidget icon={DollarSign} title="Award Amount" value={`$${(selectedGrant.amount_max || 0).toLocaleString()}`} />
                        <KPIWidget icon={CalendarCheck} title="Days Left in Period" value={selectedGrant.end_date ? `${(Math.max(0, new Date(selectedGrant.end_date).getTime() - new Date().getTime()) / (1000 * 3600 * 24)).toFixed(0)}` : 'N/A'} />
                        <KPIWidget icon={BarChart3} title="Burn Rate" value={(() => { const totalBudget = filteredData.budgets.reduce((s, b) => s + (b.total || 0), 0); const totalExpenses = filteredData.expenses.reduce((s, e) => s + (e.amount || 0), 0); const pct = totalBudget > 0 ? ((totalExpenses / totalBudget) * 100).toFixed(1) : '0.0'; return `${pct}%`; })()} />
                        <KPIWidget icon={ShieldCheck} title="Next Report Due" value={(() => { const upcoming = filteredData.reports.filter(r => r.due_date && new Date(r.due_date) >= new Date()).sort((a, b) => new Date(a.due_date) - new Date(b.due_date)); return upcoming.length > 0 ? new Date(upcoming[0].due_date).toLocaleDateString() : 'None'; })()} />
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                        <div className="lg:col-span-3">
                            <BurnRateCard budgetItems={filteredData.budgetItems} expenses={filteredData.expenses} />
                        </div>
                        <div className="lg:col-span-2 space-y-6">
                             <ComplianceFeed reports={filteredData.reports} />
                             <UpcomingMilestones milestones={filteredData.milestones} />
                        </div>
                    </div>
                </div>
            ) : (
                <div className="text-center py-10">
                    <p className="text-slate-500">Please select a grant to view its stewardship details.</p>
                </div>
            )}
        </div>
    );
}