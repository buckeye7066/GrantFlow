import React, { useState } from 'react';
import SmartFormField from '../SmartFormField';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Sparkles, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import AIWritingAssistant from '../AIWritingAssistant';

export default function ProjectNarrativeStep({ data, onChange, grant, organization, errors }) {
  const [showAssistant, setShowAssistant] = useState(false);
  const [assistantSection, setAssistantSection] = useState('problem_statement');

  const handleFieldChange = (field) => (newValue) => {
    onChange({ [field]: newValue });
  };

  const openAssistant = (section) => {
    setAssistantSection(section);
    setShowAssistant(true);
  };

  const handleTextGenerated = (text) => {
    onChange({ [assistantSection]: text });
    setShowAssistant(false);
  };

  return (
    <div className="space-y-6">
      <Alert className="bg-gradient-to-r from-purple-50 to-pink-50 border-purple-200">
        <Sparkles className="h-4 w-4 text-purple-600" />
        <AlertDescription className="text-purple-900">
          <div className="flex items-start justify-between">
            <div>
              <strong>AI-Powered Writing Assistant</strong>
              <p className="text-sm mt-1">
                Use "AI Draft" to generate complete responses or "Refine" to improve existing text. 
                Each field has customized AI assistance based on grant requirements.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => openAssistant('problem_statement')}
              className="border-purple-300 text-purple-700"
            >
              <Wand2 className="w-4 h-4 mr-2" />
              Full Assistant
            </Button>
          </div>
        </AlertDescription>
      </Alert>

      <SmartFormField
        label="Problem Statement / Need Statement"
        value={data.problem_statement || ''}
        onChange={handleFieldChange('problem_statement')}
        placeholder="Describe the problem or need your project addresses. Include data, statistics, and evidence of the need in your community..."
        fieldName="problem_statement"
        questionType="problem_statement"
        wordLimit={500}
        helpText="Explain WHY this project is needed. Use data and evidence."
        showAI={true}
        grant={grant}
        organization={organization}
        error={errors?.problem_statement}
        rows={8}
      />

      <SmartFormField
        label="Project Goals & Objectives"
        value={data.project_goals || ''}
        onChange={handleFieldChange('project_goals')}
        placeholder="List 3-5 specific, measurable goals for your project. Use SMART goal framework (Specific, Measurable, Achievable, Relevant, Time-bound)..."
        fieldName="project_goals"
        questionType="goals"
        wordLimit={400}
        helpText="What specific outcomes will this project achieve?"
        showAI={true}
        grant={grant}
        organization={organization}
        error={errors?.project_goals}
        rows={6}
      />

      <SmartFormField
        label="Methods & Approach"
        value={data.methods || ''}
        onChange={handleFieldChange('methods')}
        placeholder="Describe your project activities, timeline, and implementation strategy. Explain HOW you will achieve your goals..."
        fieldName="methods"
        questionType="methods"
        wordLimit={600}
        helpText="Detail the specific steps you will take to implement this project"
        showAI={true}
        grant={grant}
        organization={organization}
        error={errors?.methods}
        rows={8}
      />

      <SmartFormField
        label="Expected Outcomes & Impact"
        value={data.outcomes || ''}
        onChange={handleFieldChange('outcomes')}
        placeholder="Describe the measurable results and long-term impact of your project. Who benefits and how?"
        fieldName="outcomes"
        questionType="project_impact"
        wordLimit={400}
        helpText="What measurable changes will result from this project?"
        showAI={true}
        grant={grant}
        organization={organization}
        error={errors?.outcomes}
        rows={6}
      />

      <SmartFormField
        label="Organizational Capacity"
        value={data.organizational_capacity || ''}
        onChange={handleFieldChange('organizational_capacity')}
        placeholder="Demonstrate your organization's experience, expertise, and ability to successfully complete this project..."
        fieldName="organizational_capacity"
        questionType="organizational_capacity"
        wordLimit={400}
        helpText="Prove you have the skills and resources to succeed"
        showAI={true}
        grant={grant}
        organization={organization}
        error={errors?.organizational_capacity}
        rows={6}
      />

      <SmartFormField
        label="Sustainability Plan"
        value={data.sustainability || ''}
        onChange={handleFieldChange('sustainability')}
        placeholder="Explain how project results will be sustained after grant funding ends. Include plans for future funding, partnerships, and community ownership..."
        fieldName="sustainability"
        questionType="sustainability_plan"
        wordLimit={350}
        helpText="How will impact continue beyond the grant period?"
        showAI={true}
        grant={grant}
        organization={organization}
        error={errors?.sustainability}
        rows={6}
      />

      <SmartFormField
        label="Evaluation Plan"
        value={data.evaluation || ''}
        onChange={handleFieldChange('evaluation')}
        placeholder="Describe how you will measure success. Include specific metrics, data collection methods, and evaluation timeline..."
        fieldName="evaluation"
        questionType="evaluation_plan"
        wordLimit={400}
        helpText="How will you track and measure project success?"
        showAI={true}
        grant={grant}
        organization={organization}
        error={errors?.evaluation}
        rows={6}
      />

      {/* Full AI Writing Assistant Dialog */}
      <Dialog open={showAssistant} onOpenChange={setShowAssistant}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-600" />
              AI Writing Assistant
            </DialogTitle>
            <DialogDescription>
              Generate complete drafts, refine existing text, or get keyword suggestions
            </DialogDescription>
          </DialogHeader>
          
          <AIWritingAssistant
            grant={grant}
            organization={organization}
            initialText={data[assistantSection] || ''}
            sectionType={assistantSection}
            onTextGenerated={handleTextGenerated}
            wordLimit={500}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}