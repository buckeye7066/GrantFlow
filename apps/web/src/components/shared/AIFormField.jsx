import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Sparkles, Loader2, AlertCircle, Check, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Voice configuration constants
 */
const VOICE_CONFIG = {
  organization: {
    instruction: '⚠️ CRITICAL: This is an ORGANIZATION. Write in FIRST PERSON PLURAL (we, our, us) THROUGHOUT THE ENTIRE RESPONSE.',
    pronounGuidance: 'Use "we", "our", "us" in every sentence. NEVER use "I", "my", "me".',
    reminder: 'REMEMBER: You are writing as an ORGANIZATION. Use we, our, us.',
    type: 'ORGANIZATION',
  },
  student: {
    instruction: '⚠️ CRITICAL: This is a STUDENT INDIVIDUAL. Write in FIRST PERSON SINGULAR (I, my, me) THROUGHOUT THE ENTIRE RESPONSE.',
    pronounGuidance: 'Use "I", "my", "me" in every sentence. NEVER use "we", "our", "us". This is about ONE PERSON, not a group.',
    reminder: 'REMEMBER: You are writing as ONE INDIVIDUAL PERSON. Use I, my, me.',
    type: 'INDIVIDUAL',
  },
  individual_need: {
    instruction: '⚠️ CRITICAL: This is an INDIVIDUAL seeking assistance. Write in FIRST PERSON SINGULAR (I, my, me) THROUGHOUT THE ENTIRE RESPONSE.',
    pronounGuidance: 'Use "I", "my", "me" in every sentence. NEVER use "we", "our", "us". This is about ONE PERSON and their personal situation.',
    reminder: 'REMEMBER: You are writing as ONE INDIVIDUAL PERSON. Use I, my, me.',
    type: 'INDIVIDUAL',
  },
  default: {
    instruction: '⚠️ CRITICAL: This is an INDIVIDUAL. Write in FIRST PERSON SINGULAR (I, my, me) THROUGHOUT THE ENTIRE RESPONSE.',
    pronounGuidance: 'Use "I", "my", "me" in every sentence. NEVER use "we", "our", "us".',
    reminder: 'REMEMBER: You are writing as ONE INDIVIDUAL PERSON. Use I, my, me.',
    type: 'INDIVIDUAL',
  },
};

/**
 * Determine voice configuration based on applicant type
 */
const getVoiceConfig = (applicantType) => {
  if (!applicantType) return VOICE_CONFIG.default;
  if (applicantType === 'organization') return VOICE_CONFIG.organization;
  if (['high_school_student', 'college_student', 'graduate_student'].includes(applicantType)) {
    return VOICE_CONFIG.student;
  }
  if (['individual_need', 'medical_assistance', 'family', 'other'].includes(applicantType)) {
    return VOICE_CONFIG.individual_need;
  }
  return VOICE_CONFIG.default;
};

/**
 * Build context information block from organization data
 */
const buildContextInfo = (organization) => {
  if (!organization || typeof organization !== 'object') return 'No profile information available.';
  const lines = [];

  lines.push(`APPLICANT TYPE: ${organization.applicant_type || 'organization'}`);
  if (organization.name) lines.push(`Name: ${organization.name}`);
  if (organization.mission) lines.push(`Bio/Mission: ${organization.mission}`);
  if (organization.primary_goal) lines.push(`Goal: ${organization.primary_goal}`);
  if (organization.intended_major) lines.push(`Major: ${organization.intended_major}`);
  if (organization.city && organization.state) lines.push(`Location: ${organization.city}, ${organization.state}`);
  if (organization.gpa) lines.push(`GPA: ${organization.gpa}`);
  if (organization.financial_need_level) lines.push(`Need Level: ${organization.financial_need_level}`);

  return lines.join('\n');
};

/**
 * Build complete AI prompt with voice instructions and context
 */
const buildAIPrompt = (aiPrompt, organization) => {
  const voiceConfig = getVoiceConfig(organization?.applicant_type);
  const contextInfo = buildContextInfo(organization);
  const isIndividual = voiceConfig.type === 'INDIVIDUAL';

  return `${voiceConfig.instruction}

${voiceConfig.pronounGuidance}

CONTEXT ABOUT THE APPLICANT:
${contextInfo}

YOUR TASK: ${aiPrompt}

RESPONSE REQUIREMENTS:
- Write 2-3 paragraphs (100-200 words)
- Professional and compelling tone
- ${isIndividual ? 'Write from a PERSONAL perspective using "I", "my", "me"' : 'Write from an ORGANIZATIONAL perspective using "we", "our", "us"'}
- Be specific and authentic
- Do NOT include any meta-commentary or explanations
- Start writing the response directly

${voiceConfig.reminder}`;
};

// Utility: coerce any model output to a clean string (printable, trimmed)
const coerceToCleanString = (val) => {
  if (typeof val === 'string') {
    return val.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, '').trim();
  }
  if (val === null || val === undefined) return '';
  try {
    return JSON.stringify(val).trim();
  } catch {
    return '';
  }
};

// Utility: emit change supporting both event-like and direct value use-cases
const emitChange = (onChange, name, value) => {
  if (typeof onChange === 'function') {
    onChange({ target: { name, value } });
  }
};

