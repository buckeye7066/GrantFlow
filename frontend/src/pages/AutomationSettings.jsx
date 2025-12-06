import React, { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useRLSOrganizations, useRLSFilter, useAuthContext } from '@/components/hooks/useAuthRLS';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { 
  Settings, 
  Zap, 
  Target, 
  TrendingUp, 
  Clock, 
  Bell,
  Save,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import SmartAutomationDashboard from '@/components/automation/SmartAutomationDashboard';
import DeadlineAlertSettings from '@/components/compliance/DeadlineAlertSettings';
import NotificationCenter from '@/components/compliance/NotificationCenter';

export default function AutomationSettings() {
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [formData, setFormData] = useState({
    daily_discovery_enabled: true,
    auto_analyze_enabled: true,
    auto_advance_enabled: true,
    stop_at_portal: true,
    stop_at_print: true,
    min_match_score: 60,
    deadline_reminder_days: [14, 7, 3, 1],
    notification_email: '',
    time_tracking_enabled: true,
    idle_timeout_minutes: 5
  });

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Central auth context
  const { user, isAdmin, isLoadingUser } = useAuthContext();

  // RLS-safe organizations fetch
  const { 
    data: organizations = [], 
    isLoading: isLoadingOrgs
  } = useRLSOrganizations();

  // RLS-safe settings for selected org
  const { 
    data: settingsArray = [], 
    isLoading: isLoadingSettings 
  } = useRLSFilter('AutomationSettings', { organization_id: selectedOrgId }, {
    enabled: !!selectedOrgId
  });
  
  const settings = settingsArray?.[0];
  const isLoading = isLoadingUser || isLoadingOrgs || isLoadingSettings;

  // Auto-select first org
  useEffect(() => {
    if (organizations.length > 0 && !selectedOrgId) {
      setSelectedOrgId(organizations[0].id);
    }
  }, [organizations, selectedOrgId]);

  // Load settings into form
  useEffect(() => {
    if (settings) {
      setFormData({
        daily_discovery_enabled: settings.daily_discovery_enabled ?? true,
        auto_analyze_enabled: settings.auto_analyze_enabled ?? true,
        auto_advance_enabled: settings.auto_advance_enabled ?? true,
        stop_at_portal: settings.stop_at_portal ?? true,
        stop_at_print: settings.stop_at_print ?? true,
        min_match_score: settings.min_match_score ?? 60,
        deadline_reminder_days: settings.deadline_reminder_days || [14, 7, 3, 1],
        notification_email: settings.notification_email || '',
        time_tracking_enabled: settings.time_tracking_enabled ?? true,
        idle_timeout_minutes: settings.idle_timeout_minutes ?? 5
      });
    }
  }, [settings]);

  // Save mutation - C3 FIX: Added user validation before create
  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (!user?.email) {
        throw new Error('User not authenticated');
      }
      
      if (settings) {
        return await base44.entities.AutomationSettings.update(settings.id, data);
      } else {
        return await base44.entities.AutomationSettings.create({
          ...data,
          organization_id: selectedOrgId
        });
      }
    },
    onSuccess: () => {
      // M9 FIX: Use precise invalidation key matching useRLSFilter pattern
      queryClient.invalidateQueries({
        queryKey: [
          'rlsFilter',
          'AutomationSettings',
          JSON.stringify({ organization_id: selectedOrgId }),
          user?.email,
          isAdmin
        ]
      });
      toast({
        title: '✅ Settings Saved',
        description: 'Automation settings have been updated',
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Save Failed',
        description: error.message || 'Failed to save settings',
      });
    }
  });

  const handleSave = () => {
    saveMutation.mutate(formData);
  };

  const selectedOrg = organizations.find(o => o.id === selectedOrgId);

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Settings className="w-8 h-8 text-blue-600" />
            Automation Settings
          </h1>
          <p className="text-slate-600 mt-2">
            Configure AI-powered automation and workflows
          </p>
        </div>

        {/* Organization Selector */}
        <Card className="mb-6">
          <CardContent className="p-6">
            <Label>Select Organization</Label>
            <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="Choose organization..." />
              </SelectTrigger>
              <SelectContent>
                {organizations.map(org => (
                  <SelectItem key={org.id} value={org.id}>
                    {org.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {!selectedOrgId ? (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Please select an organization to configure automation settings
            </AlertDescription>
          </Alert>
        ) : isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : (
          <Tabs defaultValue="smart" className="space-y-6">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="smart" className="gap-2">
                <Sparkles className="w-4 h-4" />
                Smart Automation
              </TabsTrigger>
              <TabsTrigger value="alerts" className="gap-2">
                <Bell className="w-4 h-4" />
                Deadline Alerts
              </TabsTrigger>
              <TabsTrigger value="pipeline" className="gap-2">
                <Zap className="w-4 h-4" />
                Pipeline Settings
              </TabsTrigger>
            </TabsList>

            {/* Smart Automation Tab */}
            <TabsContent value="smart">
              <SmartAutomationDashboard organizationId={selectedOrgId} />
            </TabsContent>

            {/* Deadline Alerts Tab */}
            <TabsContent value="alerts" className="space-y-6">
              <div className="grid md:grid-cols-2 gap-6">
                <DeadlineAlertSettings organizationId={selectedOrgId} />
                <NotificationCenter organizationId={selectedOrgId} />
              </div>
            </TabsContent>

            {/* Pipeline Settings Tab */}
            <TabsContent value="pipeline" className="space-y-6">
            {/* Automation Status Banner */}
            <Alert className="mb-6 bg-gradient-to-r from-blue-50 to-purple-50 border-blue-200">
              <Zap className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-900">
                <strong>🤖 Full Automation Active for {selectedOrg?.name}</strong>
                <p className="text-sm mt-1">
                  Daily grant discovery at midnight • Auto-analysis • Auto-advance through pipeline • 
                  Stops at portal/print for your review
                </p>
              </AlertDescription>
            </Alert>

            {/* Daily Discovery Settings */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Target className="w-5 h-5 text-blue-600" />
                  Daily Grant Discovery & Matching
                </CardTitle>
                <CardDescription>
                  Automatically search for new funding opportunities every night at midnight
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Enable Daily Discovery</Label>
                    <p className="text-sm text-slate-500">
                      Search for grants matching profile data points
                    </p>
                  </div>
                  <Switch
                    checked={formData.daily_discovery_enabled}
                    onCheckedChange={(checked) => 
                      setFormData({ ...formData, daily_discovery_enabled: checked })
                    }
                  />
                </div>

                <div className="border-t pt-4">
                  <Label className="text-base font-semibold">Match Score Threshold</Label>
                  <p className="text-sm text-slate-500 mb-3">
                    Only add grants scoring at or above this threshold. Lower scores = more results but less relevant.
                  </p>
                  
                  <div className="space-y-3">
                    <div className="flex items-center gap-4">
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        value={formData.min_match_score}
                        onChange={(e) => 
                          setFormData({ ...formData, min_match_score: parseInt(e.target.value) || 0 })
                        }
                        className="w-24 text-center text-lg font-bold"
                      />
                      <span className="text-2xl font-bold text-blue-600">
                        {formData.min_match_score}%
                      </span>
                      <div className="flex-1">
                        <Input
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          value={formData.min_match_score}
                          onChange={(e) => 
                            setFormData({ ...formData, min_match_score: parseInt(e.target.value) })
                          }
                          className="w-full"
                        />
                      </div>
                    </div>
                    
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div className={`p-2 rounded text-center ${formData.min_match_score <= 40 ? 'bg-amber-100 border-2 border-amber-400' : 'bg-white'}`}>
                          <p className="font-semibold text-amber-700">0-40%</p>
                          <p className="text-slate-600">Low Bar</p>
                          <p className="text-slate-500">Many results, review carefully</p>
                        </div>
                        <div className={`p-2 rounded text-center ${formData.min_match_score > 40 && formData.min_match_score <= 70 ? 'bg-blue-100 border-2 border-blue-400' : 'bg-white'}`}>
                          <p className="font-semibold text-blue-700">50-70%</p>
                          <p className="text-slate-600">Balanced</p>
                          <p className="text-slate-500">Good mix of quantity & quality</p>
                        </div>
                        <div className={`p-2 rounded text-center ${formData.min_match_score > 70 ? 'bg-green-100 border-2 border-green-400' : 'bg-white'}`}>
                          <p className="font-semibold text-green-700">80-100%</p>
                          <p className="text-slate-600">High Bar</p>
                          <p className="text-slate-500">Fewer but highly relevant</p>
                        </div>
                      </div>
                    </div>
                    
                    <Alert className="bg-blue-50 border-blue-200">
                      <Target className="h-4 w-4 text-blue-600" />
                      <AlertDescription className="text-blue-900 text-sm">
                        <strong>How Matching Works:</strong>
                        <ul className="list-disc list-inside mt-2 space-y-1">
                          <li>Applicant type match (student/individual/org): +40 points</li>
                          <li>Geographic eligibility: +25 points</li>
                          <li>Keyword density: up to +40 points</li>
                          <li>Demographic criteria: up to +25 points</li>
                          <li>Specific qualifications: up to +25 points each</li>
                        </ul>
                        <p className="mt-2 font-semibold">
                          Grants are <u>automatically ranked by match score</u> (highest first)
                        </p>
                      </AlertDescription>
                    </Alert>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Auto-Analysis Settings */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Zap className="w-5 h-5 text-purple-600" />
                  Automatic AI Analysis
                </CardTitle>
                <CardDescription>
                  Analyze new grants with AI to generate insights and checklists
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Enable Auto-Analysis</Label>
                    <p className="text-sm text-slate-500">
                      Run AI analysis on discovered grants (12 min billed per grant)
                    </p>
                  </div>
                  <Switch
                    checked={formData.auto_analyze_enabled}
                    onCheckedChange={(checked) => 
                      setFormData({ ...formData, auto_analyze_enabled: checked })
                    }
                  />
                </div>
              </CardContent>
            </Card>

            {/* Auto-Advance Settings */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-emerald-600" />
                  Pipeline Auto-Advancement
                </CardTitle>
                <CardDescription>
                  Automatically move grants through pipeline stages
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Enable Auto-Advance</Label>
                    <p className="text-sm text-slate-500">
                      Progress grants: Discovered → Interested → Drafting → Application Prep
                    </p>
                  </div>
                  <Switch
                    checked={formData.auto_advance_enabled}
                    onCheckedChange={(checked) => 
                      setFormData({ ...formData, auto_advance_enabled: checked })
                    }
                  />
                </div>

                <div className="pl-4 border-l-2 border-slate-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-sm">Stop at Portal Submission</Label>
                      <p className="text-xs text-slate-500">
                        Pause for your review before portal applications
                      </p>
                    </div>
                    <Switch
                      checked={formData.stop_at_portal}
                      onCheckedChange={(checked) => 
                        setFormData({ ...formData, stop_at_portal: checked })
                      }
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-sm">Stop at Print Application</Label>
                      <p className="text-xs text-slate-500">
                        Pause for your review before print/mail applications
                      </p>
                    </div>
                    <Switch
                      checked={formData.stop_at_print}
                      onCheckedChange={(checked) => 
                        setFormData({ ...formData, stop_at_print: checked })
                      }
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Time Tracking Settings */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="w-5 h-5 text-amber-600" />
                  Automatic Time Tracking
                </CardTitle>
                <CardDescription>
                  Track all work time with intelligent idle detection
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Enable Time Tracking</Label>
                    <p className="text-sm text-slate-500">
                      Automatically track manual work for billing
                    </p>
                  </div>
                  <Switch
                    checked={formData.time_tracking_enabled}
                    onCheckedChange={(checked) => 
                      setFormData({ ...formData, time_tracking_enabled: checked })
                    }
                  />
                </div>

                <div>
                  <Label>Idle Timeout (Minutes)</Label>
                  <p className="text-sm text-slate-500 mb-2">
                    Auto-pause tracking after this many minutes of inactivity
                  </p>
                  <Select
                    value={formData.idle_timeout_minutes.toString()}
                    onValueChange={(value) => 
                      setFormData({ ...formData, idle_timeout_minutes: parseInt(value) })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="3">3 minutes</SelectItem>
                      <SelectItem value="5">5 minutes</SelectItem>
                      <SelectItem value="10">10 minutes</SelectItem>
                      <SelectItem value="15">15 minutes</SelectItem>
                      <SelectItem value="30">30 minutes</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            {/* Notification Settings */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bell className="w-5 h-5 text-blue-600" />
                  Deadline Reminders
                </CardTitle>
                <CardDescription>
                  Automated alerts for upcoming grant deadlines
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Send Reminders At</Label>
                  <p className="text-sm text-slate-500 mb-2">
                    Days before deadline to receive alerts
                  </p>
                  <div className="flex gap-2">
                    {[14, 7, 3, 1].map(days => (
                      <Badge
                        key={days}
                        variant={formData.deadline_reminder_days.includes(days) ? 'default' : 'outline'}
                        className="cursor-pointer"
                        onClick={() => {
                          const current = formData.deadline_reminder_days;
                          if (current.includes(days)) {
                            setFormData({
                              ...formData,
                              deadline_reminder_days: current.filter(d => d !== days)
                            });
                          } else {
                            setFormData({
                              ...formData,
                              deadline_reminder_days: [...current, days].sort((a, b) => b - a)
                            });
                          }
                        }}
                      >
                        {days} day{days !== 1 ? 's' : ''}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div>
                  <Label>Notification Email</Label>
                  <p className="text-sm text-slate-500 mb-2">
                    Email address for automation alerts (optional)
                  </p>
                  <Input
                    type="email"
                    value={formData.notification_email}
                    onChange={(e) => 
                      setFormData({ ...formData, notification_email: e.target.value })
                    }
                    placeholder="your@email.com"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Save Button */}
            <div className="flex justify-end gap-3">
              <Button
                onClick={handleSave}
                disabled={saveMutation.isPending}
                size="lg"
                className="bg-blue-600 hover:bg-blue-700"
              >
                {saveMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4 mr-2" />
                    Save Settings
                  </>
                )}
              </Button>
            </div>

            {/* Info Alert */}
            <Alert className="mt-6 bg-blue-50 border-blue-200">
              <CheckCircle2 className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-900">
                <strong>ℹ️ How Automation Works:</strong>
                <ul className="list-disc list-inside mt-2 space-y-1 text-sm">
                  <li>Every night at midnight, system searches for grants matching your profile</li>
                  <li>New grants (scoring ≥{formData.min_match_score}%) are added to "Discovered"</li>
                  <li>Results are <strong>automatically ranked by match score</strong> (best matches first)</li>
                  <li>AI analyzes them and moves to "Interested" with insights</li>
                  <li>Grants auto-advance through Drafting → Application Prep</li>
                  <li>Automation stops at Portal/Print stages for your final review</li>
                  <li>All work is automatically billed to the profile</li>
                </ul>
              </AlertDescription>
            </Alert>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}