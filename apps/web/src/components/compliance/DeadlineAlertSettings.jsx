import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { Bell, Mail, Calendar, Save, Loader2, CheckCircle2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function DeadlineAlertSettings({ organizationId }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [formData, setFormData] = useState({
    deadline_alerts_enabled: true,
    deadline_reminder_days: [14, 7, 3, 1],
    notification_email: '',
    send_calendar_invites: true,
    alert_for_milestones: true,
    alert_for_reports: true,
    alert_for_deadlines: true
  });

  // Fetch settings
  const { data: settings, isLoading } = useQuery({
    queryKey: ['alertSettings', organizationId],
    queryFn: async () => {
      const allSettings = await base44.entities.AutomationSettings.filter({ 
        organization_id: organizationId 
      });
      return allSettings[0];
    },
    enabled: !!organizationId
  });

  // Load settings into form
  useEffect(() => {
    if (settings) {
      setFormData({
        deadline_alerts_enabled: settings.deadline_alerts_enabled ?? true,
        deadline_reminder_days: settings.deadline_reminder_days || [14, 7, 3, 1],
        notification_email: settings.notification_email || '',
        send_calendar_invites: settings.send_calendar_invites ?? true,
        alert_for_milestones: settings.alert_for_milestones ?? true,
        alert_for_reports: settings.alert_for_reports ?? true,
        alert_for_deadlines: settings.alert_for_deadlines ?? true
      });
    }
  }, [settings]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (settings) {
        return await base44.entities.AutomationSettings.update(settings.id, data);
      } else {
        return await base44.entities.AutomationSettings.create({
          ...data,
          organization_id: organizationId
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alertSettings'] });
      toast({
        title: '✅ Settings Saved',
        description: 'Alert preferences have been updated',
      });
    }
  });

  // Test alert mutation
  const testAlertMutation = useMutation({
    mutationFn: async () => {
      return await base44.functions.invoke('sendDeadlineAlerts', {
        body: {
          organization_id: organizationId
        }
      });
    },
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['grantAlerts'] });
      toast({
        title: '✉️ Alerts Sent',
        description: `Sent ${response.data.alerts_sent} deadline alert${response.data.alerts_sent !== 1 ? 's' : ''}`,
      });
    }
  });

  const handleSave = () => {
    saveMutation.mutate(formData);
  };

  const handleTestAlert = () => {
    testAlertMutation.mutate();
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Main Settings Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Bell className="w-5 h-5 text-blue-600" />
                Deadline Alert Settings
              </CardTitle>
              <CardDescription>
                Configure intelligent compliance deadline reminders
              </CardDescription>
            </div>
            <Switch
              checked={formData.deadline_alerts_enabled}
              onCheckedChange={(checked) => 
                setFormData({ ...formData, deadline_alerts_enabled: checked })
              }
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Reminder Days */}
          <div>
            <Label className="text-base font-semibold mb-3 block">
              Send Reminders At
            </Label>
            <p className="text-sm text-slate-500 mb-3">
              Select how many days before a deadline you'd like to receive alerts
            </p>
            <div className="flex flex-wrap gap-2">
              {[30, 21, 14, 7, 5, 3, 1].map(days => (
                <Badge
                  key={days}
                  variant={formData.deadline_reminder_days.includes(days) ? 'default' : 'outline'}
                  className="cursor-pointer hover:shadow-md transition-shadow"
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

          {/* Email Notifications */}
          <div>
            <Label className="text-base font-semibold mb-3 flex items-center gap-2">
              <Mail className="w-4 h-4 text-blue-600" />
              Email Notifications
            </Label>
            <p className="text-sm text-slate-500 mb-2">
              Email address to receive deadline alerts (optional)
            </p>
            <Input
              type="email"
              value={formData.notification_email}
              onChange={(e) => 
                setFormData({ ...formData, notification_email: e.target.value })
              }
              placeholder="your@email.com"
              disabled={!formData.deadline_alerts_enabled}
            />
          </div>

          {/* Alert Types */}
          <div>
            <Label className="text-base font-semibold mb-3 block">
              Alert Types
            </Label>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">Milestone Deadlines</p>
                  <p className="text-xs text-slate-500">Project milestones and deliverables</p>
                </div>
                <Switch
                  checked={formData.alert_for_milestones}
                  onCheckedChange={(checked) => 
                    setFormData({ ...formData, alert_for_milestones: checked })
                  }
                  disabled={!formData.deadline_alerts_enabled}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">Compliance Reports</p>
                  <p className="text-xs text-slate-500">Progress and financial reports</p>
                </div>
                <Switch
                  checked={formData.alert_for_reports}
                  onCheckedChange={(checked) => 
                    setFormData({ ...formData, alert_for_reports: checked })
                  }
                  disabled={!formData.deadline_alerts_enabled}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">Application Deadlines</p>
                  <p className="text-xs text-slate-500">Grant application due dates</p>
                </div>
                <Switch
                  checked={formData.alert_for_deadlines}
                  onCheckedChange={(checked) => 
                    setFormData({ ...formData, alert_for_deadlines: checked })
                  }
                  disabled={!formData.deadline_alerts_enabled}
                />
              </div>
            </div>
          </div>

          {/* Calendar Integration */}
          <div>
            <Label className="text-base font-semibold mb-3 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-blue-600" />
              Calendar Integration
            </Label>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Automatic Calendar Events</p>
                <p className="text-xs text-slate-500">Add deadlines to your calendar automatically</p>
              </div>
              <Switch
                checked={formData.send_calendar_invites}
                onCheckedChange={(checked) => 
                  setFormData({ ...formData, send_calendar_invites: checked })
                }
                disabled={!formData.deadline_alerts_enabled}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-4 border-t">
            <Button
              onClick={handleSave}
              disabled={saveMutation.isPending || !formData.deadline_alerts_enabled}
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

            <Button
              onClick={handleTestAlert}
              disabled={testAlertMutation.isPending || !formData.deadline_alerts_enabled}
              variant="outline"
            >
              {testAlertMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Mail className="w-4 h-4 mr-2" />
                  Send Test Alert
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Info Alert */}
      <Alert className="bg-blue-50 border-blue-200">
        <CheckCircle2 className="h-4 w-4 text-blue-600" />
        <AlertDescription className="text-blue-900">
          <strong>How Smart Alerts Work:</strong>
          <ul className="list-disc list-inside mt-2 space-y-1 text-sm">
            <li>AI analyzes each deadline and generates context-aware reminders</li>
            <li>Alerts are sent automatically via email at your chosen intervals</li>
            <li>In-app notifications keep you updated in real-time</li>
            <li>Calendar invites can be added automatically (coming soon)</li>
            <li>Mark milestones as complete to stop receiving reminders</li>
          </ul>
        </AlertDescription>
      </Alert>
    </div>
  );
}