/**
 * AIFormField - Textarea with AI generation support
 * Features preview/confirmation before overwriting existing content
 */
export default function AIFormField({
  label = '',
  name = '',
  value,
  onChange,
  placeholder = '',
  aiPrompt,
  organization,
  rows = 4,
}) {
  const safeValue = value ?? '';
  const safeOrg = organization ?? null;
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [localValue, setLocalValue] = useState(safeValue);
  const abortRef = useRef(null);
  const genTokenRef = useRef(0); // stale-response guard
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Abort on unmount
      try {
        abortRef.current?.abort();
      } catch {}
    };
  }, []);

  const canGenerate = useMemo(() => Boolean(safeOrg?.id && aiPrompt), [safeOrg?.id, aiPrompt]);

  // Cancel in-flight when core inputs change to avoid stale apply
  useEffect(() => {
    setPreview(null);
  }, [aiPrompt, name, safeOrg?.id]);

  // Keep local value in sync with prop value
  useEffect(() => {
    setLocalValue(safeValue);
  }, [safeValue]);

  const handleAIGenerate = useCallback(async () => {
    if (!canGenerate || !aiPrompt) return;

    // Prevent concurrent generations
    if (isGenerating) return;

    setIsGenerating(true);
    setError(null);

    // Abort previous, if any
    try {
      abortRef.current?.abort();
    } catch {}
    const controller = new AbortController();
    abortRef.current = controller;

    // Stale response guard
    const token = ++genTokenRef.current;

    try {
      const fullPrompt = buildAIPrompt(aiPrompt, safeOrg);

      // Try the integration directly first
      const llm = base44?.integrations?.Core?.InvokeLLM;
      let rawOut;

      if (typeof llm === 'function') {
        const resp = await llm({ prompt: fullPrompt });
        if (controller.signal?.aborted) return;
        // Handle envelope: { output } or { data } or direct
        rawOut = resp?.output ?? resp?.data ?? resp;
      } else {
        throw new Error('AI service unavailable');
      }

      const clean = coerceToCleanString(rawOut);

      if (!clean) {
        throw new Error('Invalid response from AI service');
      }

      if (!mountedRef.current) return;

      // If field has content, present preview; else apply immediately
      if (safeValue.trim().length > 0) {
        // Ignore stale responses
        if (token !== genTokenRef.current) return;
        setPreview(clean);
      } else {
        setLocalValue(clean);
        emitChange(onChange, name, clean);
      }
    } catch (err) {
      if (controller.signal?.aborted) return;
      if (!mountedRef.current) return;
      const msg =
        err?.response?.data?.message ||
        err?.response?.data?.error ||
        err?.message ||
        'Failed to generate AI content. Please try again.';
      setError(String(msg));
    } finally {
      if (!controller.signal?.aborted && mountedRef.current) {
        setIsGenerating(false);
      }
    }
  }, [aiPrompt, canGenerate, isGenerating, name, onChange, safeOrg, safeValue]);

  const handleAcceptPreview = useCallback(() => {
    if (!preview) return;
    setLocalValue(preview);
    emitChange(onChange, name, preview);
    setPreview(null);
  }, [preview, onChange, name]);

  const handleRejectPreview = useCallback(() => {
    setPreview(null);
  }, []);

  const handleBlur = useCallback(() => {
    const currentVal = localValue ?? '';
    const propVal = safeValue ?? '';
    if (currentVal !== propVal) {
      emitChange(onChange, name, currentVal);
    }
  }, [localValue, onChange, name, safeValue]);

  const handleLocalChange = useCallback((e) => {
    setLocalValue(e.target.value);
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={name}>{label}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleAIGenerate}
          disabled={isGenerating || !canGenerate}
          className="text-purple-600 hover:text-purple-700 hover:bg-purple-50"
          aria-label={`Generate AI suggestion for ${label}`}
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 mr-2" />
              Suggest with AI
            </>
          )}
        </Button>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Preview Card */}
      {preview && (
        <Card className="bg-purple-50 border-purple-200">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-purple-900">AI Generated Preview</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={handleAcceptPreview}
                  className="bg-green-600 hover:bg-green-700"
                  aria-label="Accept AI suggestion"
                >
                  <Check className="w-4 h-4 mr-1" />
                  Accept
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleRejectPreview}
                  aria-label="Reject AI suggestion"
                >
                  <X className="w-4 h-4 mr-1" />
                  Reject
                </Button>
              </div>
            </div>
            <div className="text-sm text-slate-700 bg-white p-3 rounded border border-purple-200 whitespace-pre-wrap">
              {preview}
            </div>
            <p className="text-xs text-purple-700">
              This will replace your current content. Review before accepting.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Textarea Input */}
      <Textarea
        id={name}
        name={name}
        value={localValue}
        onChange={handleLocalChange}
        onBlur={handleBlur}
        placeholder={placeholder}
        rows={rows}
        aria-label={label}
        aria-describedby={error ? `${name}-error` : undefined}
      />

      {!canGenerate && safeOrg?.id && !aiPrompt && (
        <p className="text-xs text-slate-500">AI generation not configured for this field</p>
      )}

      {!safeOrg?.id && (
        <p className="text-xs text-amber-600">Profile information required for AI generation</p>
      )}
    </div>
  );
}