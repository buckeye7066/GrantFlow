import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line } from 'recharts';
import { Activity, Users, Eye, TrendingUp, Clock, Loader2, X, Trash2, RefreshCw } from 'lucide-react';
import { format, parseISO, startOfDay, subDays } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from '@/components/ui/use-toast';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

export default function UserAnalytics() {
  const [timeRange, setTimeRange] = useState(7);
  const [showUsersDialog, setShowUsersDialog] = useState(false);
  const [showActiveUsersDialog, setShowActiveUsersDialog] = useState(false);
  const [showPageViewsDialog, setShowPageViewsDialog] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: user } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const ADMIN_EMAILS = ['buckeye7066@gmail.com'];
  const isAdmin = !!user?.email && ADMIN_EMAILS.includes(user.email);

  const { data: activities = [], isLoading } = useQuery({
    queryKey: ['userActivities'],
    queryFn: () => base44.entities.UserActivity.list('-created_date', 10000),
    enabled: !!user?.email && isAdmin,
  });

  const { data: allUsers = [] } = useQuery({
    queryKey: ['allUsers'],
    queryFn: async () => {
      const response = await base44.functions.invoke('getUserList');
      if (!response?.data?.success) return [];
      return Array.isArray(response.data.users) ? response.data.users : [];
    },
    enabled: !!user?.email && isAdmin,
  });

  const analytics = useMemo(() => {
    const cutoff = subDays(new Date(), timeRange);
    const recentActivities = activities.filter(a => 
      new Date(a.created_date || a.created_at || a.timestamp || 0) >= cutoff
    );

    // Page popularity
    const pageVisits = {};
    recentActivities
      .filter(a => (a.activity_type || 'unknown') === 'page_visit')
      .forEach(a => {
        const page = a.page_name || 'Unknown';
        pageVisits[page] = (pageVisits[page] || 0) + 1;
      });

    const popularPages = Object.entries(pageVisits)
      .map(([page, visits]) => ({ page, visits }))
      .sort((a, b) => b.visits - a.visits)
      .slice(0, 10);

    // Active users
    const uniqueUsers = new Set(recentActivities.map(a => a.user_email || 'unknown'));
    const activeUsersCount = uniqueUsers.size;

    // Daily activity trend
    const dailyActivity = {};
    recentActivities.forEach(a => {
      const day = format(startOfDay(parseISO(a.created_date || a.created_at || new Date().toISOString())), 'MMM dd');
      dailyActivity[day] = (dailyActivity[day] || 0) + 1;
    });

    const dailyTrend = Object.entries(dailyActivity)
      .map(([date, count]) => ({ date, count }))
      .slice(-14);

    // User engagement
    const userActivity = {};
    recentActivities.forEach(a => {
      const email = a.user_email || 'unknown';
      if (!userActivity[email]) {
        userActivity[email] = {
          email: email,
          name: a.user_name || 'User',
          pageVisits: 0,
          lastActive: a.created_date || a.created_at || new Date().toISOString()
        };
      }
      userActivity[email].pageVisits++;
      if (new Date(a.created_date || a.created_at || a.timestamp || 0) > new Date(userActivity[email].lastActive)) {
        userActivity[email].lastActive = a.created_date || a.created_at || new Date().toISOString();
      }
    });

    const topUsers = Object.values(userActivity)
      .sort((a, b) => b.pageVisits - a.pageVisits)
      .slice(0, 10);

    // Total stats
    const totalPageViews = recentActivities.filter(a => (a.activity_type || 'unknown') === 'page_visit').length;
    const avgPerUser = activeUsersCount > 0 ? (totalPageViews / activeUsersCount).toFixed(1) : 0;

    // Get active user emails list
    const activeUsersList = Array.from(uniqueUsers).map(email => {
      const userActs = recentActivities.filter(a => a.user_email === email);
      const lastAct = userActs.sort((a, b) => 
        new Date(b.created_date || b.created_at || 0) - new Date(a.created_date || a.created_at || 0)
      )[0];
      return {
        email,
        name: lastAct?.user_name || 'User',
        pageVisits: userActs.filter(a => a.activity_type === 'page_visit').length,
        lastActive: lastAct?.created_date || lastAct?.created_at
      };
    }).sort((a, b) => b.pageVisits - a.pageVisits);

    return {
      popularPages,
      activeUsersCount,
      dailyTrend,
      topUsers,
      totalPageViews,
      avgPerUser,
      activeUsersList
    };
  }, [activities, timeRange]);

  // Reset analytics mutation
  const handleResetAnalytics = async () => {
    if (!window.confirm('Are you sure you want to delete all user activity data? This cannot be undone.')) {
      return;
    }
    setIsResetting(true);
    try {
      let deleted = 0;
      for (const activity of activities) {
        try {
          await base44.entities.UserActivity.delete(activity.id);
          deleted++;
        } catch (err) {
          console.warn('Failed to delete activity:', err?.message);
        }
      }
      queryClient.invalidateQueries({ queryKey: ['userActivities'] });
      toast({
        title: 'Analytics Reset',
        description: `Deleted ${deleted} activity records.`,
      });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Reset Failed',
        description: err?.message,
      });
    } finally {
      setIsResetting(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="pt-6">
            <p className="text-slate-600 text-center">Admin access required</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
              <Activity className="w-8 h-8 text-blue-600" />
              User Activity Analytics
            </h1>
            <p className="text-slate-600 mt-1">Track user behavior and popular features</p>
          </div>

          <div className="flex gap-2 items-center">
            <Button
              variant="outline"
              size="sm"
              onClick={handleResetAnalytics}
              disabled={isResetting || activities.length === 0}
              className="text-red-600 hover:text-red-700 mr-2"
            >
              {isResetting ? (
                <Loader2 className="w-4 h-4 animate-spin mr-1" />
              ) : (
                <Trash2 className="w-4 h-4 mr-1" />
              )}
              Reset Analytics
            </Button>
            <Badge 
              variant={timeRange === 7 ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => setTimeRange(7)}
            >
              7 Days
            </Badge>
            <Badge 
              variant={timeRange === 30 ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => setTimeRange(30)}
            >
              30 Days
            </Badge>
            <Badge 
              variant={timeRange === 90 ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => setTimeRange(90)}
            >
              90 Days
            </Badge>
          </div>
        </div>

        {/* Summary Cards - Clickable */}
        <div className="grid md:grid-cols-4 gap-4">
          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:ring-2 hover:ring-blue-200"
            onClick={() => setShowUsersDialog(true)}
          >
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Total Users</p>
                  <p className="text-3xl font-bold text-slate-900">{allUsers.length}</p>
                  <p className="text-xs text-blue-500 mt-1">Click to view all</p>
                </div>
                <Users className="w-10 h-10 text-blue-600 opacity-20" />
              </div>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:ring-2 hover:ring-green-200"
            onClick={() => setShowActiveUsersDialog(true)}
          >
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Active Users</p>
                  <p className="text-3xl font-bold text-green-600">{analytics.activeUsersCount}</p>
                  <p className="text-xs text-slate-500 mt-1">Last {timeRange} days</p>
                </div>
                <Activity className="w-10 h-10 text-green-600 opacity-20" />
              </div>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:ring-2 hover:ring-purple-200"
            onClick={() => setShowPageViewsDialog(true)}
          >
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Page Views</p>
                  <p className="text-3xl font-bold text-purple-600">{analytics.totalPageViews}</p>
                  <p className="text-xs text-purple-500 mt-1">Click to view breakdown</p>
                </div>
                <Eye className="w-10 h-10 text-purple-600 opacity-20" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Avg. Per User</p>
                  <p className="text-3xl font-bold text-amber-600">{analytics.avgPerUser}</p>
                  <p className="text-xs text-slate-500 mt-1">pages/user</p>
                </div>
                <TrendingUp className="w-10 h-10 text-amber-600 opacity-20" />
              </div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="pages" className="space-y-6">
          <TabsList>
            <TabsTrigger value="pages">Popular Pages</TabsTrigger>
            <TabsTrigger value="users">Top Users</TabsTrigger>
            <TabsTrigger value="trends">Activity Trends</TabsTrigger>
          </TabsList>

          <TabsContent value="pages">
            <Card>
              <CardHeader>
                <CardTitle>Most Visited Pages</CardTitle>
                <CardDescription>Last {timeRange} days</CardDescription>
              </CardHeader>
              <CardContent>
                {analytics.popularPages.length > 0 ? (
                  <ResponsiveContainer width="100%" height={400}>
                    <BarChart data={analytics.popularPages}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="page" angle={-45} textAnchor="end" height={100} />
                      <YAxis />
                      <Tooltip />
                      <Bar dataKey="visits" fill="#3b82f6" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[400px] flex items-center justify-center text-slate-500">
                    No page visit data available
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="users">
            <Card>
              <CardHeader>
                <CardTitle>Most Active Users</CardTitle>
                <CardDescription>Ranked by page visits in last {timeRange} days</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {analytics.topUsers.map((user, idx) => (
                    <div key={idx} className="flex items-center justify-between p-4 border rounded-lg hover:bg-slate-50 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center">
                          <span className="text-white font-semibold text-sm">
                            {user.name?.charAt(0)?.toUpperCase() || 'U'}
                          </span>
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900">{user.name}</p>
                          <p className="text-sm text-slate-500">{user.email}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-2xl font-bold text-blue-600">{user.pageVisits}</p>
                        <p className="text-xs text-slate-500">page views</p>
                        <p className="text-xs text-slate-400 mt-1">
                          <Clock className="w-3 h-3 inline mr-1" />
                          {format(parseISO(user.lastActive || new Date().toISOString()), 'MMM dd, HH:mm')}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="trends">
            <Card>
              <CardHeader>
                <CardTitle>Daily Activity Trend</CardTitle>
                <CardDescription>Page visits over time</CardDescription>
              </CardHeader>
              <CardContent>
                {analytics.dailyTrend.length > 0 ? (
                  <ResponsiveContainer width="100%" height={400}>
                    <LineChart data={analytics.dailyTrend}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" />
                      <YAxis />
                      <Tooltip />
                      <Line 
                        type="monotone" 
                        dataKey="count" 
                        stroke="#3b82f6" 
                        strokeWidth={3}
                        name="Page Views"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[400px] flex items-center justify-center text-slate-500">
                    No activity trend data available
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Total Users Dialog */}
      <Dialog open={showUsersDialog} onOpenChange={setShowUsersDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-600" />
              All Users ({allUsers.length})
            </DialogTitle>
            <DialogDescription>Complete list of registered users</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 mt-4">
            {allUsers.map((u, idx) => (
              <div key={idx} className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center">
                    <span className="text-white font-semibold text-sm">
                      {u.full_name?.charAt(0)?.toUpperCase() || u.email?.charAt(0)?.toUpperCase() || 'U'}
                    </span>
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">{u.full_name || 'Unknown'}</p>
                    <p className="text-sm text-slate-500">{u.email}</p>
                  </div>
                </div>
                <Badge variant={u.role === 'admin' ? 'default' : 'outline'}>
                  {u.role || 'user'}
                </Badge>
              </div>
            ))}
            {allUsers.length === 0 && (
              <p className="text-center text-slate-500 py-8">No users found</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Active Users Dialog */}
      <Dialog open={showActiveUsersDialog} onOpenChange={setShowActiveUsersDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-green-600" />
              Active Users ({analytics.activeUsersCount})
            </DialogTitle>
            <DialogDescription>Users with activity in the last {timeRange} days</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 mt-4">
            {analytics.activeUsersList?.map((u, idx) => (
              <div key={idx} className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-gradient-to-br from-green-500 to-emerald-600 rounded-full flex items-center justify-center">
                    <span className="text-white font-semibold text-sm">
                      {u.name?.charAt(0)?.toUpperCase() || 'U'}
                    </span>
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">{u.name || 'Unknown'}</p>
                    <p className="text-sm text-slate-500">{u.email}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-bold text-green-600">{u.pageVisits} views</p>
                  {u.lastActive && (
                    <p className="text-xs text-slate-400">
                      Last: {format(parseISO(u.lastActive), 'MMM dd, HH:mm')}
                    </p>
                  )}
                </div>
              </div>
            ))}
            {(!analytics.activeUsersList || analytics.activeUsersList.length === 0) && (
              <p className="text-center text-slate-500 py-8">No active users in this period</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Page Views Dialog */}
      <Dialog open={showPageViewsDialog} onOpenChange={setShowPageViewsDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="w-5 h-5 text-purple-600" />
              Page Views Breakdown ({analytics.totalPageViews})
            </DialogTitle>
            <DialogDescription>Page visits in the last {timeRange} days</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 mt-4">
            {analytics.popularPages?.map((page, idx) => (
              <div key={idx} className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                    <span className="font-semibold text-purple-600 text-sm">
                      {idx + 1}
                    </span>
                  </div>
                  <p className="font-medium text-slate-900">{page.page}</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-24 bg-slate-100 rounded-full h-2">
                    <div 
                      className="bg-purple-500 h-2 rounded-full" 
                      style={{ width: `${Math.min(100, (page.visits / (analytics.popularPages[0]?.visits || 1)) * 100)}%` }}
                    />
                  </div>
                  <Badge variant="secondary">{page.visits}</Badge>
                </div>
              </div>
            ))}
            {(!analytics.popularPages || analytics.popularPages.length === 0) && (
              <p className="text-center text-slate-500 py-8">No page view data</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}