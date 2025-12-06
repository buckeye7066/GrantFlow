import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useRLSOrganizations, useRLSGrants } from '@/components/hooks/useAuthRLS';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { parseDateSafe, formatDateSafe } from '@/components/shared/dateUtils';
import { differenceInDays, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, format } from 'date-fns';
import {
  Calendar as CalendarIcon,
  List,
  AlertTriangle,
  Clock,
  Building2,
  Target,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Filter
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function GrantDeadlines() {
  const [viewMode, setViewMode] = useState('timeline'); // 'calendar' or 'timeline'
  const [selectedOrgId, setSelectedOrgId] = useState('all');
  const [urgencyFilter, setUrgencyFilter] = useState('all');
  const [currentMonth, setCurrentMonth] = useState(new Date());

  // RLS-safe data fetching
  const { data: organizations = [], isLoading: isLoadingOrgs, isLoadingUser } = useRLSOrganizations();
  const { data: grants = [], isLoading: isLoadingGrants } = useRLSGrants();

  // Filter and process grants
  const deadlineGrants = useMemo(() => {
    return grants
      .filter(g => {
        // Filter out completed/closed grants
        if (['declined', 'closed', 'awarded'].includes(g.status)) return false;
        
        // Filter by organization
        if (selectedOrgId !== 'all' && g.organization_id !== selectedOrgId) return false;
        
        // Must have a deadline
        if (!g.deadline) return false;
        
        return true;
      })
      .map(g => {
        const deadlineDate = parseDateSafe(g.deadline);
        const isRolling = g.deadline?.toLowerCase() === 'rolling';
        const daysLeft = deadlineDate ? differenceInDays(deadlineDate, new Date()) : null;
        
        let urgency = 'normal';
        if (isRolling) {
          urgency = 'rolling';
        } else if (daysLeft !== null) {
          if (daysLeft < 0) urgency = 'expired';
          else if (daysLeft <= 3) urgency = 'critical';
          else if (daysLeft <= 7) urgency = 'urgent';
          else if (daysLeft <= 14) urgency = 'upcoming';
        }
        
        return {
          ...g,
          deadlineDate,
          isRolling,
          daysLeft,
          urgency
        };
      })
      .filter(g => {
        if (urgencyFilter === 'all') return true;
        return g.urgency === urgencyFilter;
      })
      .sort((a, b) => {
        if (a.isRolling && !b.isRolling) return 1;
        if (!a.isRolling && b.isRolling) return -1;
        if (!a.deadlineDate && b.deadlineDate) return 1;
        if (a.deadlineDate && !b.deadlineDate) return -1;
        if (a.deadlineDate && b.deadlineDate) {
          return a.deadlineDate - b.deadlineDate;
        }
        return 0;
      });
  }, [grants, selectedOrgId, urgencyFilter]);

  // Urgency stats
  const urgencyStats = useMemo(() => {
    const stats = {
      critical: 0,
      urgent: 0,
      upcoming: 0,
      normal: 0,
      rolling: 0,
      expired: 0
    };
    
    deadlineGrants.forEach(g => {
      stats[g.urgency]++;
    });
    
    return stats;
  }, [deadlineGrants]);

  // Calendar data
  const calendarData = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
    
    const dayMap = {};
    days.forEach(day => {
      dayMap[format(day, 'yyyy-MM-dd')] = [];
    });
    
    deadlineGrants.forEach(grant => {
      if (grant.deadlineDate && !grant.isRolling) {
        const key = format(grant.deadlineDate, 'yyyy-MM-dd');
        if (dayMap[key]) {
          dayMap[key].push(grant);
        }
      }
    });
    
    return { days, dayMap };
  }, [currentMonth, deadlineGrants]);

  const getUrgencyColor = (urgency) => {
    switch (urgency) {
      case 'critical': return 'bg-red-100 text-red-800 border-red-300';
      case 'urgent': return 'bg-orange-100 text-orange-800 border-orange-300';
      case 'upcoming': return 'bg-amber-100 text-amber-800 border-amber-300';
      case 'rolling': return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'expired': return 'bg-gray-100 text-gray-800 border-gray-300';
      default: return 'bg-green-100 text-green-800 border-green-300';
    }
  };

  const getUrgencyLabel = (urgency) => {
    switch (urgency) {
      case 'critical': return '🔴 Critical (≤3 days)';
      case 'urgent': return '🟠 Urgent (≤7 days)';
      case 'upcoming': return '🟡 Upcoming (≤14 days)';
      case 'rolling': return '🔵 Rolling';
      case 'expired': return '⚫ Expired';
      default: return '🟢 Normal';
    }
  };

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
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
              <CalendarIcon className="w-8 h-8 text-blue-600" />
              Grant Deadlines
            </h1>
            <p className="text-slate-600 mt-2">Centralized deadline tracking and management</p>
          </div>
        </div>

        {/* Critical Alerts */}
        {urgencyStats.critical > 0 && (
          <Alert className="mb-6 bg-red-50 border-red-300">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-900">
              <strong>⚠️ {urgencyStats.critical} Critical Deadline{urgencyStats.critical !== 1 ? 's' : ''}</strong> - 
              3 days or less remaining! Immediate action required.
            </AlertDescription>
          </Alert>
        )}

        {/* Urgency Stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
          <Card 
            className={`border-red-200 bg-red-50 cursor-pointer transition-all hover:shadow-md hover:scale-105 ${urgencyFilter === 'critical' ? 'ring-2 ring-red-500' : ''}`}
            onClick={() => setUrgencyFilter(urgencyFilter === 'critical' ? 'all' : 'critical')}
          >
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-red-700">{urgencyStats.critical}</div>
              <div className="text-xs text-red-600">Critical (≤3 days)</div>
            </CardContent>
          </Card>
          <Card 
            className={`border-orange-200 bg-orange-50 cursor-pointer transition-all hover:shadow-md hover:scale-105 ${urgencyFilter === 'urgent' ? 'ring-2 ring-orange-500' : ''}`}
            onClick={() => setUrgencyFilter(urgencyFilter === 'urgent' ? 'all' : 'urgent')}
          >
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-orange-700">{urgencyStats.urgent}</div>
              <div className="text-xs text-orange-600">Urgent (≤7 days)</div>
            </CardContent>
          </Card>
          <Card 
            className={`border-amber-200 bg-amber-50 cursor-pointer transition-all hover:shadow-md hover:scale-105 ${urgencyFilter === 'upcoming' ? 'ring-2 ring-amber-500' : ''}`}
            onClick={() => setUrgencyFilter(urgencyFilter === 'upcoming' ? 'all' : 'upcoming')}
          >
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-amber-700">{urgencyStats.upcoming}</div>
              <div className="text-xs text-amber-600">Upcoming (≤14 days)</div>
            </CardContent>
          </Card>
          <Card 
            className={`border-green-200 bg-green-50 cursor-pointer transition-all hover:shadow-md hover:scale-105 ${urgencyFilter === 'normal' ? 'ring-2 ring-green-500' : ''}`}
            onClick={() => setUrgencyFilter(urgencyFilter === 'normal' ? 'all' : 'normal')}
          >
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-green-700">{urgencyStats.normal}</div>
              <div className="text-xs text-green-600">Normal (&gt;14 days)</div>
            </CardContent>
          </Card>
          <Card 
            className={`border-blue-200 bg-blue-50 cursor-pointer transition-all hover:shadow-md hover:scale-105 ${urgencyFilter === 'rolling' ? 'ring-2 ring-blue-500' : ''}`}
            onClick={() => setUrgencyFilter(urgencyFilter === 'rolling' ? 'all' : 'rolling')}
          >
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-blue-700">{urgencyStats.rolling}</div>
              <div className="text-xs text-blue-600">Rolling</div>
            </CardContent>
          </Card>
          <Card 
            className={`border-gray-200 bg-gray-50 cursor-pointer transition-all hover:shadow-md hover:scale-105 ${urgencyFilter === 'expired' ? 'ring-2 ring-gray-500' : ''}`}
            onClick={() => setUrgencyFilter(urgencyFilter === 'expired' ? 'all' : 'expired')}
          >
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-gray-700">{urgencyStats.expired}</div>
              <div className="text-xs text-gray-600">Expired</div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card className="mb-6">
          <CardContent className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm font-medium text-slate-700 mb-2 block">Organization</label>
                <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Organizations</SelectItem>
                    {organizations.map(org => (
                      <SelectItem key={org.id} value={org.id}>
                        {org.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700 mb-2 block">Urgency Level</label>
                <Select value={urgencyFilter} onValueChange={setUrgencyFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Deadlines</SelectItem>
                    <SelectItem value="critical">Critical (≤3 days)</SelectItem>
                    <SelectItem value="urgent">Urgent (≤7 days)</SelectItem>
                    <SelectItem value="upcoming">Upcoming (≤14 days)</SelectItem>
                    <SelectItem value="normal">Normal (&gt;14 days)</SelectItem>
                    <SelectItem value="rolling">Rolling</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700 mb-2 block">View Mode</label>
                <Tabs value={viewMode} onValueChange={setViewMode} className="w-full">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="timeline">
                      <List className="w-4 h-4 mr-2" />
                      Timeline
                    </TabsTrigger>
                    <TabsTrigger value="calendar">
                      <CalendarIcon className="w-4 h-4 mr-2" />
                      Calendar
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Content */}
        {viewMode === 'timeline' ? (
          <div className="space-y-4">
            {deadlineGrants.length === 0 ? (
              <Card>
                <CardContent className="p-12 text-center">
                  <Clock className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">No Deadlines Found</h3>
                  <p className="text-slate-600">
                    {urgencyFilter !== 'all' 
                      ? 'Try adjusting your filters to see more deadlines.'
                      : 'No active grants with deadlines found.'}
                  </p>
                </CardContent>
              </Card>
            ) : (
              deadlineGrants.map(grant => {
                const org = organizations.find(o => o.id === grant.organization_id);
                
                return (
                  <Link key={grant.id} to={createPageUrl(`GrantDetail?id=${grant.id}`)}>
                    <Card className={`border-l-4 hover:shadow-lg transition-all cursor-pointer ${
                      grant.urgency === 'critical' ? 'border-l-red-500 bg-red-50' :
                      grant.urgency === 'urgent' ? 'border-l-orange-500 bg-orange-50' :
                      grant.urgency === 'upcoming' ? 'border-l-amber-500 bg-amber-50' :
                      grant.urgency === 'rolling' ? 'border-l-blue-500 bg-blue-50' :
                      grant.urgency === 'expired' ? 'border-l-gray-500 bg-gray-50' :
                      'border-l-green-500 bg-green-50'
                    }`}>
                      <CardContent className="p-6">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-2">
                              <Badge className={getUrgencyColor(grant.urgency)}>
                                {grant.isRolling ? 'Rolling' : 
                                 grant.daysLeft !== null ? 
                                   grant.daysLeft === 0 ? 'Due Today!' :
                                   grant.daysLeft === 1 ? '1 day left' :
                                   grant.daysLeft < 0 ? `${Math.abs(grant.daysLeft)} days overdue` :
                                   `${grant.daysLeft} days left` 
                                 : 'No deadline'}
                              </Badge>
                              <Badge variant="outline">{grant.status}</Badge>
                            </div>
                            
                            <h3 className="font-semibold text-slate-900 text-lg mb-1 truncate">
                              {grant.title}
                            </h3>
                            
                            <div className="flex items-center gap-4 text-sm text-slate-600 flex-wrap">
                              <span className="flex items-center gap-1">
                                <Target className="w-4 h-4" />
                                {grant.funder}
                              </span>
                              {org && (
                                <span className="flex items-center gap-1">
                                  <Building2 className="w-4 h-4" />
                                  {org.name}
                                </span>
                              )}
                              <span className="flex items-center gap-1">
                                <CalendarIcon className="w-4 h-4" />
                                {grant.isRolling ? 'Rolling' : formatDateSafe(grant.deadline, 'MMM d, yyyy')}
                              </span>
                            </div>
                          </div>
                          
                          {grant.award_ceiling && (
                            <div className="text-right shrink-0">
                              <div className="text-sm text-slate-500">Max Award</div>
                              <div className="text-xl font-bold text-slate-900">
                                ${grant.award_ceiling.toLocaleString()}
                              </div>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })
            )}
          </div>
        ) : (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <CalendarIcon className="w-5 h-5" />
                  {format(currentMonth, 'MMMM yyyy')}
                </CardTitle>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1))}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentMonth(new Date())}
                  >
                    Today
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1))}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-6">
              <div className="grid grid-cols-7 gap-2">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                  <div key={day} className="text-center text-sm font-semibold text-slate-600 py-2">
                    {day}
                  </div>
                ))}
                
                {/* Padding for days before month starts */}
                {Array.from({ length: calendarData.days[0].getDay() }).map((_, i) => (
                  <div key={`pad-${i}`} className="p-2 border border-transparent"></div>
                ))}
                
                {/* Calendar days */}
                {calendarData.days.map(day => {
                  const key = format(day, 'yyyy-MM-dd');
                  const dayGrants = calendarData.dayMap[key] || [];
                  const isToday = isSameDay(day, new Date());
                  
                  return (
                    <div
                      key={key}
                      className={`min-h-24 p-2 border rounded-lg ${
                        isToday ? 'border-blue-500 bg-blue-50' : 'border-slate-200'
                      } ${dayGrants.length > 0 ? 'bg-slate-50' : ''}`}
                    >
                      <div className={`text-sm font-medium mb-1 ${
                        isToday ? 'text-blue-700' : 'text-slate-700'
                      }`}>
                        {format(day, 'd')}
                      </div>
                      
                      <div className="space-y-1">
                        {dayGrants.slice(0, 2).map(grant => (
                          <Link
                            key={grant.id}
                            to={createPageUrl(`GrantDetail?id=${grant.id}`)}
                            className={`block text-xs p-1 rounded truncate ${getUrgencyColor(grant.urgency)}`}
                          >
                            {grant.title}
                          </Link>
                        ))}
                        {dayGrants.length > 2 && (
                          <div className="text-xs text-slate-500 pl-1">
                            +{dayGrants.length - 2} more
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}