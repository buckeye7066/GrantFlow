import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
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

const INTEGER_FIELDS = ['time_increment_minutes', 'minimum_billable_minutes', 'idle_timeout_minutes', 'prebill_review_lead_minutes', 'net_terms_days'];
const FLOAT_FIELDS = ['default_hourly_rate', 'travel_hourly_rate', 'admin_hourly_rate', 'late_fee_monthly_percent', 'tax_percent'];

const handleFieldChange = (field, value, setSettings) => {
  setSettings(prev => {
    if (INTEGER_FIELDS.includes(field)) {
      const num = parseInt(value, 10);
      return { ...prev, [field]: isNaN(num) ? 0 : num };
    }
    if (FLOAT_FIELDS.includes(field)) {
      const num = parseFloat(value);
      return { ...prev, [field]: isNaN(num) ? 0 : num };
    }
    return { ...prev, [field]: value };
  });
};

export default function SettingsTab() {
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState(null);

  const { data: initialSettings, isLoading } = useQuery({
    queryKey: ['billingSettings'],
    queryFn: () => base44.entities.BillingSettings.list().then(res => res[0] || {}),
  });

  useEffect(() => {
    if (initialSettings) {
      setSettings(initialSettings);
    }
  }, [initialSettings]);

  const mutation = useMutation({
    mutationFn: (updatedSettings) => {
      if (updatedSettings.id) {
        return base44.entities.BillingSettings.update(updatedSettings.id, updatedSettings);
      } else {
        return base44.entities.BillingSettings.create(updatedSettings);
      }
    },
    onSuccess: (savedSettings) => {
      queryClient.setQueryData(['billingSettings'], savedSettings);
      setSettings(savedSettings);
    },
  });

  const handleSave = () => {
    mutation.mutate(settings);
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
          <div className="space-y-6">
            <Card>
              <CardHeader><CardTitle className="text-lg">Rates & Currency</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Default Hourly Rate</Label>
                  <Input type="number" min="0" step="0.01" value={settings.default_hourly_rate || ''} onChange={e => handleFieldChange('default_hourly_rate', e.target.value, setSettings)} />
                </div>
                <div>
                  <Label>Travel Hourly Rate</Label>
                  <Input type="number" min="0" step="0.01" value={settings.travel_hourly_rate || ''} onChange={e => handleFieldChange('travel_hourly_rate', e.target.value, setSettings)} />
                </div>
                <div>
                  <Label>Admin Hourly Rate</Label>
                  <Input type="number" min="0" step="0.01" value={settings.admin_hourly_rate || ''} onChange={e => handleFieldChange('admin_hourly_rate', e.target.value, setSettings)} />
                </div>
                <div>
                  <Label>Currency</Label>
                  <Input value={settings.currency || ''} onChange={e => handleFieldChange('currency', e.target.value, setSettings)} />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-lg">Time Tracking</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Time Increment (minutes)</Label>
                  <Input type="number" min="1" max="60" value={settings.time_increment_minutes || ''} onChange={e => handleFieldChange('time_increment_minutes', e.target.value, setSettings)} />
                </div>
                <div>
                  <Label>Minimum Billable (minutes)</Label>
                  <Input type="number" min="0" max="120" value={settings.minimum_billable_minutes || ''} onChange={e => handleFieldChange('minimum_billable_minutes', e.target.value, setSettings)} />
                </div>
                <div>
                  <Label>Idle Timeout (minutes)</Label>
                  <Input type="number" min="1" max="60" value={settings.idle_timeout_minutes || ''} onChange={e => handleFieldChange('idle_timeout_minutes', e.target.value, setSettings)} />
                </div>
              </CardContent>
            </Card>
          </div>
          <div className="space-y-6">
            <Card>
              <CardHeader><CardTitle className="text-lg">Invoice Generation</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Invoice Day</Label>
                  <Select value={settings.invoice_day_of_week} onValueChange={v => handleFieldChange('invoice_day_of_week', v, setSettings)}>
                    <SelectTrigger><SelectValue/></SelectTrigger>
                    <SelectContent>{WEEKDAYS.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Send Time (24h)</Label>
                  <Input value={settings.invoice_send_time_local || ''} onChange={e => handleFieldChange('invoice_send_time_local', e.target.value, setSettings)} />
                </div>
                <div>
                  <Label>Timezone</Label>
                  <Select value={settings.timezone} onValueChange={v => handleFieldChange('timezone', v, setSettings)}>
                    <SelectTrigger><SelectValue/></SelectTrigger>
                    <SelectContent>{TIMEZONES.map(tz => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Review Lead Time (minutes before send)</Label>
                  <Input type="number" min="0" max="1440" value={settings.prebill_review_lead_minutes || ''} onChange={e => handleFieldChange('prebill_review_lead_minutes', e.target.value, setSettings)} />
                </div>
                <div className="flex items-center space-x-2 pt-2">
                  <Switch id="approval-switch" checked={settings.auto_email_requires_approval} onCheckedChange={v => handleFieldChange('auto_email_requires_approval', v, setSettings)} />
                  <Label htmlFor="approval-switch">Require Approval Before Sending</Label>
                </div>
                <div>
                  <Label>Invoice Number Format</Label>
                  <Input value={settings.invoice_number_format || ''} onChange={e => handleFieldChange('invoice_number_format', e.target.value, setSettings)} />
                  <p className="text-xs text-slate-500 mt-1">Use placeholders: &#123;&#123;YYYY&#125;&#125;, &#123;&#123;MM&#125;&#125;, &#123;&#123;seq&#125;&#125; (e.g., INV-&#123;&#123;YYYY&#125;&#125;&#123;&#123;MM&#125;&#125;-&#123;&#123;seq&#125;&#125;)</p>
                </div>
              </CardContent>
            </Card>
             <Card>
              <CardHeader><CardTitle className="text-lg">Payment Terms</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Net Terms (days)</Label>
                  <Input type="number" min="0" max="365" value={settings.net_terms_days || ''} onChange={e => handleFieldChange('net_terms_days', e.target.value, setSettings)} />
                </div>
                <div>
                  <Label>Late Fee (monthly %)</Label>
                  <Input type="number" min="0" max="100" step="0.1" value={settings.late_fee_monthly_percent || ''} onChange={e => handleFieldChange('late_fee_monthly_percent', e.target.value, setSettings)} />
                </div>
                <div>
                  <Label>Default Tax Rate (%)</Label>
                  <Input type="number" min="0" max="100" step="0.01" value={settings.tax_percent || ''} onChange={e => handleFieldChange('tax_percent', e.target.value, setSettings)} />
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="pt-6 border-t">
            <Card>
                <CardHeader><CardTitle className="text-lg">Email Templates</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                    <div>
                      <Label>From Email</Label>
                      <Input type="email" value={settings.default_email_from || ''} onChange={e => handleFieldChange('default_email_from', e.target.value, setSettings)} />
                    </div>
                    <div>
                      <Label>Default Subject</Label>
                      <Input value={settings.default_email_subject || ''} onChange={e => handleFieldChange('default_email_subject', e.target.value, setSettings)} />
                      <p className="text-xs text-slate-500 mt-1">Use placeholders: &#123;&#123;invoiceNumber&#125;&#125;, &#123;&#123;clientName&#125;&#125;</p>
                    </div>
                    <div>
                      <Label>Default Email Body</Label>
                      <Textarea value={settings.default_email_template || ''} onChange={e => handleFieldChange('default_email_template', e.target.value, setSettings)} className="h-40" />
                      <p className="text-xs text-slate-500 mt-1">Customize the email message sent with invoices. Supports plain text and basic formatting.</p>
                    </div>
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