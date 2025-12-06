import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { useAuthContext } from '@/components/hooks/useAuthRLS';
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  Plus, 
  Search, 
  Users, 
  TrendingUp, 
  Clock,
  CheckCircle2,
  Mail,
  Phone,
  Building2,
  Loader2
} from "lucide-react";

const STATUS_COLORS = {
  new: "bg-blue-100 text-blue-800",
  contacted: "bg-purple-100 text-purple-800",
  qualified: "bg-green-100 text-green-800",
  proposal_sent: "bg-yellow-100 text-yellow-800",
  negotiation: "bg-orange-100 text-orange-800",
  won: "bg-emerald-100 text-emerald-800",
  lost: "bg-red-100 text-red-800"
};

const PRIORITY_COLORS = {
  low: "bg-slate-100 text-slate-600",
  medium: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700"
};

export default function Leads() {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [assignedFilter, setAssignedFilter] = useState("all");

  // M5 FIX: Use centralized auth context instead of duplicate query
  const { user, isLoadingUser } = useAuthContext();

  useEffect(() => {
    if (user?.email) {
      base44.functions.invoke("autoCreateLead", { user });
    }
  }, [user]);

  // H7 FIX: Added user context to query keys and enabled guards
  const { data: leads = [], isLoading } = useQuery({
    queryKey: ['leads', user?.email],
    queryFn: () => base44.functions.invoke("getLeads", {}).then(r => r.data || []),
    enabled: !!user?.email,
  });

  const { data: activities = [] } = useQuery({
    queryKey: ['activities', user?.email],
    queryFn: () => base44.functions.invoke("getActivities", {}).then(r => r.data || []),
    enabled: !!user?.email,
  });

  const filteredLeads = useMemo(() => {
    if (!Array.isArray(leads)) return [];
    return leads.filter(lead => {
      const s = searchTerm.toLowerCase();
      const matchesSearch =
        (lead.first_name ?? "").toLowerCase().includes(s) ||
        (lead.last_name ?? "").toLowerCase().includes(s) ||
        (lead.organization_name ?? "").toLowerCase().includes(s) ||
        (lead.email ?? "").toLowerCase().includes(s);
      
      const matchesStatus = statusFilter === "all" || lead.status === statusFilter;
      const matchesAssigned = assignedFilter === "all" || lead.assigned_to === assignedFilter;

      return matchesSearch && matchesStatus && matchesAssigned;
    });
  }, [leads, searchTerm, statusFilter, assignedFilter]);

  const assignedReps = useMemo(() => {
    const reps = new Set();
    leads.forEach(lead => {
      if (lead.assigned_to) reps.add(lead.assigned_to);
    });
    return Array.from(reps);
  }, [leads]);

  const stats = useMemo(() => {
    return {
      total: leads.length,
      new: leads.filter(l => l.status === 'new').length,
      qualified: leads.filter(l => l.status === 'qualified').length,
      won: leads.filter(l => l.status === 'won').length,
    };
  }, [leads]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Leads & CRM</h1>
            <p className="text-slate-600 mt-2">Track and manage your sales pipeline</p>
          </div>
          <Button 
            onClick={() => navigate(createPageUrl('LeadDetail?new=true'))}
            className="bg-blue-600 hover:bg-blue-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            New Lead
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Users className="w-8 h-8 text-blue-600" />
                <div>
                  <p className="text-2xl font-bold text-slate-900">{stats.total}</p>
                  <p className="text-sm text-slate-600">Total Leads</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Clock className="w-8 h-8 text-purple-600" />
                <div>
                  <p className="text-2xl font-bold text-slate-900">{stats.new}</p>
                  <p className="text-sm text-slate-600">New Leads</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <TrendingUp className="w-8 h-8 text-green-600" />
                <div>
                  <p className="text-2xl font-bold text-slate-900">{stats.qualified}</p>
                  <p className="text-sm text-slate-600">Qualified</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-8 h-8 text-emerald-600" />
                <div>
                  <p className="text-2xl font-bold text-slate-900">{stats.won}</p>
                  <p className="text-sm text-slate-600">Won</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search leads..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full md:w-[200px]">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="contacted">Contacted</SelectItem>
              <SelectItem value="qualified">Qualified</SelectItem>
              <SelectItem value="proposal_sent">Proposal Sent</SelectItem>
              <SelectItem value="negotiation">Negotiation</SelectItem>
              <SelectItem value="won">Won</SelectItem>
              <SelectItem value="lost">Lost</SelectItem>
            </SelectContent>
          </Select>

          <Select value={assignedFilter} onValueChange={setAssignedFilter}>
            <SelectTrigger className="w-full md:w-[200px]">
              <SelectValue placeholder="All Reps" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Reps</SelectItem>
              {assignedReps.map(rep => (
                <SelectItem key={rep} value={rep ?? "unassigned"}>
                  {rep ?? "Unassigned"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Leads Grid */}
        {filteredLeads.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Users className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Leads Found</h3>
              <p className="text-slate-600 mb-4">
                {searchTerm || statusFilter !== "all" || assignedFilter !== "all"
                  ? "Try adjusting your filters"
                  : "Create your first lead to get started"}
              </p>
              <Button onClick={() => navigate(createPageUrl('LeadDetail?new=true'))}>
                <Plus className="w-4 h-4 mr-2" />
                Create Lead
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredLeads.map(lead => {
              const leadActivities = activities.filter(a => a.lead_id === lead.id);
              const upcomingActivities = leadActivities.filter(a => !a.completed).length;

              return (
                <Card 
                  key={lead.id}
                  className="hover:shadow-lg transition-shadow cursor-pointer"
                  onClick={() => navigate(createPageUrl(`LeadDetail?id=${lead.id}`))}
                >
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <CardTitle className="text-lg mb-2">
                          {lead.first_name} {lead.last_name}
                        </CardTitle>
                        {lead.organization_name && (
                          <p className="text-sm text-slate-600 flex items-center gap-2">
                            <Building2 className="w-4 h-4" />
                            {lead.organization_name}
                          </p>
                        )}
                      </div>
                      <Badge className={STATUS_COLORS[lead.status ?? "new"]}>
                        {(lead.status ?? "new").replace(/_/g, ' ')}
                      </Badge>
                    </div>
                  </CardHeader>

                  <CardContent>
                    <div className="space-y-3">
                      {lead.email && (
                        <div className="flex items-center gap-2 text-sm text-slate-600">
                          <Mail className="w-4 h-4" />
                          {lead.email}
                        </div>
                      )}
                      
                      {lead.phone && (
                        <div className="flex items-center gap-2 text-sm text-slate-600">
                          <Phone className="w-4 h-4" />
                          {lead.phone}
                        </div>
                      )}

                      <div className="flex items-center justify-between pt-3 border-t">
                        <div className="flex items-center gap-2">
                          {lead.priority && (
                            <Badge variant="outline" className={PRIORITY_COLORS[lead.priority]}>
                              {lead.priority}
                            </Badge>
                          )}
                          {lead.lead_source && (
                            <Badge variant="outline" className="text-xs">
                              {lead.lead_source}
                            </Badge>
                          )}
                        </div>
                        
                        {upcomingActivities > 0 && (
                          <Badge variant="outline" className="bg-blue-50 text-blue-700">
                            {upcomingActivities} pending
                          </Badge>
                        )}
                      </div>

                      {lead.assigned_to && (
                        <p className="text-xs text-slate-500">
                          Assigned to: {lead.assigned_to}
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}