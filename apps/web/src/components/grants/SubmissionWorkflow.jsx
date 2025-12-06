import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  CheckCircle,
  AlertTriangle,
  Clock,
  FileText,
  DollarSign,
  Send,
  Loader2,
  Sparkles,
  AlertCircle,
  Calendar,
  User
} from 'lucide-react';
import { toast } from 'sonner';

export default function SubmissionWorkflow({ grantId, onSubmitted }) {
  const [step, setStep] = useState('review'); // review, polish, confirm, submit
  const [preparationData, setPreparationData] = useState(null);
  const [submissionData, setSubmissionData] = useState({
    submission_method: 'online',
    submission_notes: '',
    confirmation_number: '',
    acknowledge_deadline: false
  });
  const [showDialog, setShowDialog] = useState(false);
  const queryClient = useQueryClient();

  const prepareMutation = useMutation({
    mutationFn: async (performPolish) => {
      const response = await base44.functions.invoke('prepareGrantSubmission', {
        body: {
          grant_id: grantId,
          perform_ai_polish: performPolish
        }
      });
      return response.data;
    },
    onSuccess: (data) => {
      setPreparationData(data);
      if (data.success) {
        toast.success('Submission package prepared');
        if (data.ai_polish_results) {
          setStep('polish');
        } else {
          setStep('confirm');
        }
      }
    },
    onError: () => {
      toast.error('Failed to prepare submission');
    }
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      const response = await base44.functions.invoke('submitGrant', {
        body: {
          grant_id: grantId,
          ...submissionData
        }
      });
      return response.data;
    },
    onSuccess: (data) => {
      if (data.success) {
        toast.success('Grant submitted successfully!');
        queryClient.invalidateQueries({ queryKey: ['grants'] });
        setShowDialog(false);
        if (onSubmitted) onSubmitted();
      }
    },
    onError: (error) => {
      toast.error(error.message || 'Submission failed');
    }
  });

  const handleStartReview = (withPolish = true) => {
    prepareMutation.mutate(withPolish);
  };

  const handleSubmit = () => {
    if (preparationData?.deadline_status === 'overdue' && !submissionData.acknowledge_deadline) {
      toast.error('Please acknowledge the deadline status');
      return;
    }
    submitMutation.mutate();
  };

  const getReadinessColor = (score) => {
    if (score >= 80) return 'text-green-600 bg-green-50';
    if (score >= 60) return 'text-yellow-600 bg-yellow-50';
    return 'text-red-600 bg-red-50';
  };

  const getDeadlineIcon = (status) => {
    switch (status) {
      case 'overdue': return <AlertTriangle className="w-5 h-5 text-red-600" />;
      case 'urgent': return <Clock className="w-5 h-5 text-orange-600" />;
      case 'soon': return <Clock className="w-5 h-5 text-yellow-600" />;
      default: return <Calendar className="w-5 h-5 text-blue-600" />;
    }
  };

  return (
    <>
      <Button onClick={() => setShowDialog(true)} className="gap-2">
        <Send className="w-4 h-4" />
        Submit Grant
      </Button>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-5 h-5 text-blue-600" />
              Grant Submission Workflow
            </DialogTitle>
            <DialogDescription>
              Review, polish, and submit your grant application
            </DialogDescription>
          </DialogHeader>

          {step === 'review' && (
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Ready to Submit?</CardTitle>
                  <CardDescription>
                    We'll review your application for completeness and quality
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-slate-700">
                    This process will:
                  </p>
                  <ul className="space-y-2 text-sm text-slate-600">
                    <li className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-green-600 mt-0.5" />
                      Check completeness of all sections
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-green-600 mt-0.5" />
                      Verify budget and supporting documents
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-green-600 mt-0.5" />
                      Review deadline status
                    </li>
                    <li className="flex items-start gap-2">
                      <Sparkles className="w-4 h-4 text-purple-600 mt-0.5" />
                      AI analysis for final polish (optional)
                    </li>
                  </ul>
                  <div className="flex gap-3 pt-4">
                    <Button 
                      onClick={() => handleStartReview(true)}
                      disabled={prepareMutation.isPending}
                      className="flex-1"
                    >
                      {prepareMutation.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Preparing...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4 mr-2" />
                          Review with AI Polish
                        </>
                      )}
                    </Button>
                    <Button 
                      onClick={() => handleStartReview(false)}
                      disabled={prepareMutation.isPending}
                      variant="outline"
                      className="flex-1"
                    >
                      Quick Review Only
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {step === 'polish' && preparationData?.ai_polish_results && (
            <div className="space-y-4">
              <Card className={preparationData.ai_polish_results.submission_ready ? 'border-green-300' : 'border-yellow-300'}>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-purple-600" />
                    AI Quality Assessment
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant={preparationData.ai_polish_results.submission_ready ? 'default' : 'secondary'}>
                      Quality Score: {preparationData.ai_polish_results.overall_quality_score}/100
                    </Badge>
                    {preparationData.ai_polish_results.submission_ready ? (
                      <Badge className="bg-green-100 text-green-800">Ready to Submit</Badge>
                    ) : (
                      <Badge className="bg-yellow-100 text-yellow-800">Improvements Recommended</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {preparationData.ai_polish_results.critical_issues?.length > 0 && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                      <h4 className="font-semibold text-sm text-red-900 mb-2 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4" />
                        Critical Issues
                      </h4>
                      <ul className="space-y-1">
                        {preparationData.ai_polish_results.critical_issues.map((issue, idx) => (
                          <li key={idx} className="text-sm text-red-800">• {issue}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {preparationData.ai_polish_results.strengths?.length > 0 && (
                    <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                      <h4 className="font-semibold text-sm text-green-900 mb-2">Strengths</h4>
                      <ul className="space-y-1">
                        {preparationData.ai_polish_results.strengths.map((strength, idx) => (
                          <li key={idx} className="text-sm text-green-800">• {strength}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {preparationData.ai_polish_results.recommended_improvements?.length > 0 && (
                    <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                      <h4 className="font-semibold text-sm text-blue-900 mb-2">Recommended Improvements</h4>
                      <ul className="space-y-1">
                        {preparationData.ai_polish_results.recommended_improvements.map((improvement, idx) => (
                          <li key={idx} className="text-sm text-blue-800">• {improvement}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="pt-4 border-t">
                    <p className="text-sm text-slate-700 mb-3">
                      <strong>Final Recommendation:</strong> {preparationData.ai_polish_results.final_recommendations}
                    </p>
                    <Button onClick={() => setStep('confirm')} className="w-full">
                      Continue to Submission Details
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {step === 'confirm' && preparationData && (
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Submission Readiness</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className={`p-4 rounded-lg ${getReadinessColor(preparationData.readiness_score)}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">Overall Readiness</span>
                      <Badge variant="outline">{preparationData.readiness_score}%</Badge>
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <div className="flex items-center gap-2 mb-2">
                        <FileText className="w-4 h-4 text-blue-600" />
                        <span className="font-medium text-sm">Proposal</span>
                      </div>
                      <p className="text-sm text-slate-600">
                        {preparationData.submission_package.proposal_sections.length} sections
                        {preparationData.completeness.has_proposal ? 
                          <CheckCircle className="w-4 h-4 text-green-600 inline ml-2" /> :
                          <AlertTriangle className="w-4 h-4 text-red-600 inline ml-2" />
                        }
                      </p>
                    </div>

                    <div className="p-3 bg-slate-50 rounded-lg">
                      <div className="flex items-center gap-2 mb-2">
                        <DollarSign className="w-4 h-4 text-green-600" />
                        <span className="font-medium text-sm">Budget</span>
                      </div>
                      <p className="text-sm text-slate-600">
                        ${preparationData.submission_package.budget.total.toLocaleString()}
                        {preparationData.completeness.has_budget ? 
                          <CheckCircle className="w-4 h-4 text-green-600 inline ml-2" /> :
                          <AlertTriangle className="w-4 h-4 text-red-600 inline ml-2" />
                        }
                      </p>
                    </div>
                  </div>

                  {preparationData.deadline_status && (
                    <div className={`p-3 rounded-lg flex items-center gap-3 ${
                      preparationData.deadline_status === 'overdue' ? 'bg-red-50 border border-red-200' :
                      preparationData.deadline_status === 'urgent' ? 'bg-orange-50 border border-orange-200' :
                      'bg-blue-50 border border-blue-200'
                    }`}>
                      {getDeadlineIcon(preparationData.deadline_status)}
                      <div>
                        <p className="font-medium text-sm">
                          {preparationData.deadline_status === 'overdue' ? 'Deadline Passed' :
                           preparationData.deadline_status === 'urgent' ? 'Urgent Deadline' :
                           preparationData.deadline_status === 'soon' ? 'Deadline Soon' :
                           'Deadline Status'}
                        </p>
                        <p className="text-sm text-slate-600">
                          {preparationData.days_until_deadline !== null 
                            ? `${Math.abs(preparationData.days_until_deadline)} days ${preparationData.days_until_deadline >= 0 ? 'remaining' : 'overdue'}`
                            : 'No deadline set'}
                        </p>
                      </div>
                    </div>
                  )}

                  {preparationData.warnings?.length > 0 && (
                    <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                      <h4 className="font-semibold text-sm text-yellow-900 mb-2">Warnings</h4>
                      <ul className="space-y-1">
                        {preparationData.warnings.map((warning, idx) => (
                          <li key={idx} className="text-sm text-yellow-800">• {warning}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <Button 
                    onClick={() => setStep('submit')} 
                    disabled={!preparationData.submission_ready}
                    className="w-full"
                  >
                    {preparationData.submission_ready ? 'Proceed to Submit' : 'Fix Issues Before Submitting'}
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          {step === 'submit' && (
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Submission Details</CardTitle>
                  <CardDescription>Final information before submission</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <label className="text-sm font-medium mb-2 block">Submission Method</label>
                    <Select 
                      value={submissionData.submission_method} 
                      onValueChange={(value) => setSubmissionData({...submissionData, submission_method: value})}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="online">Online Portal</SelectItem>
                        <SelectItem value="email">Email</SelectItem>
                        <SelectItem value="mail">Physical Mail</SelectItem>
                        <SelectItem value="grants_gov">Grants.gov</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-sm font-medium mb-2 block">Confirmation Number (Optional)</label>
                    <Input
                      value={submissionData.confirmation_number}
                      onChange={(e) => setSubmissionData({...submissionData, confirmation_number: e.target.value})}
                      placeholder="Enter confirmation or tracking number"
                    />
                  </div>

                  <div>
                    <label className="text-sm font-medium mb-2 block">Submission Notes</label>
                    <Textarea
                      value={submissionData.submission_notes}
                      onChange={(e) => setSubmissionData({...submissionData, submission_notes: e.target.value})}
                      placeholder="Any notes about the submission..."
                      className="min-h-24"
                    />
                  </div>

                  {preparationData?.deadline_status === 'overdue' && (
                    <div className="flex items-start gap-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                      <Checkbox
                        checked={submissionData.acknowledge_deadline}
                        onCheckedChange={(checked) => setSubmissionData({...submissionData, acknowledge_deadline: checked})}
                      />
                      <label className="text-sm text-red-800">
                        I acknowledge that the deadline has passed and understand this may affect consideration
                      </label>
                    </div>
                  )}
                </CardContent>
              </Card>

              <DialogFooter>
                <Button variant="outline" onClick={() => setStep('confirm')}>
                  Back to Review
                </Button>
                <Button 
                  onClick={handleSubmit}
                  disabled={submitMutation.isPending || (preparationData?.deadline_status === 'overdue' && !submissionData.acknowledge_deadline)}
                  className="bg-green-600 hover:bg-green-700"
                >
                  {submitMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4 mr-2" />
                      Submit Grant
                    </>
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}