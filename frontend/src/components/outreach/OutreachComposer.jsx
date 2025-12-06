import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sparkles, Loader2, Send, Save, X, Lightbulb, TrendingUp, AlertCircle } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function OutreachComposer({ 
  organizationId, 
  organizationName,
  grantId,
  existingOutreach,
  onSave,
  onCancel 
}) {
  const [formData, setFormData] = useState({
    funder_name: existingOutreach?.funder_name || '',
    funder_contact_name: existingOutreach?.funder_contact_name || '',
    funder_email: existingOutreach?.funder_email || '',
    funder_phone: existingOutreach?.funder_phone || '',
    outreach_type: existingOutreach?.outreach_type || 'inquiry',
    priority: existingOutreach?.priority || 'medium',
    subject_line: existingOutreach?.subject_line || '',
    message_body: existingOutreach?.message_body || '',
    custom_instructions: ''
  });
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiInsights, setAiInsights] = useState(null);
  const { toast } = useToast();

  const handleGenerateMessage = async () => {
    if (!formData.funder_name) {
      toast({
        variant: 'destructive',
        title: 'Funder Name Required',
        description: 'Please enter the funding organization name first.',
      });
      return;
    }

    setIsGenerating(true);
    setAiInsights(null);

    try {
      const response = await base44.functions.invoke('generateOutreachMessage', {
        body: {
          organization_id: organizationId,
          grant_id: grantId,
          funder_name: formData.funder_name,
          funder_contact_name: formData.funder_contact_name,
          outreach_type: formData.outreach_type,
          custom_instructions: formData.custom_instructions
        }
      });

      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Message generation failed');
      }

      const data = response.data;

      setFormData(prev => ({
        ...prev,
        subject_line: data.subject_line,
        message_body: data.message_body
      }));

      setAiInsights({
        key_points: data.key_points || [],
        personalization_notes: data.personalization_notes,
        funder_research: data.funder_research || {},
        suggested_attachments: data.suggested_attachments || [],
        follow_up_strategy: data.follow_up_strategy,
        success_probability: data.success_probability || 50,
        improvement_suggestions: data.improvement_suggestions || []
      });

      toast({
        title: '✨ Message Generated!',
        description: `Personalized ${formData.outreach_type} created. ${data.minutes_billed || 12} min billed.`,
        duration: 6000,
      });

    } catch (error) {
      console.error('[OutreachComposer] Generation error:', error);
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: error.message || 'Failed to generate message',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!formData.funder_name || !formData.subject_line || !formData.message_body) {
      toast({
        variant: 'destructive',
        title: 'Required Fields Missing',
        description: 'Please fill in funder name, subject, and message.',
      });
      return;
    }

    const outreachData = {
      organization_id: organizationId,
      grant_id: grantId,
      funder_name: formData.funder_name,
      funder_contact_name: formData.funder_contact_name || null,
      funder_email: formData.funder_email || null,
      funder_phone: formData.funder_phone || null,
      outreach_type: formData.outreach_type,
      priority: formData.priority,
      subject_line: formData.subject_line,
      message_body: formData.message_body,
      ai_generated: !!aiInsights,
      status: 'ready_to_send',
      success_probability: aiInsights?.success_probability || null,
      personalization_data: aiInsights ? {
        key_points: aiInsights.key_points,
        funder_research: aiInsights.funder_research,
        follow_up_strategy: aiInsights.follow_up_strategy
      } : null
    };

    if (onSave) {
      onSave(outreachData);
    }
  };

  return (
    <Card className="shadow-xl border-2 border-blue-200">
      <CardHeader className="bg-gradient-to-r from-blue-50 to-purple-50">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-2xl flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-purple-600" />
              {existingOutreach ? 'Edit Outreach' : 'Create Outreach'}
            </CardTitle>
            <CardDescription>
              AI-powered personalized outreach for {organizationName}
            </CardDescription>
          </div>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      
      <CardContent className="p-6 space-y-6">
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <Label>Funder Organization *</Label>
            <Input
              value={formData.funder_name}
              onChange={(e) => setFormData(prev => ({ ...prev, funder_name: e.target.value }))}
              placeholder="e.g., Cleveland Community Foundation"
            />
          </div>
          
          <div>
            <Label>Contact Name</Label>
            <Input
              value={formData.funder_contact_name}
              onChange={(e) => setFormData(prev => ({ ...prev, funder_contact_name: e.target.value }))}
              placeholder="e.g., Jane Smith, Program Officer"
            />
          </div>
        </div>
        
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <Label>Contact Email</Label>
            <Input
              type="email"
              value={formData.funder_email}
              onChange={(e) => setFormData(prev => ({ ...prev, funder_email: e.target.value }))}
              placeholder="grants@foundation.org"
            />
          </div>
          
          <div>
            <Label>Contact Phone</Label>
            <Input
              type="tel"
              value={formData.funder_phone}
              onChange={(e) => setFormData(prev => ({ ...prev, funder_phone: e.target.value }))}
              placeholder="(555) 123-4567"
            />
          </div>
        </div>
        
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <Label>Outreach Type *</Label>
            <Select value={formData.outreach_type} onValueChange={(val) => setFormData(prev => ({ ...prev, outreach_type: val }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inquiry">Initial Inquiry</SelectItem>
                <SelectItem value="letter_of_inquiry">Letter of Inquiry (LOI)</SelectItem>
                <SelectItem value="pre_proposal">Pre-Proposal Contact</SelectItem>
                <SelectItem value="application_notification">Application Submitted</SelectItem>
                <SelectItem value="thank_you">Thank You Letter</SelectItem>
                <SelectItem value="progress_update">Progress Update</SelectItem>
                <SelectItem value="follow_up">Follow-Up</SelectItem>
                <SelectItem value="relationship_building">Relationship Building</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <div>
            <Label>Priority</Label>
            <Select value={formData.priority} onValueChange={(val) => setFormData(prev => ({ ...prev, priority: val }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="urgent">Urgent</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        
        <div>
          <Label>Special Instructions (Optional)</Label>
          <Textarea
            value={formData.custom_instructions}
            onChange={(e) => setFormData(prev => ({ ...prev, custom_instructions: e.target.value }))}
            placeholder="Any specific points to emphasize or tone adjustments..."
            rows={2}
          />
        </div>
        
        <Button
          onClick={handleGenerateMessage}
          disabled={isGenerating || !formData.funder_name}
          className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700"
          size="lg"
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />
              Researching & Generating... (12 min)
            </>
          ) : (
            <>
              <Sparkles className="w-5 h-5 mr-2" />
              Generate Personalized Message with AI
            </>
          )}
        </Button>
        
        {aiInsights && (
          <div className="space-y-4 p-4 bg-purple-50 border-2 border-purple-200 rounded-lg">
            <div className="flex items-center gap-2">
              <Lightbulb className="w-5 h-5 text-purple-600" />
              <h3 className="font-semibold text-purple-900">AI Insights & Research</h3>
            </div>
            
            {aiInsights.success_probability >= 70 && (
              <Alert className="bg-green-50 border-green-200">
                <TrendingUp className="h-4 w-4 text-green-600" />
                <AlertDescription className="text-green-900">
                  <strong>{aiInsights.success_probability}% Success Probability</strong> - Strong alignment detected!
                </AlertDescription>
              </Alert>
            )}
            
            {aiInsights.key_points && aiInsights.key_points.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-purple-900 mb-2">Key Strengths:</p>
                <ul className="list-disc list-inside space-y-1">
                  {aiInsights.key_points.map((point, idx) => (
                    <li key={idx} className="text-sm text-purple-800">{point}</li>
                  ))}
                </ul>
              </div>
            )}
            
            {aiInsights.funder_research?.mission_alignment && (
              <div>
                <p className="text-sm font-semibold text-purple-900 mb-1">Mission Alignment:</p>
                <p className="text-sm text-purple-800">{aiInsights.funder_research.mission_alignment}</p>
              </div>
            )}
            
            {aiInsights.improvement_suggestions && aiInsights.improvement_suggestions.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-amber-900 mb-2">💡 Suggestions:</p>
                <ul className="list-disc list-inside space-y-1">
                  {aiInsights.improvement_suggestions.map((suggestion, idx) => (
                    <li key={idx} className="text-sm text-amber-800">{suggestion}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        
        <div>
          <Label>Subject Line *</Label>
          <Input
            value={formData.subject_line}
            onChange={(e) => setFormData(prev => ({ ...prev, subject_line: e.target.value }))}
            placeholder="Compelling subject line..."
          />
        </div>
        
        <div>
          <Label>Message Body *</Label>
          <Textarea
            value={formData.message_body}
            onChange={(e) => setFormData(prev => ({ ...prev, message_body: e.target.value }))}
            placeholder="Your personalized message..."
            rows={12}
            className="font-mono text-sm"
          />
        </div>
        
        <div className="flex gap-3 pt-4">
          <Button
            onClick={handleSave}
            className="flex-1 bg-blue-600 hover:bg-blue-700"
            size="lg"
          >
            <Save className="w-5 h-5 mr-2" />
            Save Outreach
          </Button>
          
          {onCancel && (
            <Button
              onClick={onCancel}
              variant="outline"
              size="lg"
            >
              Cancel
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}