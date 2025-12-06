import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { 
  Wand2, 
  Loader2, 
  Copy, 
  Check, 
  Sparkles,
  FileText,
  Edit3,
  Tags,
  AlertCircle
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { Alert, AlertDescription } from '@/components/ui/alert';

const PROPOSAL_SECTIONS = [
  { value: 'full_proposal', label: 'Complete Proposal', icon: FileText },
  { value: 'executive_summary', label: 'Executive Summary', icon: Sparkles },
  { value: 'needs_statement', label: 'Statement of Need', icon: AlertCircle },
  { value: 'project_description', label: 'Project Description', icon: FileText },
  { value: 'goals_objectives', label: 'Goals & Objectives', icon: Tags },
  { value: 'methods_activities', label: 'Methods & Activities', icon: Edit3 },
  { value: 'evaluation_plan', label: 'Evaluation Plan', icon: FileText },
  { value: 'sustainability', label: 'Sustainability', icon: Sparkles },
  { value: 'organizational_capacity', label: 'Organizational Capacity', icon: FileText },
];

const REFINEMENT_TYPES = [
  { value: 'tone', label: 'Adjust Tone' },
  { value: 'clarity', label: 'Improve Clarity' },
  { value: 'persuasiveness', label: 'Enhance Persuasiveness' },
  { value: 'length', label: 'Adjust Length' },
  { value: 'grammar', label: 'Fix Grammar & Style' },
];

const TONE_OPTIONS = [
  { value: 'formal', label: 'Formal & Academic' },
  { value: 'conversational', label: 'Conversational & Warm' },
  { value: 'persuasive', label: 'Persuasive & Compelling' },
  { value: 'technical', label: 'Technical & Precise' },
  { value: 'compassionate', label: 'Compassionate & Human' },
];

const LENGTH_OPTIONS = [
  { value: 'expand', label: 'Expand (Add Detail)' },
  { value: 'condense', label: 'Condense (Shorten)' },
];

export default function AIProposalAssistant({ grant, organization, onContentGenerated }) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState('generate');
  
  // Generate tab state
  const [selectedSection, setSelectedSection] = useState('executive_summary');
  const [customInstructions, setCustomInstructions] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedContent, setGeneratedContent] = useState(null);
  const [copied, setCopied] = useState(false);
  
  // Refine tab state
  const [textToRefine, setTextToRefine] = useState('');
  const [refinementType, setRefinementType] = useState('clarity');
  const [targetTone, setTargetTone] = useState('formal');
  const [targetLength, setTargetLength] = useState('expand');
  const [refineInstructions, setRefineInstructions] = useState('');
  const [isRefining, setIsRefining] = useState(false);
  const [refinedContent, setRefinedContent] = useState(null);
  
  // Metadata tab state
  const [isGeneratingMetadata, setIsGeneratingMetadata] = useState(false);
  const [generatedMetadata, setGeneratedMetadata] = useState(null);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setGeneratedContent(null);
    
    try {
      const response = await base44.functions.invoke('generateProposalDraft', {
        body: {
          grant_id: grant.id,
          section_type: selectedSection,
          custom_instructions: customInstructions || undefined,
        }
      });

      if (response.data?.success) {
        setGeneratedContent(response.data.content);
        toast({
          title: '✅ Content Generated',
          description: `Your ${PROPOSAL_SECTIONS.find(s => s.value === selectedSection)?.label} is ready.`,
        });
        
        if (onContentGenerated) {
          onContentGenerated(selectedSection, response.data.content);
        }
      } else {
        throw new Error(response.data?.error || 'Generation failed');
      }
    } catch (error) {
      console.error('[AIProposalAssistant] Generation error:', error);
      toast({
        variant: 'destructive',
        title: 'Generation Failed',
        description: error.message || 'Could not generate content',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRefine = async () => {
    if (!textToRefine.trim()) {
      toast({
        variant: 'destructive',
        title: 'No Text to Refine',
        description: 'Please paste the text you want to improve.',
      });
      return;
    }

    setIsRefining(true);
    setRefinedContent(null);
    
    try {
      const response = await base44.functions.invoke('refineProposalDraft', {
        body: {
          original_text: textToRefine,
          refinement_type: refinementType,
          target_tone: refinementType === 'tone' ? targetTone : undefined,
          target_length: refinementType === 'length' ? targetLength : undefined,
          custom_instructions: refineInstructions || undefined,
        }
      });

      if (response.data?.success) {
        setRefinedContent(response.data);
        toast({
          title: '✅ Text Refined',
          description: response.data.changes_summary || 'Your text has been improved.',
        });
      } else {
        throw new Error(response.data?.error || 'Refinement failed');
      }
    } catch (error) {
      console.error('[AIProposalAssistant] Refinement error:', error);
      toast({
        variant: 'destructive',
        title: 'Refinement Failed',
        description: error.message || 'Could not refine text',
      });
    } finally {
      setIsRefining(false);
    }
  };

  const handleGenerateMetadata = async () => {
    setIsGeneratingMetadata(true);
    setGeneratedMetadata(null);
    
    try {
      const response = await base44.functions.invoke('generateGrantMetadata', {
        body: {
          grant_id: grant.id,
        }
      });

      if (response.data?.success) {
        setGeneratedMetadata(response.data.metadata);
        toast({
          title: '✅ Metadata Generated',
          description: 'Tags and keywords have been generated and saved to the grant.',
        });
      } else {
        throw new Error(response.data?.error || 'Metadata generation failed');
      }
    } catch (error) {
      console.error('[AIProposalAssistant] Metadata error:', error);
      toast({
        variant: 'destructive',
        title: 'Metadata Generation Failed',
        description: error.message || 'Could not generate metadata',
      });
    } finally {
      setIsGeneratingMetadata(false);
    }
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({
      title: 'Copied to Clipboard',
      description: 'Content copied successfully',
    });
  };

  return (
    <div className="space-y-6">
      <Alert className="bg-purple-50 border-purple-200">
        <Wand2 className="h-4 w-4 text-purple-600" />
        <AlertDescription className="text-purple-900">
          <strong>AI Proposal Assistant</strong> - Generate professional grant proposals, refine existing drafts, and create smart metadata.
        </AlertDescription>
      </Alert>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="generate">
            <FileText className="w-4 h-4 mr-2" />
            Generate
          </TabsTrigger>
          <TabsTrigger value="refine">
            <Edit3 className="w-4 h-4 mr-2" />
            Refine
          </TabsTrigger>
          <TabsTrigger value="metadata">
            <Tags className="w-4 h-4 mr-2" />
            Metadata
          </TabsTrigger>
        </TabsList>

        {/* GENERATE TAB */}
        <TabsContent value="generate" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Generate Proposal Content</CardTitle>
              <CardDescription>
                AI will write proposal sections based on your profile and grant requirements
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Select Section to Generate</Label>
                <Select value={selectedSection} onValueChange={setSelectedSection}>
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROPOSAL_SECTIONS.map(section => (
                      <SelectItem key={section.value} value={section.value}>
                        {section.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="custom-instructions">
                  Custom Instructions (Optional)
                </Label>
                <Textarea
                  id="custom-instructions"
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  placeholder="E.g., 'Focus on youth impact', 'Emphasize data-driven outcomes', 'Include partnership examples'..."
                  rows={3}
                  className="mt-2"
                />
              </div>

              <Button
                onClick={handleGenerate}
                disabled={isGenerating}
                className="w-full bg-purple-600 hover:bg-purple-700"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Generating Content...
                  </>
                ) : (
                  <>
                    <Wand2 className="w-4 h-4 mr-2" />
                    Generate {PROPOSAL_SECTIONS.find(s => s.value === selectedSection)?.label}
                  </>
                )}
              </Button>

              {generatedContent && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-base font-semibold">Generated Content</Label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCopy(
                        selectedSection === 'full_proposal'
                          ? Object.values(generatedContent).join('\n\n')
                          : generatedContent.content
                      )}
                    >
                      {copied ? (
                        <>
                          <Check className="w-4 h-4 mr-2" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-4 h-4 mr-2" />
                          Copy
                        </>
                      )}
                    </Button>
                  </div>

                  {selectedSection === 'full_proposal' ? (
                    <div className="space-y-4">
                      {Object.entries(generatedContent).map(([key, value]) => (
                        <div key={key} className="p-4 bg-slate-50 rounded-lg">
                          <h4 className="font-semibold text-sm mb-2 capitalize">
                            {key.replace(/_/g, ' ')}
                          </h4>
                          <p className="text-sm text-slate-700 whitespace-pre-wrap">{value}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Textarea
                      value={generatedContent.content}
                      readOnly
                      rows={15}
                      className="font-serif text-sm"
                    />
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* REFINE TAB */}
        <TabsContent value="refine" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Refine Existing Text</CardTitle>
              <CardDescription>
                Improve tone, clarity, persuasiveness, or length of your draft
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="text-to-refine">Paste Your Draft Text</Label>
                <Textarea
                  id="text-to-refine"
                  value={textToRefine}
                  onChange={(e) => setTextToRefine(e.target.value)}
                  placeholder="Paste the grant proposal text you want to improve..."
                  rows={8}
                  className="mt-2"
                />
              </div>

              <div>
                <Label>Refinement Type</Label>
                <Select value={refinementType} onValueChange={setRefinementType}>
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REFINEMENT_TYPES.map(type => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {refinementType === 'tone' && (
                <div>
                  <Label>Target Tone</Label>
                  <Select value={targetTone} onValueChange={setTargetTone}>
                    <SelectTrigger className="mt-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TONE_OPTIONS.map(tone => (
                        <SelectItem key={tone.value} value={tone.value}>
                          {tone.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {refinementType === 'length' && (
                <div>
                  <Label>Adjust Length</Label>
                  <Select value={targetLength} onValueChange={setTargetLength}>
                    <SelectTrigger className="mt-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LENGTH_OPTIONS.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div>
                <Label htmlFor="refine-instructions">
                  Additional Instructions (Optional)
                </Label>
                <Textarea
                  id="refine-instructions"
                  value={refineInstructions}
                  onChange={(e) => setRefineInstructions(e.target.value)}
                  placeholder="Any specific changes or focus areas..."
                  rows={2}
                  className="mt-2"
                />
              </div>

              <Button
                onClick={handleRefine}
                disabled={isRefining || !textToRefine.trim()}
                className="w-full bg-blue-600 hover:bg-blue-700"
              >
                {isRefining ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Refining...
                  </>
                ) : (
                  <>
                    <Edit3 className="w-4 h-4 mr-2" />
                    Refine Text
                  </>
                )}
              </Button>

              {refinedContent && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-base font-semibold">Refined Version</Label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCopy(refinedContent.refined_text)}
                    >
                      {copied ? (
                        <>
                          <Check className="w-4 h-4 mr-2" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-4 h-4 mr-2" />
                          Copy
                        </>
                      )}
                    </Button>
                  </div>

                  <Textarea
                    value={refinedContent.refined_text}
                    readOnly
                    rows={12}
                    className="font-serif text-sm"
                  />

                  {refinedContent.changes_summary && (
                    <Alert className="bg-blue-50 border-blue-200">
                      <Sparkles className="h-4 w-4 text-blue-600" />
                      <AlertDescription className="text-blue-900">
                        <strong>Changes Made:</strong> {refinedContent.changes_summary}
                      </AlertDescription>
                    </Alert>
                  )}

                  {refinedContent.suggestions?.length > 0 && (
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <p className="text-sm font-semibold mb-2">💡 Additional Suggestions:</p>
                      <ul className="text-sm space-y-1">
                        {refinedContent.suggestions.map((suggestion, idx) => (
                          <li key={idx} className="text-slate-700">• {suggestion}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* METADATA TAB */}
        <TabsContent value="metadata" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Generate Tags & Metadata</CardTitle>
              <CardDescription>
                AI will analyze the grant and suggest relevant tags, keywords, and categorization
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert>
                <Tags className="h-4 w-4" />
                <AlertDescription>
                  This will generate intelligent tags and keywords for "{grant.title}" and automatically save them to the grant.
                </AlertDescription>
              </Alert>

              <Button
                onClick={handleGenerateMetadata}
                disabled={isGeneratingMetadata}
                className="w-full bg-green-600 hover:bg-green-700"
              >
                {isGeneratingMetadata ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Analyzing Grant...
                  </>
                ) : (
                  <>
                    <Tags className="w-4 h-4 mr-2" />
                    Generate Tags & Keywords
                  </>
                )}
              </Button>

              {generatedMetadata && (
                <div className="space-y-4">
                  {generatedMetadata.tags?.length > 0 && (
                    <div className="p-4 bg-slate-50 rounded-lg">
                      <p className="text-sm font-semibold mb-2">📌 Tags:</p>
                      <div className="flex flex-wrap gap-2">
                        {generatedMetadata.tags.map((tag, idx) => (
                          <Badge key={idx} variant="secondary">{tag}</Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {generatedMetadata.keywords?.length > 0 && (
                    <div className="p-4 bg-blue-50 rounded-lg">
                      <p className="text-sm font-semibold mb-2">🔍 Keywords:</p>
                      <div className="flex flex-wrap gap-2">
                        {generatedMetadata.keywords.map((keyword, idx) => (
                          <Badge key={idx} variant="outline">{keyword}</Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {generatedMetadata.priority_level && (
                    <div className="p-3 bg-amber-50 rounded-lg">
                      <p className="text-sm"><strong>Priority:</strong> {generatedMetadata.priority_level}</p>
                    </div>
                  )}

                  {generatedMetadata.funder_type && (
                    <div className="p-3 bg-green-50 rounded-lg">
                      <p className="text-sm"><strong>Funder Type:</strong> {generatedMetadata.funder_type}</p>
                    </div>
                  )}

                  {generatedMetadata.opportunity_type && (
                    <div className="p-3 bg-purple-50 rounded-lg">
                      <p className="text-sm"><strong>Opportunity Type:</strong> {generatedMetadata.opportunity_type}</p>
                    </div>
                  )}

                  {generatedMetadata.audience_tags?.length > 0 && (
                    <div className="p-4 bg-indigo-50 rounded-lg">
                      <p className="text-sm font-semibold mb-2">👥 Target Audience:</p>
                      <div className="flex flex-wrap gap-2">
                        {generatedMetadata.audience_tags.map((tag, idx) => (
                          <Badge key={idx} className="bg-indigo-600">{tag}</Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {generatedMetadata.strategic_fit_summary && (
                    <Alert className="bg-emerald-50 border-emerald-200">
                      <Sparkles className="h-4 w-4 text-emerald-600" />
                      <AlertDescription className="text-emerald-900">
                        <strong>Strategic Fit:</strong> {generatedMetadata.strategic_fit_summary}
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}