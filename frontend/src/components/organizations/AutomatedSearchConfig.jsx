import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Loader2, Zap, CheckCircle, Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { format } from 'date-fns';

export default function AutomatedSearchConfig({ organization, open, onClose }) {
  const queryClient = useQueryClient();
  const [config, setConfig] = useState({
    enabled: true,
    search_frequency: 'weekly',
    search_time: '08:00',
    notify_email: true,
    min_match_score: 60,
  });

  const { data: existingConfig, isLoading: isLoadingConfig } = useQuery({
    queryKey: ['automatedSearch', organization.id],
    queryFn: () => base44.entities.AutomatedSearch.filter({ organization_id: organization.id }).then(res => res[0]),
    enabled: !!organization.id && open,
  });

  useEffect(() => {
    if (existingConfig) {
      setConfig({
        enabled: Boolean(existingConfig.enabled),
        search_frequency: existingConfig.search_frequency || 'weekly',
        search_time: existingConfig.search_time || '08:00',
        notify_email: Boolean(existingConfig.notify_email),
        min_match_score: Number(existingConfig.min_match_score ?? 60),
      });
    } else if (open) {
        setConfig({
            enabled: true,
            search_frequency: 'weekly',
            search_time: '08:00',
            notify_email: true,
            min_match_score: 60,
        });
    }
  }, [existingConfig, open]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['automatedSearch', organization.id] });
    queryClient.invalidateQueries({ queryKey: ['grants'] });
  };

  const mutation = useMutation({
    mutationFn: (data) => {
      const payload = {
        ...data,
        organization_id: organization.id,
        min_match_score: Number(data.min_match_score ?? 0),
      };
      if (existingConfig?.id) {
        return base44.entities.AutomatedSearch.update(existingConfig.id, payload);
      }
      return base44.entities.AutomatedSearch.create(payload);
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const runNowMutation = useMutation({
    // FIX: invoke must use { body }, include organization_id
    mutationFn: async () => {
      const { data, error } = await base44.functions.invoke('runAutomatedDiscovery', {
        body: { organization_id: organization.id },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      invalidate();
    },
  });

  const handleSave = () => {
    mutation.mutate(config);
  };

  const handleRunNow = () => {
    // First save the config, then run discovery
    if (!existingConfig) {
      mutation.mutate(config, {
        onSuccess: () => {
          runNowMutation.mutate();
        }
      });
    } else {
      runNowMutation.mutate();
    }
  };

  const isSaving = mutation.isPending;
  const isRunning = runNowMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-blue-600" />
            Automated Discovery Settings
          </DialogTitle>
          <DialogDescription>
            Configure automatic searches for "{organization.name}". The system will regularly scan all data sources, match opportunities against this profile, and automatically add high-scoring grants to your pipeline.
          </DialogDescription>
        </DialogHeader>
        
        {isLoadingConfig ? (
          <div className="flex justify-center items-center h-40">
            <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
          </div>
        ) : (
          <div className="space-y-6 py-4">
            <Alert className="bg-blue-50 border-blue-200">
              <Info className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800 text-sm">
                When enabled, GrantFlow will automatically search Grants.gov, Benefits.gov, DSIRE, and other sources. High-scoring matches will be added to your "Discovered" pipeline stage and you'll receive email notifications.
              </AlertDescription>
            </Alert>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
              <Label htmlFor="enabled-switch" className="text-base font-medium">
                Enable Automated Discovery
              </Label>
              <Switch
                id="enabled-switch"
                checked={config.enabled}
                onCheckedChange={(checked) => setConfig({ ...config, enabled: checked })}
              />
            </div>
            
            <div className="space-y-2">
              <Label>Search Frequency</Label>
              <Select
                value={config.search_frequency}
                onValueChange={(value) => setConfig({ ...config, search_frequency: value })}
                disabled={!config.enabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Every 2 Weeks</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500">How often to scan for new opportunities</p>
            </div>

            <div className="space-y-2">
              <Label>Search Time (EST)</Label>
              <Input
                type="time"
                value={config.search_time}
                onChange={(e) => setConfig({ ...config, search_time: e.target.value })}
                disabled={!config.enabled}
              />
              <p className="text-xs text-slate-500">What time of day to run the search</p>
            </div>

            <div className="space-y-3">
              <Label>Minimum Match Score: {config.min_match_score}%</Label>
              <Slider
                value={[config.min_match_score]}
                onValueChange={(values) => setConfig({ ...config, min_match_score: values[0] })}
                min={0}
                max={100}
                step={5}
                disabled={!config.enabled}
                className="w-full"
              />
              <p className="text-xs text-slate-500">
                Only opportunities scoring above this threshold will be automatically added to your pipeline.
              </p>
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="notify-switch" className="flex-grow">
                Send Email Notifications
              </Label>
              <Switch
                id="notify-switch"
                checked={config.notify_email}
                onCheckedChange={(checked) => setConfig({ ...config, notify_email: checked })}
                disabled={!config.enabled}
              />
            </div>

            {existingConfig?.last_run_date && (
                <div className="text-sm text-slate-500 pt-4 border-t">
                    <p>Last run: {format(new Date(existingConfig.last_run_date), "PPp")}</p>
                    <p>Opportunities found: {existingConfig.last_results_count || 0}</p>
                </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={isSaving || isRunning}>
            Cancel
          </Button>
          {config.enabled && (
            <Button 
              variant="outline"
              onClick={handleRunNow} 
              disabled={isSaving || isRunning || isLoadingConfig}
            >
              {isRunning ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 mr-2" />
                  Run Now
                </>
              )}
            </Button>
          )}
          <Button onClick={handleSave} disabled={isSaving || isRunning || isLoadingConfig}>
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
                <>
                <CheckCircle className="w-4 h-4 mr-2" />
                Save Settings
                </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}