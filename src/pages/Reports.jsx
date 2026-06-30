
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import client from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell, Funnel, FunnelChart, LabelList } from 'recharts';
import { Loader2, Filter, TrendingUp, Target, Award, Banknote, Percent, FileText, Plus, Calendar, Clock, AlertTriangle } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { groupBy, countBy, sumBy } from "lodash";
import { format, subMonths, isPast, differenceInDays } from 'date-fns';
import { canonicalStage, isActiveStage } from '../../shared/pipelineStages.js';
import { useToast } from "@/components/ui/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d'];

const pipelineStages = [
  { status: 'discovered', label: 'Discovered' },
  { status: 'interested', label: 'Interested' },
  { status: 'drafting', label: 'Drafting' },
  { status: 'submitted', label: 'Submitted' },
  { status: 'awarded', label: 'Awarded' },
];

const StatCard = ({ title, value, icon: Icon, color, subtitle }) => (
  <Card className="shadow-lg border-0">
    <CardContent className="p-6">
      <div className="flex justify-between items-start">
        <div>
          <p className={`text-sm font-medium ${color}`}>{title}</p>
          <p className="text-3xl font-bold text-slate-900 mt-2">{typeof value === 'number' ? value.toLocaleString() : value}</p>
          {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
        </div>
        <div className="p-3 bg-slate-100 rounded-xl">
          <Icon className={`w-6 h-6 ${color}`} />
        </div>
      </div>
    </CardContent>
  </Card>
);

export default function Reports() {
  const location = useLocation();
  const urlIntent = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return {
      organizationId: params.get('organization_id') || 'all',
      grantId: params.get('grant_id') || '',
      schedule: params.get('schedule') === '1',
    };
  }, [location.search]);
  const [selectedOrgId, setSelectedOrgId] = useState(urlIntent.organizationId);
  const [showCreateReport, setShowCreateReport] = useState(false);
  const [newReportData, setNewReportData] = useState({
    grant_id: '',
    report_type: 'quarterly',
    report_period_start: '',
    report_period_end: '',
    due_date: '',
  });
  const appliedUrlIntentRef = useRef(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: grants = [] } = useQuery({
    queryKey: ['grants'],
    queryFn: () => client.entities.Grant.list(),
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => client.entities.Organization.list(),
  });

  const { data: complianceReports = [] } = useQuery({
    queryKey: ['complianceReports'],
    queryFn: () => client.entities.ComplianceReport.list('-due_date'),
  });
  
  const { data: budgetItems = [] } = useQuery({
    queryKey: ['budgets'],
    queryFn: () => client.entities.Budget.list(),
  });

  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses'],
    queryFn: () => client.entities.Expense.list(),
  });

  useEffect(() => {
    setSelectedOrgId(urlIntent.organizationId || "all");
  }, [urlIntent.organizationId]);

  useEffect(() => {
    if (appliedUrlIntentRef.current || !urlIntent.grantId || grants.length === 0) return;
    const grant = grants.find(g => g.id === urlIntent.grantId);
    if (!grant) return;
    appliedUrlIntentRef.current = true;
    setSelectedOrgId(grant.organization_id || urlIntent.organizationId || "all");
    setNewReportData((prev) => ({
      ...prev,
      grant_id: grant.id,
    }));
    if (urlIntent.schedule) setShowCreateReport(true);
  }, [grants, urlIntent.grantId, urlIntent.organizationId, urlIntent.schedule]);

  const createReportMutation = useMutation({
    mutationFn: (data) => client.entities.ComplianceReport.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['complianceReports'] });
      setShowCreateReport(false);
      setNewReportData({
        grant_id: '',
        report_type: 'quarterly',
        report_period_start: '',
        report_period_end: '',
        due_date: '',
      });
      toast({
        title: "Report Scheduled",
        description: "New compliance report has been added to your calendar.",
      });
    },
  });

  const handleCreateReport = () => {
    const grant = grants.find(g => g.id === newReportData.grant_id);
    if (!grant) {
      toast({
        title: "Grant Not Found",
        description: "The selected grant could not be found. Please re-select and try again.",
        variant: "destructive",
      });
      return;
    }

    if (
      newReportData.report_period_start &&
      newReportData.report_period_end &&
      new Date(newReportData.report_period_end) < new Date(newReportData.report_period_start)
    ) {
      toast({
        title: "Invalid Period",
        description: "Report period end date must be on or after the start date.",
        variant: "destructive",
      });
      return;
    }

    createReportMutation.mutate({
      ...newReportData,
      organization_id: grant.organization_id,
      status: 'scheduled'
    });
  };

  // Helper to validate date
  const isValidDate = (dateString) => {
    if (!dateString) return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
  };

  const filteredGrants = selectedOrgId === "all" ? grants : grants.filter(g => g.organization_id === selectedOrgId);
  const awardedGrants = filteredGrants.filter(g => canonicalStage(g.status) === 'awarded');

  // Analytics calculations.
  // IMPORTANT: bucket by CANONICAL stage (same normalization the Pipeline
  // Kanban uses via canonicalStage). Legacy statuses such as `auto_applied`,
  // `pending_review`, `under_review` all roll up to `submitted`; without this
  // the literal-status counts read 0 even when the Pipeline shows dozens of
  // submitted grants. (shared/pipelineStages.js)
  const grantsByStatus = countBy(filteredGrants, g => canonicalStage(g.status) || 'other');
  const funnelData = pipelineStages.map(stage => ({
    name: stage.label,
    value: grantsByStatus[stage.status] || 0,
    fill: COLORS[pipelineStages.indexOf(stage) % COLORS.length]
  }));

  const submittedCount = (grantsByStatus['submitted'] || 0) + (grantsByStatus['awarded'] || 0) + (grantsByStatus['declined'] || 0);
  const successRate = submittedCount > 0 ? (grantsByStatus['awarded'] || 0) / submittedCount * 100 : 0;
  // amount_awarded is the canonical money column (schema); keep amount_max as a
  // fallback for rows that recorded a ceiling but no settled award amount.
  const totalAwarded = sumBy(awardedGrants, g => g.amount_awarded || g.amount_max || 0);

  const fundingByFunderType = Object.entries(groupBy(awardedGrants, g => g.funder_type || g.funding_source_type))
    .filter(([name]) => name && name !== 'undefined' && name !== 'null')
    .map(([name, grantGroup]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      value: sumBy(grantGroup, g => g.amount_awarded || g.amount_max || 0)
    }))
    .filter(d => d.value > 0);

  const stats = [
    { title: "Total Awarded", value: totalAwarded, icon: Award, color: "text-emerald-600", subtitle: "From recorded award outcomes" },
    { title: "Grants Submitted", value: submittedCount, icon: Target, color: "text-blue-600", subtitle: "Submitted, awarded or declined" },
    { title: "Success Rate", value: `${successRate.toFixed(1)}%`, icon: Percent, color: "text-purple-600", subtitle: "Awarded ÷ decided applications" },
    { title: "Active Grants", value: filteredGrants.filter(g => isActiveStage(g.status)).length, icon: TrendingUp, color: "text-amber-600", subtitle: "In-progress pipeline stages" },
  ];

  // Filter compliance reports by selected org
  const filteredReports = selectedOrgId === "all" 
    ? complianceReports 
    : complianceReports.filter(r => r.organization_id === selectedOrgId);

  // Categorize reports - with proper date validation
  const allUpcomingReports = filteredReports.filter(r => {
    if (!['scheduled', 'draft'].includes(r.status)) return false;
    if (!isValidDate(r.due_date)) return false;
    return new Date(r.due_date) >= new Date();
  });
  const upcomingReports = allUpcomingReports.slice(0, 5);
  const hasMoreUpcoming = allUpcomingReports.length > 5;

  const overdueReports = filteredReports.filter(r => {
    if (!['scheduled', 'draft'].includes(r.status)) return false;
    if (!isValidDate(r.due_date)) return false;
    return new Date(r.due_date) < new Date();
  });

  const getStatusBadge = (status) => {
    const statusMap = {
      scheduled: 'bg-slate-100 text-slate-700',
      draft: 'bg-blue-100 text-blue-700',
      pending_review: 'bg-yellow-100 text-yellow-700',
      approved: 'bg-green-100 text-green-700',
      submitted: 'bg-indigo-100 text-indigo-700',
      accepted: 'bg-emerald-100 text-emerald-700',
      revision_needed: 'bg-orange-100 text-orange-700',
    };
    return <Badge className={statusMap[status] || 'bg-gray-100'}>{status.replace(/_/g, ' ')}</Badge>;
  };

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
            <div>
                <h1 className="text-3xl font-bold text-slate-900">Reports & Analytics</h1>
                <p className="text-slate-600 mt-2">Track performance metrics and manage compliance reporting.</p>
            </div>
            <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-slate-500" />
                <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder="Filter by profile..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Organizations</SelectItem>
                    {organizations.map(org => (
                      <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={() => setShowCreateReport(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Schedule Report
                </Button>
            </div>
        </div>

        {/* Performance Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {stats.map(stat => (
            <StatCard key={stat.title} {...stat} />
          ))}
        </div>

        {/* Compliance Reports Section */}
        <div className="grid lg:grid-cols-3 gap-6 mb-8">
          {/* Overdue Reports Alert */}
          {overdueReports.length > 0 && (
            <Card className="lg:col-span-3 border-l-4 border-l-red-500 bg-red-50 shadow-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-red-800">
                  <AlertTriangle className="w-5 h-5" />
                  {overdueReports.length} Overdue Report{overdueReports.length > 1 ? 's' : ''}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {overdueReports.map(report => {
                    const grant = grants.find(g => g.id === report.grant_id);
                    const daysOverdue = isValidDate(report.due_date) ? Math.abs(differenceInDays(new Date(), new Date(report.due_date))) : null;
                    return (
                      <div key={report.id} className="flex items-center justify-between p-3 bg-white rounded-lg">
                        <div className="flex-1">
                          <p className="font-semibold text-slate-900">{grant?.title || 'Unknown Grant'}</p>
                          <p className="text-sm text-slate-600">
                            {report.report_type} • Due: {isValidDate(report.due_date) ? format(new Date(report.due_date), 'MMM d, yyyy') : 'TBD'}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          {daysOverdue !== null && <Badge variant="destructive">{daysOverdue} days overdue</Badge>}
                          <Link to={createPageUrl("ComplianceReportDetail", { id: report.id })}>
                            <Button size="sm">Review</Button>
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Upcoming Reports */}
          <Card className="shadow-lg border-0 lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="w-5 h-5 text-blue-600" />
                Upcoming Reports
              </CardTitle>
            </CardHeader>
            <CardContent>
              {upcomingReports.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-6">No upcoming reports scheduled</p>
              ) : (
                <div className="space-y-3">
                  {upcomingReports.map(report => {
                    const grant = grants.find(g => g.id === report.grant_id);
                    const daysUntilDue = isValidDate(report.due_date) 
                      ? differenceInDays(new Date(report.due_date), new Date())
                      : null;
                    return (
                      <div key={report.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors">
                        <div className="flex-1">
                          <p className="font-medium text-slate-900">{grant?.title || 'Unknown Grant'}</p>
                          <p className="text-sm text-slate-600">
                            {report.report_type} • Due: {isValidDate(report.due_date) ? format(new Date(report.due_date), 'MMM d, yyyy') : 'TBD'}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          {getStatusBadge(report.status)}
                          {daysUntilDue !== null && daysUntilDue <= 7 && <Badge variant="destructive" className="bg-amber-500">{daysUntilDue}d</Badge>}
                          <Link to={createPageUrl("ComplianceReportDetail", { id: report.id })}>
                            <Button size="sm" variant="outline">
                              {report.status === 'draft' ? 'Continue' : 'Start'}
                            </Button>
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quick Stats */}
          <Card className="shadow-lg border-0">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-purple-600" />
                Report Stats
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-600">Total Scheduled</span>
                <span className="font-bold text-slate-900">{filteredReports.filter(r => r.status === 'scheduled').length}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-600">In Draft</span>
                <span className="font-bold text-slate-900">{filteredReports.filter(r => r.status === 'draft').length}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-600">Submitted</span>
                <span className="font-bold text-slate-900">{filteredReports.filter(r => r.status === 'submitted').length}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-600">Accepted</span>
                <span className="font-bold text-emerald-600">{filteredReports.filter(r => r.status === 'accepted').length}</span>
              </div>
              <div className="flex justify-between items-center pt-3 border-t">
                <span className="text-sm font-semibold text-slate-700">Overdue</span>
                <span className="font-bold text-red-600">{overdueReports.length}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Analytics Charts */}
        <div className="grid lg:grid-cols-2 gap-6">
          <Card className="shadow-lg border-0">
            <CardHeader>
              <CardTitle>Grant Pipeline Funnel</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <FunnelChart>
                  <Tooltip />
                  <Funnel
                    dataKey="value"
                    data={funnelData}
                    isAnimationActive
                  >
                    <LabelList position="right" fill="#000" stroke="none" dataKey="name" />
                  </Funnel>
                </FunnelChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="shadow-lg border-0">
            <CardHeader>
              <CardTitle>Awarded Funds by Funder Type</CardTitle>
            </CardHeader>
            <CardContent>
              {fundingByFunderType.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={fundingByFunderType}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      outerRadius={100}
                      fill="#8884d8"
                      dataKey="value"
                      nameKey="name"
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    >
                      {fundingByFunderType.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value) => `$${value.toLocaleString()}`} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-center text-slate-500 py-20">No awarded grants yet</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Create Report Dialog */}
      <Dialog open={showCreateReport} onOpenChange={setShowCreateReport}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Schedule New Report</DialogTitle>
            <DialogDescription>
              Create a new compliance report for an awarded grant
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Grant</Label>
              <Select value={newReportData.grant_id} onValueChange={(value) => setNewReportData({...newReportData, grant_id: value})}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a grant..." />
                </SelectTrigger>
                <SelectContent>
                  {awardedGrants.map(grant => (
                    <SelectItem key={grant.id} value={grant.id}>{grant.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Report Type</Label>
              <Select value={newReportData.report_type} onValueChange={(value) => setNewReportData({...newReportData, report_type: value})}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="quarterly">Quarterly Progress</SelectItem>
                  <SelectItem value="annual">Annual Report</SelectItem>
                  <SelectItem value="financial">Financial Report</SelectItem>
                  <SelectItem value="progress">Progress Report</SelectItem>
                  <SelectItem value="impact">Impact Report</SelectItem>
                  <SelectItem value="final">Final Report</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Period Start</Label>
                <Input
                  type="date"
                  value={newReportData.report_period_start}
                  onChange={(e) => setNewReportData({...newReportData, report_period_start: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <Label>Period End</Label>
                <Input
                  type="date"
                  value={newReportData.report_period_end}
                  onChange={(e) => setNewReportData({...newReportData, report_period_end: e.target.value})}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Due Date</Label>
              <Input
                type="date"
                value={newReportData.due_date}
                onChange={(e) => setNewReportData({...newReportData, due_date: e.target.value})}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateReport(false)}>Cancel</Button>
            <Button 
              onClick={handleCreateReport}
              disabled={!newReportData.grant_id || !newReportData.due_date || createReportMutation.isPending}
            >
              {createReportMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Schedule Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
