import React from "react";
import { ShieldCheck, Inbox } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuthContext } from "@/components/hooks/useAuthRLS";

// Custom hook
import { useStewardshipData } from "@/components/hooks/useStewardshipData";

// UI Components
import PageLoading from "@/components/ui/states/PageLoading";
import EmptyState from "@/components/ui/states/EmptyState";
import GrantKPIs from "@/components/stewardship/GrantKPIs";
import BurnRateCard from "@/components/stewardship/BurnRateCard";
import ComplianceFeed from "@/components/stewardship/ComplianceFeed";
import UpcomingMilestones from "@/components/stewardship/UpcomingMilestones";

export default function Stewardship() {
  // Central auth context
  const { user, isAdmin, isLoadingUser } = useAuthContext();

  // Gate hook on user presence
  const stewardshipHookEnabled = !!user?.email;

  const {
    grants,
    selectedGrant,
    selectGrant,
    filteredData,
    isLoading,
  } = useStewardshipData({
    user,
    isAdmin,
    enabled: stewardshipHookEnabled,
  });

  // Combined loading state
  if (isLoadingUser || isLoading) {
    return <PageLoading label="Loading Stewardship Data..." />;
  }

  // No awarded grants state
  if (!grants || grants.length === 0) {
    return (
      <div className="p-6 md:p-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-3">
            <ShieldCheck className="w-8 h-8 text-emerald-600" />
            Grant Stewardship
          </h1>
          <p className="text-slate-600 mt-2">
            Manage compliance, reporting, and budgets for your awarded grants.
          </p>
        </header>
        <EmptyState
          icon={Inbox}
          title="No Awarded Grants Found"
          description="Your awarded grants will appear here. Once a grant is moved to 'Awarded' in the pipeline, you can manage it from this dashboard."
        />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 space-y-8">
      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-3">
            <ShieldCheck className="w-8 h-8 text-emerald-600" />
            Grant Stewardship
          </h1>
          <p className="text-slate-600 mt-2">
            Manage compliance, reporting, and budgets for your awarded grants.
          </p>
        </div>
        <div className="w-full md:w-80">
          <Select 
            onValueChange={selectGrant} 
            value={selectedGrant?.id || ''}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select an awarded grant..." />
            </SelectTrigger>
            <SelectContent>
              {grants.map(grant => (
                <SelectItem key={grant.id} value={grant.id}>
                  {grant.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {/* Main Content */}
      {selectedGrant && filteredData ? (
        <div className="space-y-6">
          {/* KPI Grid */}
          <GrantKPIs
            grant={selectedGrant}
            budgetItems={filteredData.budgetItems}
            expenses={filteredData.expenses}
            reports={filteredData.reports}
          />

          {/* Charts and Feeds */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            <div className="lg:col-span-3">
              <BurnRateCard 
                budgetItems={filteredData.budgetItems} 
                expenses={filteredData.expenses} 
              />
            </div>
            <div className="lg:col-span-2 space-y-6">
              <ComplianceFeed reports={filteredData.reports} />
              <UpcomingMilestones milestones={filteredData.milestones} />
            </div>
          </div>
        </div>
      ) : (
        <div className="text-center py-10">
          <p className="text-slate-500">
            Please select a grant to view its stewardship details.
          </p>
        </div>
      )}
    </div>
  );
}