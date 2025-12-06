import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useAuthContext } from '@/components/hooks/useAuthRLS';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  FileText,
  Calendar as CalendarIcon,
  AlertCircle,
  Loader2,
  Sparkles,
  BarChart3,
  Target,
  Clock,
  TrendingUp
} from 'lucide-react';
import KPIManager from '@/components/reporting/KPIManager';
import ReportGenerator from '@/components/reporting/ReportGenerator';
import ReportRequirements from '@/components/reporting/ReportRequirements';
import OutcomesAnalysis from '@/components/reporting/OutcomesAnalysis';

export default function GrantReporting() {
  const [selectedGrant, setSelectedGrant] = useState(null);

  // Centralized auth (RLS-aware)
  const { user, isAdmin, isLoadingUser } = useAuthContext();

  // Active grants (awarded/submitted/in_progress), RLS-aware
  const { data: grants = [], isLoading: grantsLoading } = useQuery({
    queryKey: ['activeGrants', user?.email, isAdmin],
    queryFn: async () => {
      const filter = {
        $or: [{ status: 'awarded' }, { status: 'submitted' }, { status: 'in_progress' }],
        ...(isAdmin ? {} : { created_by: user?.email }),
      };
      return (await base44.entities.Grant.filter(filter)) || [];
    },
    enabled: !!user?.email,
  });

  // Compliance reports (all), RLS-aware, client-side sort (newest first)
  const { data: allReportsRaw = [] } = useQuery({
    queryKey: ['allReports', user?.email, isAdmin],
    queryFn: async () => {
      if (isAdmin) return (await base44.entities.ComplianceReport.list()) || [];
      return (await base44.entities.ComplianceReport.filter({ created_by: user?.email })) || [];
    },
    enabled: !!user?.email,
  });

  // Report requirements (pending/in_progress), RLS-aware, client-side sort by due_date asc
  const { data: allRequirementsRaw = [] } = useQuery({
    queryKey: ['allRequirements', user?.email, isAdmin],
    queryFn: async () => {
      const baseFilter = { $or: [{ status: 'pending' }, { status: 'in_progress' }] };
      if (isAdmin) return (await base44.entities.ReportRequirement.filter(baseFilter)) || [];
      return (await base44.entities.ReportRequirement.filter({ ...baseFilter, created_by: user?.email })) || [];
    },
    enabled: !!user?.email,
  });

  // KPIs, RLS-aware
  const { data: allKPIs = [] } = useQuery({
    queryKey: ['allKPIs', user?.email, isAdmin],
    queryFn: async () => {
      if (isAdmin) return (await base44.entities.GrantKPI.list()) || [];
      return (await base44.entities.GrantKPI.filter({ created_by: user?.email })) || [];
    },
    enabled: !!user?.email,
  });

  // Stable arrays + client-side sorts
  const safeGrants = useMemo(() => grants, [grants]);

  const allReports = useMemo(() => {
    return [...allReportsRaw].sort((a, b) => {
      const da = new Date(a?.created_at ?? a?.created_date ?? 0).getTime();
      const db = new Date(b?.created_at ?? b?.created_date ?? 0).getTime();
      return db - da; // newest first
    });
  }, [allReportsRaw]);

  const allRequirements = useMemo(() => {
    return [...allRequirementsRaw].sort((a, b) => {
      const da = new Date(a?.due_date ?? 0).getTime();
      const db = new Date(b?.due_date ?? 0).getTime();
      return da - db; // earliest first
    });
  }, [allRequirementsRaw]);

  // Reset selectedGrant if removed from list
  useEffect(() => {
    if (selectedGrant && !safeGrants.find(g => g.id === selectedGrant.id)) {
      setSelectedGrant(null);
    }
  }, [safeGrants, selectedGrant]);

  // Dashboard stats
  const upcomingReports = useMemo(() => {
    const now = new Date();
    return allRequirements.filter(req => {
      const due = req?.due_date ? new Date(req.due_date) : null;
      if (!due || isNaN(due.getTime())) return false;
      const days = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return days <= 30 && days >= 0;
    });
  }, [allRequirements]);

  const overdueReports = useMemo(() => {
    const now = new Date();
    return allRequirements.filter(req => {
      const due = req?.due_date ? new Date(req.due_date) : null;
      if (!due || isNaN(due.getTime())) return false;
      return due < now && req?.status !== 'submitted';
    });
  }, [allRequirements]);

  const kpisAtRisk = useMemo(
    () => allKPIs.filter((k) => k?.status === 'at_risk' || k?.status === 'behind'),
    [allKPIs]
  );

  // Loading
  if (isLoadingUser || grantsLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <FileText className="w-8 h-8 text-blue-600" />
            Grant Reporting & Performance
          </h1>
          <p className="text-slate-600 mt-1">
            AI-powered progress reports, KPI tracking, and outcome analysis
          </p>
        </div>

        {/* Dashboard Stats */}
        <div className="grid md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Active Grants</p>
                  <p className="text-3xl font-bold text-slate-900">{safeGrants.length}</p>
                </div>
                <Target className="w-10 h-10 text-blue-600 opacity-20" />
              </div>
            </CardContent>
          </Card>

          <Card className={upcomingReports.length > 0 ? 'border-orange-300 bg-orange-50' : ''}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Due in 30 Days</p>
                  <p className="text-3xl font-bold text-orange-700">{upcomingReports.length}</p>
                </div>
                <Clock className="w-10 h-10 text-orange-600 opacity-20" />
              </div>
            </CardContent>
          </Card>

          <Card className={overdueReports.length > 0 ? 'border-red-300 bg-red-50' : ''}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">Overdue Reports</p>
                  <p className="text-3xl font-bold text-red-700">{overdueReports.length}</p>
                </div>
                <AlertCircle className="w-10 h-10 text-red-600 opacity-20" />
              </div>
            </CardContent>
          </Card>

          <Card className={kpisAtRisk.length > 0 ? 'border-amber-300 bg-amber-50' : ''}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600">KPIs At Risk</p>
                  <p className="text-3xl font-bold text-amber-700">{kpisAtRisk.length}</p>
                </div>
                <TrendingUp className="w-10 h-10 text-amber-600 opacity-20" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main Content */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Grant Selection Sidebar */}
          <div className="lg:col-span-1">
            <Card>
              <CardHeader>
                <CardTitle>Select Grant</CardTitle>
                <CardDescription>Choose a grant to manage reports and KPIs</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {safeGrants.map((grant) => (
                    <button
                      key={grant.id}
                      onClick={() => setSelectedGrant(grant)}
                      className={`w-full p-3 rounded-lg border-2 text-left transition-all ${
                        selectedGrant?.id === grant.id
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <p className="font-semibold text-slate-900 truncate">{grant.title}</p>
                      <p className="text-xs text-slate-600 mt-1">{grant.funder}</p>
                      <Badge variant="outline" className="mt-2 text-xs">
                        {grant.status}
                      </Badge>
                    </button>
                  ))}

                  {safeGrants.length === 0 && (
                    <div className="text-center py-8">
                      <p className="text-slate-500 text-sm">No active grants</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Grant Details and Tools */}
          <div className="lg:col-span-2">
            {selectedGrant ? (
              <Tabs defaultValue="generate" key={selectedGrant?.id} className="space-y-4">
                <TabsList className="grid w-full grid-cols-4">
                  <TabsTrigger value="generate">
                    <Sparkles className="w-4 h-4 mr-2" />
                    Generate
                  </TabsTrigger>
                  <TabsTrigger value="kpis">
                    <Target className="w-4 h-4 mr-2" />
                    KPIs
                  </TabsTrigger>
                  <TabsTrigger value="requirements">
                    <CalendarIcon className="w-4 h-4 mr-2" />
                    Requirements
                  </TabsTrigger>
                  <TabsTrigger value="analysis">
                    <BarChart3 className="w-4 h-4 mr-2" />
                    Analysis
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="generate">
                  <ReportGenerator grant={selectedGrant} />
                </TabsContent>

                <TabsContent value="kpis">
                  <KPIManager grant={selectedGrant} />
                </TabsContent>

                <TabsContent value="requirements">
                  <ReportRequirements grant={selectedGrant} />
                </TabsContent>

                <TabsContent value="analysis">
                  <OutcomesAnalysis grant={selectedGrant} />
                </TabsContent>
              </Tabs>
            ) : (
              <Card>
                <CardContent className="p-12 text-center">
                  <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <p className="text-slate-500">Select a grant to get started</p>
                  <p className="text-sm text-slate-400 mt-2">
                    Choose a grant from the left to generate reports, track KPIs, and analyze outcomes
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}