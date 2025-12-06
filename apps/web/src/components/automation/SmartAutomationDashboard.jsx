import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { callFunction } from '@/components/shared/functionClient';
import { 
  Search, 
  FileText, 
  Calendar, 
  Zap, 
  Loader2, 
  CheckCircle2,
  AlertCircle,
  TrendingUp,
  Clock
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

export default function SmartAutomationDashboard({ organizationId }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expandedLog, setExpandedLog] = useState(null);

  // Fetch automation settings
  const { data: settings = [], refetch: refetchSettings } = useQuery({
    queryKey: ['automationSettings', organizationId],
    queryFn: () => organizationId 
      ? base44.entities.AutomationSettings.filter({ organization_id: organizationId })
      : base44.entities.AutomationSettings.list(),
  });

  const currentSettings = settings[0] || {
    auto_discovery_enabled: true,
    auto_proposal_enabled: true,
    auto_compliance_enabled: true,
    auto_advance_enabled: true
  };

  // Update settings mutation
  const updateSettingsMutation = useMutation({
    mutationFn: async (newSettings) => {
      if (currentSettings.id) {
        return await base44.entities.AutomationSettings.update(currentSettings.id, newSettings);
      } else if (organizationId) {
        return await base44.entities.AutomationSettings.create({
          organization_id: organizationId,
          ...newSettings
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automationSettings'] });
      toast({
        title: 'Settings Updated',
        description: 'Automation preferences saved successfully.',
      });
    }
  });

  // Run automation mutation
  const runAutomationMutation = useMutation({
    mutationFn: async (automationType) => {
      const result = await callFunction('runSmartAutomation', {
        automation_type: automationType,
        organization_id: organizationId
      });
      if (!result.ok) {
        throw new Error(result.error || 'Automation failed');
      }
      return result.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      queryClient.invalidateQueries({ queryKey: ['proposalSections'] });
      queryClient.invalidateQueries({ queryKey: ['milestones'] });
      
      toast({
        title: 'Automation Complete',
        description: `Completed ${data.results.total_actions} action${data.results.total_actions !== 1 ? 's' : ''}.`,
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Automation Failed',
        description: error.message || 'Failed to run automation',
      });
    }
  });

  const automations = [
    {
      id: 'discovery',
      title: 'Smart Grant Discovery',
      description: 'Automatically find and add high-scoring grant matches to your pipeline',
      icon: Search,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50',
      enabled: currentSettings.auto_discovery_enabled !== false,
      settingKey: 'auto_discovery_enabled'
    },
    {
      id: 'proposals',
      title: 'AI Proposal Writer',
      description: 'Auto-populate proposal sections using organization data and AI',
      icon: FileText,
      color: 'text-purple-600',
      bgColor: 'bg-purple-50',
      enabled: currentSettings.auto_proposal_enabled !== false,
      settingKey: 'auto_proposal_enabled'
    },
    {
      id: 'compliance',
      title: 'Compliance Tracker',
      description: 'Automatically create milestones and reports for awarded grants',
      icon: Calendar,
      color: 'text-green-600',
      bgColor: 'bg-green-50',
      enabled: currentSettings.auto_compliance_enabled !== false,
      settingKey: 'auto_compliance_enabled'
    }
  ];

  const handleToggle = (settingKey, currentValue) => {
    updateSettingsMutation.mutate({
      [settingKey]: !currentValue
    });
  };

  const handleRunAutomation = (automationType) => {
    runAutomationMutation.mutate(automationType);
  };

  const handleRunAll = () => {
    runAutomationMutation.mutate('all');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Smart Automation</h2>
          <p className="text-slate-600 mt-1">AI-powered workflows to streamline grant management</p>
        </div>
        <Button
          onClick={handleRunAll}
          disabled={runAutomationMutation.isPending}
          className="bg-blue-600 hover:bg-blue-700"
        >
          {runAutomationMutation.isPending ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Running...
            </>
          ) : (
            <>
              <Zap className="w-4 h-4 mr-2" />
              Run All Automations
            </>
          )}
        </Button>
      </div>

      {/* Automation Cards */}
      <div className="grid md:grid-cols-3 gap-6">
        {automations.map((automation) => {
          const Icon = automation.icon;
          const isRunning = runAutomationMutation.isPending;
          
          return (
            <Card key={automation.id} className="relative overflow-hidden">
              <div className={`absolute top-0 left-0 right-0 h-1 ${automation.enabled ? 'bg-green-500' : 'bg-slate-300'}`} />
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className={`p-3 rounded-lg ${automation.bgColor}`}>
                    <Icon className={`w-6 h-6 ${automation.color}`} />
                  </div>
                  <Switch
                    checked={automation.enabled}
                    onCheckedChange={() => handleToggle(automation.settingKey, automation.enabled)}
                    disabled={updateSettingsMutation.isPending}
                  />
                </div>
                <CardTitle className="text-lg mt-4">{automation.title}</CardTitle>
                <CardDescription className="text-sm">
                  {automation.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={() => handleRunAutomation(automation.id)}
                  disabled={!automation.enabled || isRunning}
                  variant="outline"
                  className="w-full"
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
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Results Display */}
      {runAutomationMutation.isSuccess && runAutomationMutation.data?.results && (
        <Card className="border-green-200 bg-green-50">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              <CardTitle className="text-green-900">Automation Results</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-green-800">Total Actions:</span>
                <Badge variant="outline" className="bg-white">
                  {runAutomationMutation.data.results.total_actions}
                </Badge>
              </div>
              
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {runAutomationMutation.data.results.actions_taken.map((action, idx) => (
                  <div key={idx} className="p-3 bg-white rounded-lg border border-green-200">
                    <div className="flex items-start gap-2">
                      {action.type === 'discovery' && <Search className="w-4 h-4 text-blue-600 mt-0.5" />}
                      {action.type === 'proposal' && <FileText className="w-4 h-4 text-purple-600 mt-0.5" />}
                      {action.type === 'compliance' && <Calendar className="w-4 h-4 text-green-600 mt-0.5" />}
                      <div className="flex-1 text-sm">
                        {action.error ? (
                          <p className="text-red-600">{action.error}</p>
                        ) : (
                          <>
                            <p className="font-medium text-slate-900">
                              {action.action?.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                            </p>
                            {action.org && <p className="text-slate-600 text-xs mt-1">Organization: {action.org}</p>}
                            {action.grant && <p className="text-slate-600 text-xs">Grant: {action.grant}</p>}
                            {action.section && <p className="text-slate-600 text-xs">Section: {action.section}</p>}
                            {action.milestone && <p className="text-slate-600 text-xs">Milestone: {action.milestone}</p>}
                            {action.score && (
                              <Badge variant="outline" className="mt-1 text-xs">
                                Match: {action.score}%
                              </Badge>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Info Alert */}
      <Alert>
        <Clock className="h-4 w-4" />
        <AlertDescription>
          <strong>Pro Tip:</strong> These automations can be scheduled to run automatically. 
          Contact support to set up daily or weekly automation schedules for your organization.
        </AlertDescription>
      </Alert>
    </div>
  );
}