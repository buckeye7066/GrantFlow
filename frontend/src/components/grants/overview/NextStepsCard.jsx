import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  Clock, 
  AlertCircle, 
  CheckCircle, 
  TrendingUp,
  FileCheck,
  Send,
  Calendar
} from 'lucide-react';
import { differenceInDays, format } from 'date-fns';
import { parseDateSafe } from '@/components/shared/dateUtils';

/**
 * NextStepsCard - Shows actionable next steps based on grant status and deadline
 */
export default function NextStepsCard({ grant, onAction }) {
  const deadline = parseDateSafe(grant.deadline);
  const daysUntilDeadline = deadline ? differenceInDays(deadline, new Date()) : null;
  
  const getUrgencyLevel = () => {
    if (!daysUntilDeadline || grant.deadline?.toLowerCase() === 'rolling') return 'normal';
    if (daysUntilDeadline < 0) return 'expired';
    if (daysUntilDeadline <= 7) return 'critical';
    if (daysUntilDeadline <= 14) return 'urgent';
    if (daysUntilDeadline <= 30) return 'moderate';
    return 'normal';
  };

  const urgency = getUrgencyLevel();

  const urgencyConfig = {
    expired: {
      icon: AlertCircle,
      color: 'text-red-600',
      bgColor: 'bg-red-50',
      borderColor: 'border-red-200',
      badge: 'Expired',
      badgeVariant: 'destructive'
    },
    critical: {
      icon: AlertCircle,
      color: 'text-red-600',
      bgColor: 'bg-red-50',
      borderColor: 'border-red-300',
      badge: 'Critical - Due Soon!',
      badgeVariant: 'destructive'
    },
    urgent: {
      icon: Clock,
      color: 'text-amber-600',
      bgColor: 'bg-amber-50',
      borderColor: 'border-amber-300',
      badge: 'Urgent',
      badgeVariant: 'default'
    },
    moderate: {
      icon: TrendingUp,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50',
      borderColor: 'border-blue-200',
      badge: 'Active',
      badgeVariant: 'secondary'
    },
    normal: {
      icon: CheckCircle,
      color: 'text-slate-600',
      bgColor: 'bg-slate-50',
      borderColor: 'border-slate-200',
      badge: 'On Track',
      badgeVariant: 'outline'
    }
  };

  const config = urgencyConfig[urgency];
  const Icon = config.icon;

  const getNextSteps = () => {
    const steps = [];

    // Status-based steps
    if (grant.status === 'discovered') {
      steps.push({
        title: 'Review Eligibility',
        description: 'Ensure your profile matches the eligibility requirements',
        action: 'View Eligibility',
        actionKey: 'eligibility'
      });
      steps.push({
        title: 'Mark Interest Level',
        description: 'Move to "Interested" if this is a good fit',
        action: 'Mark as Interested',
        actionKey: 'mark_interested'
      });
    }

    if (grant.status === 'interested') {
      steps.push({
        title: 'Gather Required Documents',
        description: 'Review what documents will be needed for the application',
        action: 'View Requirements',
        actionKey: 'requirements'
      });
      steps.push({
        title: 'Start Application Process',
        description: 'Move forward with drafting your application',
        action: 'Start Drafting',
        actionKey: 'start_draft'
      });
    }

    if (grant.status === 'drafting') {
      steps.push({
        title: 'Complete Application Sections',
        description: 'Continue working on your proposal narrative',
        action: 'Open Coach',
        actionKey: 'coach'
      });
      
      if (!grant.contact_verified) {
        steps.push({
          title: 'Verify Contact Information',
          description: 'Ensure funder contact details are correct before submission',
          action: 'Verify Now',
          actionKey: 'verify_contact'
        });
      }
    }

    if (grant.status === 'portal' || grant.status === 'application_prep') {
      steps.push({
        title: 'Prepare Final Submission',
        description: 'Review all sections and gather supporting documents',
        action: 'Review Checklist',
        actionKey: 'checklist'
      });
      steps.push({
        title: 'Submit Application',
        description: 'Submit before the deadline',
        action: 'Submit Now',
        actionKey: 'submit'
      });
    }

    if (grant.status === 'submitted') {
      steps.push({
        title: 'Track Decision Timeline',
        description: 'Monitor for decision notifications from the funder',
        action: 'Set Reminders',
        actionKey: 'reminders'
      });
    }

    // Deadline-based urgency steps
    if (urgency === 'critical' || urgency === 'urgent') {
      steps.unshift({
        title: `⚠️ Deadline in ${daysUntilDeadline} day${daysUntilDeadline !== 1 ? 's' : ''}`,
        description: 'Prioritize completing this application immediately',
        action: 'Work on Application',
        actionKey: 'urgent_action',
        urgent: true
      });
    }

    return steps;
  };

  const steps = getNextSteps();

  if (steps.length === 0) return null;

  return (
    <Card className={`border-2 ${config.borderColor} ${config.bgColor}`}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Icon className={`w-5 h-5 ${config.color}`} />
            <span>Next Steps</span>
          </CardTitle>
          <Badge variant={config.badgeVariant}>{config.badge}</Badge>
        </div>
        
        {deadline && urgency !== 'expired' && (
          <div className="flex items-center gap-2 mt-2 text-sm text-slate-600">
            <Calendar className="w-4 h-4" />
            <span>
              Deadline: {(() => {
                try {
                  return format(deadline, 'MMM d, yyyy');
                } catch {
                  return 'Invalid date';
                }
              })()}
              {daysUntilDeadline !== null && ` (${daysUntilDeadline} days)`}
            </span>
          </div>
        )}
      </CardHeader>
      
      <CardContent className="space-y-3">
        {steps.map((step, index) => (
          <div 
            key={index}
            className={`p-4 bg-white rounded-lg border ${step.urgent ? 'border-red-300' : 'border-slate-200'} hover:shadow-md transition-shadow`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <h4 className={`font-semibold text-sm ${step.urgent ? 'text-red-900' : 'text-slate-900'} mb-1`}>
                  {step.title}
                </h4>
                <p className="text-xs text-slate-600">{step.description}</p>
              </div>
              <Button 
                size="sm" 
                variant={step.urgent ? "default" : "outline"}
                className={step.urgent ? "bg-red-600 hover:bg-red-700 shrink-0" : "shrink-0"}
                onClick={() => onAction && onAction(step.actionKey)}
              >
                {step.action}
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}