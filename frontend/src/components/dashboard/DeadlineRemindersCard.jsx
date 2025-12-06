import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { 
  Bell, 
  BellRing,
  Calendar,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Settings,
  Mail,
  Plus
} from 'lucide-react';
import { differenceInDays, format } from 'date-fns';
import { parseDateSafe } from '@/components/shared/dateUtils';
import { Link, useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';

// Named constants
const EXCLUDED_STATUSES = ['submitted', 'awarded', 'declined', 'closed'];
const DAYS_IN_WEEK = 7;
const DAYS_IN_MONTH = 30;
const STORAGE_KEY = 'deadlineReminderSettings';

/** Safe differenceInDays - returns 0 on error */
function safeDifferenceInDays(date, baseDate) {
  if (!date || !baseDate) return 0;
  try {
    return differenceInDays(date, baseDate);
  } catch {
    return 0;
  }
}

/** Safe format */
const safeFormat = (date, formatStr) => {
  if (!date) return 'N/A';
  try {
    return format(date, formatStr);
  } catch {
    return 'Invalid date';
  }
};

/** Generate deterministic fallback ID for grants */
const getGrantFallbackId = (g) => {
  const title = (g.title || 'untitled').replace(/\s+/g, '-').substring(0, 30);
  const deadline = g.deadline || 'no-deadline';
  return `grant-${title}-${deadline}`;
};

/** Generate deterministic fallback ID for milestones */
const getMilestoneFallbackId = (m) => {
  const title = (m.title || 'milestone').replace(/\s+/g, '-').substring(0, 30);
  const dueDate = m.due_date || 'no-date';
  return `milestone-${title}-${dueDate}`;
};

export default function DeadlineRemindersCard({ grants = [], milestones = [] }) {
  const navigate = useNavigate();
  const [showSettings, setShowSettings] = useState(false);
  
  // Load initial settings from localStorage
  const [reminderSettings, setReminderSettings] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {
      // Ignore parse errors
    }
    return {
      email7Days: true,
      email3Days: true,
      email1Day: true,
      browserNotifications: false
    };
  });

  // Persist settings to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reminderSettings));
    } catch {
      // Ignore storage errors
    }
  }, [reminderSettings]);

  // Navigate to grant detail page - supports keyboard
  const handleItemClick = useCallback((item) => {
    if (item.type === 'grant' && item.id) {
      navigate(createPageUrl('GrantDetail') + `?id=${item.id}`);
    }
  }, [navigate]);

  // Keyboard handler for clickable items
  const handleItemKeyDown = useCallback((e, item) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleItemClick(item);
    }
  }, [handleItemClick]);

  // Memoize allDeadlines
  const allDeadlines = useMemo(() => {
    const safeGrants = Array.isArray(grants) ? grants : [];
    const safeMilestones = Array.isArray(milestones) ? milestones : [];

    const grantDeadlines = safeGrants
      .filter(g => g?.deadline && !EXCLUDED_STATUSES.includes(g?.status))
      .map(g => ({
        id: g.id ?? getGrantFallbackId(g),
        title: g.title || 'Untitled Grant',
        type: 'grant',
        date: parseDateSafe(g.deadline),
        funder: g.funder || 'Unknown',
        status: g.status,
        notifyWhenOpen: g.notify_when_open
      }));

    const milestoneDeadlines = safeMilestones
      .filter(m => !m?.completed && m?.due_date)
      .map(m => ({
        id: m.id ?? getMilestoneFallbackId(m),
        title: m.title || 'Untitled Milestone',
        type: 'milestone',
        date: parseDateSafe(m.due_date),
        milestoneType: m.milestone_type || 'other'
      }));

    return [...grantDeadlines, ...milestoneDeadlines]
      .filter(d => d.date && !Number.isNaN(d.date.getTime()))
      .sort((a, b) => a.date - b.date);
  }, [grants, milestones]);

  // Memoize categorized deadlines
  const { overdue, today, thisWeek, upcoming } = useMemo(() => {
    const now = new Date();
    return {
      overdue: allDeadlines.filter(d => {
        const days = safeDifferenceInDays(d.date, now);
        return days < 0;
      }),
      today: allDeadlines.filter(d => {
        const days = safeDifferenceInDays(d.date, now);
        return days === 0;
      }),
      thisWeek: allDeadlines.filter(d => {
        const days = safeDifferenceInDays(d.date, now);
        return days > 0 && days <= DAYS_IN_WEEK;
      }),
      upcoming: allDeadlines.filter(d => {
        const days = safeDifferenceInDays(d.date, now);
        return days > DAYS_IN_WEEK && days <= DAYS_IN_MONTH;
      }),
    };
  }, [allDeadlines]);

  const getUrgencyBadge = useCallback((date) => {
    const days = safeDifferenceInDays(date, new Date());
    if (days < 0) return <Badge className="bg-red-100 text-red-800">Overdue</Badge>;
    if (days === 0) return <Badge className="bg-red-100 text-red-800">Today!</Badge>;
    if (days <= 3) return <Badge className="bg-amber-100 text-amber-800">{days}d left</Badge>;
    if (days <= DAYS_IN_WEEK) return <Badge className="bg-yellow-100 text-yellow-800">{days}d left</Badge>;
    return <Badge className="bg-blue-100 text-blue-800">{days}d</Badge>;
  }, []);

  const getTypeIcon = useCallback((type, milestoneType) => {
    if (type === 'grant') return <Calendar className="w-4 h-4 text-blue-600" aria-hidden="true" />;
    switch (milestoneType) {
      case 'report_due': return <Mail className="w-4 h-4 text-purple-600" aria-hidden="true" />;
      case 'submission': return <CheckCircle2 className="w-4 h-4 text-green-600" aria-hidden="true" />;
      default: return <Clock className="w-4 h-4 text-slate-600" aria-hidden="true" />;
    }
  }, []);

  return (
    <Card 
      className={`${overdue.length > 0 || today.length > 0 ? 'border-2 border-red-300' : ''}`}
      role="region"
      aria-label="Deadline reminders"
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            {overdue.length > 0 || today.length > 0 ? (
              <BellRing className="w-5 h-5 text-red-600 animate-pulse" aria-hidden="true" />
            ) : (
              <Bell className="w-5 h-5 text-amber-600" aria-hidden="true" />
            )}
            Deadline Reminders
          </span>
          <div className="flex gap-2">
            <Button 
              variant="ghost" 
              size="sm"
              onClick={() => setShowSettings(!showSettings)}
              aria-label="Toggle reminder settings"
              aria-expanded={showSettings}
            >
              <Settings className="w-4 h-4" />
            </Button>
            <Link to={createPageUrl('GrantDeadlines')}>
              <Button variant="outline" size="sm">View All</Button>
            </Link>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Settings Panel */}
        {showSettings && (
          <div className="p-3 bg-slate-50 rounded-lg space-y-3 border">
            <h4 className="font-medium text-sm flex items-center gap-2">
              <Mail className="w-4 h-4" />
              Email Reminders
            </h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="email7" className="text-sm">7 days before</Label>
                <Switch 
                  id="email7"
                  checked={reminderSettings.email7Days}
                  onCheckedChange={(v) => setReminderSettings(s => ({...s, email7Days: v}))}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="email3" className="text-sm">3 days before</Label>
                <Switch 
                  id="email3"
                  checked={reminderSettings.email3Days}
                  onCheckedChange={(v) => setReminderSettings(s => ({...s, email3Days: v}))}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="email1" className="text-sm">1 day before</Label>
                <Switch 
                  id="email1"
                  checked={reminderSettings.email1Day}
                  onCheckedChange={(v) => setReminderSettings(s => ({...s, email1Day: v}))}
                />
              </div>
            </div>
          </div>
        )}

        {/* Summary Stats */}
        <div className="grid grid-cols-4 gap-2 text-center">
          <div className={`p-2 rounded-lg ${overdue.length > 0 ? 'bg-red-100' : 'bg-slate-50'}`}>
            <p className={`text-xl font-bold ${overdue.length > 0 ? 'text-red-600' : 'text-slate-600'}`}>
              {overdue.length}
            </p>
            <p className="text-xs text-slate-600">Overdue</p>
          </div>
          <div className={`p-2 rounded-lg ${today.length > 0 ? 'bg-red-100' : 'bg-slate-50'}`}>
            <p className={`text-xl font-bold ${today.length > 0 ? 'text-red-600' : 'text-slate-600'}`}>
              {today.length}
            </p>
            <p className="text-xs text-slate-600">Today</p>
          </div>
          <div className={`p-2 rounded-lg ${thisWeek.length > 0 ? 'bg-amber-50' : 'bg-slate-50'}`}>
            <p className={`text-xl font-bold ${thisWeek.length > 0 ? 'text-amber-600' : 'text-slate-600'}`}>
              {thisWeek.length}
            </p>
            <p className="text-xs text-slate-600">This Week</p>
          </div>
          <div className="p-2 bg-slate-50 rounded-lg">
            <p className="text-xl font-bold text-blue-600">{upcoming.length}</p>
            <p className="text-xs text-slate-600">Upcoming</p>
          </div>
        </div>

        {/* Urgent Items */}
        {(overdue.length > 0 || today.length > 0) && (
          <div 
            className="p-3 bg-red-50 rounded-lg border border-red-200"
            tabIndex={0}
            role="region"
            aria-label="Urgent deadlines requiring immediate attention"
          >
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-red-600" aria-hidden="true" />
              <span className="font-medium text-red-900 text-sm">Immediate Attention Required</span>
            </div>
            <div className="space-y-2">
              {[...overdue, ...today].slice(0, 3).map(item => (
                <div 
                  key={item.id} 
                  className={`flex items-center justify-between text-sm ${item.type === 'grant' ? 'cursor-pointer hover:bg-red-100 rounded p-1 -m-1 transition-colors' : ''}`}
                  onClick={() => handleItemClick(item)}
                  role={item.type === 'grant' ? 'button' : 'listitem'}
                  tabIndex={item.type === 'grant' ? 0 : -1}
                  onKeyDown={(e) => handleItemKeyDown(e, item)}
                  aria-label={item.type === 'grant' ? `Click to view ${item.title}` : undefined}
                >
                  <div className="flex items-center gap-2">
                    {getTypeIcon(item.type, item.milestoneType)}
                    <span className="truncate max-w-[180px]">{item.title}</span>
                  </div>
                  {getUrgencyBadge(item.date)}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* This Week Items */}
        {thisWeek.length > 0 && (
          <div 
            className="space-y-2"
            tabIndex={0}
            role="region"
            aria-label="Deadlines this week"
          >
            <h4 className="text-sm font-medium text-slate-700">This Week</h4>
            {thisWeek.slice(0, 5).map(item => (
              <div 
                key={item.id} 
                className={`flex items-center justify-between p-2 bg-white border rounded-lg ${item.type === 'grant' ? 'cursor-pointer hover:bg-blue-50 hover:border-blue-300 transition-colors' : ''}`}
                role={item.type === 'grant' ? 'button' : 'listitem'}
                onClick={() => handleItemClick(item)}
                tabIndex={item.type === 'grant' ? 0 : -1}
                onKeyDown={(e) => handleItemKeyDown(e, item)}
                aria-label={item.type === 'grant' ? `Click to view ${item.title}` : undefined}
              >
                <div className="flex items-center gap-2">
                  {getTypeIcon(item.type, item.milestoneType)}
                  <div>
                    <p className="text-sm font-medium truncate max-w-[200px]">{item.title}</p>
                    <p className="text-xs text-slate-500">
                      {safeFormat(item.date, 'EEE, MMM d')}
                      {item.funder && ` • ${item.funder}`}
                    </p>
                  </div>
                </div>
                {getUrgencyBadge(item.date)}
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {allDeadlines.length === 0 && (
          <div className="text-center py-6 text-slate-500">
            <Bell className="w-8 h-8 mx-auto mb-2 text-slate-300" aria-hidden="true" />
            <p className="mb-2">No upcoming deadlines</p>
            <p className="text-xs mb-4">Add grants to start tracking</p>
            <Link to={createPageUrl('DiscoverGrants')}>
              <Button variant="outline" size="sm" className="gap-2">
                <Plus className="w-4 h-4" />
                Discover Grants
              </Button>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}