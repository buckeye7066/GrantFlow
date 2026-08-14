import React, { useState, useEffect } from 'react';
import client from '@/api/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Loader2 } from 'lucide-react';

const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "Pacific/Honolulu"];

export default function SettingsTab() {
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState(null);

  const { data: initialSettings, isLoading } = useQuery({
    queryKey: ['billingSettings'],
    queryFn: () => client.entities.BillingSettings.list().then(res => res[0] || {}),
  });

  useEffect(() => {
    if (initialSettings && !settings) {
      setSettings(initialSettings);
    }
  }, [initialSettings]);

  const mutation = useMutation({
    mutationFn: (updatedSettings) => {
      if (updatedSettings.id) {
        return client.entities.BillingSettings.update(updatedSettings.id, updatedSettings);
      } else {
        return client.entities.BillingSettings.create(updatedSettings);
      }
    },
    onSuccess: (savedSettings) => {
      queryClient.invalidateQueries({ queryKey: ['billingSettings'] });
      setSettings(savedSettings);
    },
  });

  const handleSave = () => {
    if (!settings || Object.keys(settings).length === 0) {
      return;
    }
    mutation.mutate(settings);
  };

  const handleInputChange = (field, value) => {
    setSettings(prev => ({ ...prev, [field]: value }));
  };

  const handleNumberChange = (field, value) => {
    const num = value === "" ? null : parseFloat(value);
    setSettings(prev => ({ ...prev, [field]: isNaN(num) ? null : num }));
  };
  
  const handleIntChange = (field, value) => {
    const num = value === "" ? null : parseInt(value, 10);
    setSettings(prev => ({ ...prev, [field]: isNaN(num) ? null : num }));
  };

  if (isLoading || !settings) {
    return <div className="flex justify-center items-center p-8"><Loader2 className="w-8 h-8 animate-spin" /></div>;
  }
  
  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing & Invoice Settings</CardTitle>
        <CardDescription>Set system-wide defaults for time tracking, invoicing, and reminders. These can be overridden per client.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <div className="grid md:grid-cols-2 gap-8">
          {/* Column 1 */}
          <div className="space-y-6">
            <Card>
              <CardHeader><CardTitle className="text-lg">Rates & Currency</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div><Label>Default Hourly Rate</Label><Input type="number" value={settings.default_hourly_rate ?? ""} onChange={e => handleNumberChange('default_hourly_rate', e.target.value)} /></div>
                <div><Label>Travel Hourly Rate</Label><Input type="number" value={settings.travel_hourly_rate ?? ""} onChange={e => handleNumberChange('travel_hourly_rate', e.target.value)} /></div>
                <div><Label>Admin Hourly Rate</Label><Input type="number" value={settings.admin_hourly_rate ?? ""} onChange={e => handleNumberChange('admin_hourly_rate', e.target.value)} /></div>
                <div><Label>Currency</Label><Input value={settings.currency || ''} onChange={e => handleInputChange('currency', e.target.value)} /></div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-lg">Time Tracking</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div><Label>Time Increment (minutes)</Label><Input type="number" value={settings.time_increment_minutes ?? ""} onChange={e => handleIntChange('time_increment_minutes', e.target.value)} /></div>
                <div><Label>Minimum Billable (minutes)</Label><Input type="number" value={settings.minimum_billable_minutes || ''} onChange={e => handleIntChange('minimum_billable_minutes', e.target.value)} /></div>
                <div><Label>Idle Timeout (minutes)</Label><Input type="number" value={settings.idle_timeout_minutes || ''} onChange={e => handleIntChange('idle_timeout_minutes', e.target.value)} /></div>
              </CardContent>
            </Card>
          </div>
          {/* Column 2 */}
          <div className="space-y-6">
            <Card>
              <CardHeader><CardTitle className="text-lg">Invoice Generation</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div><Label>Invoice Day</Label><Select value={settings.invoice_day_of_week} onValueChange={v => handleInputChange('invoice_day_of_week', v)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{WEEKDAYS.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent></Select></div>
                <div><Label>Send Time (24h)</Label><Input value={settings.invoice_send_time_local || ''} onChange={e => handleInputChange('invoice_send_time_local', e.target.value)} /></div>
                <div><Label>Timezone</Label><Select value={settings.timezone} onValueChange={v => handleInputChange('timezone', v)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{TIMEZONES.map(tz => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}</SelectContent></Select></div>
                <div><Label>Review Lead Time (minutes before send)</Label><Input type="number" value={settings.prebill_review_lead_minutes || ''} onChange={e => handleIntChange('prebill_review_lead_minutes', e.target.value)} /></div>
                <div className="flex items-center space-x-2 pt-2"><Switch id="approval-switch" checked={settings.auto_email_requires_approval} onCheckedChange={v => handleInputChange('auto_email_requires_approval', v)} /><Label htmlFor="approval-switch">Require Approval Before Sending</Label></div>
                <div><Label>Invoice Number Format</Label><Input value={settings.invoice_number_format || ''} onChange={e => handleInputChange('invoice_number_format', e.target.value)} /></div>
              </CardContent>
            </Card>
             <Card>
              <CardHeader><CardTitle className="text-lg">Payment Terms</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div><Label>Net Terms (days)</Label><Input type="number" value={settings.net_terms_days || ''} onChange={e => handleIntChange('net_terms_days', e.target.value)} /></div>
                <div><Label>Late Fee (monthly %)</Label><Input type="number" value={settings.late_fee_monthly_percent || ''} onChange={e => handleNumberChange('late_fee_monthly_percent', e.target.value)} /></div>
                <div><Label>Default Tax Rate (%)</Label><Input type="number" value={settings.tax_percent || ''} onChange={e => handleNumberChange('tax_percent', e.target.value)} /></div>
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="pt-6 border-t">
            <Card>
                <CardHeader><CardTitle className="text-lg">Email Templates</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                    <div><Label>From Email</Label><Input type="email" value={settings.default_email_from || ''} onChange={e => handleInputChange('default_email_from', e.target.value)} /></div>
                    <div><Label>Default Subject</Label><Input value={settings.default_email_subject || ''} onChange={e => handleInputChange('default_email_subject', e.target.value)} /></div>
                    <div><Label>Default Email Body</Label><Textarea value={settings.default_email_template || ''} onChange={e => handleInputChange('default_email_template', e.target.value)} className="h-40" /></div>
                </CardContent>
            </Card>
        </div>

        <div className="flex justify-end pt-6 border-t">
          <Button onClick={handleSave} disabled={mutation.isPending}>
            {mutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...</> : 'Save Settings'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}