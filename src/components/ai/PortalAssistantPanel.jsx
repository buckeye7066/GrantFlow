import React, { useState, useCallback } from 'react';
import { apiFetch } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import {
  Loader2, Sparkles, ExternalLink, AlertTriangle,
  CheckCircle2, HelpCircle, Copy, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { copyTextToClipboard } from '@/utils/clipboard';

const CONFIDENCE_COLORS = {
  high: 'bg-green-100 text-green-800',
  medium: 'bg-yellow-100 text-yellow-800',
  low: 'bg-red-100 text-red-800',
};

function AnswerCard({ answer, index }) {
  const [expanded, setExpanded] = useState(true);
  const [copyState, setCopyState] = useState('idle');

  const handleCopy = useCallback(async () => {
    const copied = await copyTextToClipboard(answer.answer || '');
    setCopyState(copied ? 'copied' : 'failed');
    setTimeout(() => setCopyState('idle'), 2000);
  }, [answer.answer]);

  return (
    <Card className="border-l-4 border-l-blue-400">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2 mb-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-2 text-left font-medium text-sm flex-1"
          >
            <span className="text-blue-600 font-bold shrink-0">Q{index + 1}</span>
            <span className="line-clamp-2">{answer.question}</span>
            {expanded ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
          </button>
          {answer.confidence && (
            <Badge className={`text-xs shrink-0 ${CONFIDENCE_COLORS[answer.confidence] || ''}`}>
              {answer.confidence}
            </Badge>
          )}
        </div>

        {expanded && (
          <>
            <div className="bg-slate-50 rounded-lg p-3 text-sm whitespace-pre-wrap leading-relaxed mt-2">
              {answer.answer}
            </div>

            <div className="flex items-center justify-between mt-2">
              <Button variant="ghost" size="sm" onClick={handleCopy} className="text-xs">
                {copyState === 'copied' ? <CheckCircle2 className="w-3 h-3 mr-1" /> : <Copy className="w-3 h-3 mr-1" />}
                {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy answer'}
              </Button>
              {answer.missing_info && (
                <span className="text-xs text-amber-600 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  {answer.missing_info}
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function PortalAssistantPanel({ open, onClose, grant }) {
  const [portalUrl, setPortalUrl] = useState(grant?.application_url || grant?.url || '');
  const [customQuestions, setCustomQuestions] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const { toast } = useToast();

  // Reset derived state whenever the grant changes. Declared AFTER the
  // useState hooks above so the setters exist by the time the effect runs.
  const prevGrantId = React.useRef(grant?.id);
  React.useEffect(() => {
    if (grant?.id !== prevGrantId.current) {
      prevGrantId.current = grant?.id;
      setPortalUrl(grant?.application_url || grant?.url || '');
      setCustomQuestions('');
      setResult(null);
      setError(null);
    }
  }, [grant]);

  const handleAssist = useCallback(async () => {
    if (!grant?.id) {
      setError('No grant selected. Please open a specific grant before using the assistant.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const questions = customQuestions.trim()
        ? customQuestions.split('\n').filter(q => q.trim())
        : undefined;

      // Validate portalUrl before sending
      let validatedPortalUrl;
      if (portalUrl) {
        try {
          const parsed = new URL(portalUrl.trim());
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            throw new Error('URL must start with http:// or https://');
          }
          validatedPortalUrl = parsed.href;
        } catch (urlErr) {
          setError(`Invalid portal URL: ${urlErr.message}`);
          setLoading(false);
          return;
        }
      }

      // Warn the user if the supplied portal URL diverges from the stored application URL
const storedUrl = grant?.application_url || grant?.url || '';
if (validatedPortalUrl && storedUrl) {
  try {
    const suppliedHost = new URL(validatedPortalUrl).hostname;
    const storedHost = new URL(storedUrl).hostname;
    if (suppliedHost !== storedHost) {
      toast({
        title: 'URL mismatch',
        description: `The URL you entered (${suppliedHost}) differs from the stored application URL (${storedHost}). The AI will use your custom URL.`,
        variant: 'default',
      });
    }
  } catch (_) {
    // one of the URLs failed to parse — ignore the comparison
  }
}

const resp = await apiFetch('/api/ai/portal-assist', {
  method: 'POST',
  body: JSON.stringify({
    grant_id: grant.id,
    portal_url: validatedPortalUrl,
    questions,
  }),
});

      if (!resp.ok) {
        let errBody = {};
        try {
          errBody = await resp.json();
        } catch (_parseErr) {
          // response body was not JSON; fall through to status-based message
        }
        throw new Error(errBody.error || errBody.message || `Request failed (${resp.status})`);
      }

      const data = await resp.json();
      setResult(data.result);
    } catch (e) {
      setError(e.message);
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [grant, portalUrl, customQuestions, toast]);

  const answers = result?.answers || [];
  const summary = result?.summary || '';
  const tips = result?.tips || [];

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose?.()}>
      <SheetContent side="right" className="w-full sm:max-w-xl md:max-w-2xl overflow-hidden flex flex-col">
        <SheetHeader className="shrink-0">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-blue-500" />
            AI Application Assistant
          </SheetTitle>
          <SheetDescription>
            MBA-level help answering application questions for{' '}
            <span className="font-medium text-slate-800">{grant?.title || grant?.name || 'this grant'}</span>
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 mt-4 -mx-6 px-6">
          <div className="space-y-4 pb-6">
            {/* Portal URL */}
            <div>
              <label className="text-sm font-medium text-slate-700 mb-1 block">
                Application Portal URL
              </label>
              <div className="flex gap-2">
                <Input
                  value={portalUrl}
                  onChange={(e) => setPortalUrl(e.target.value)}
                  placeholder="https://..."
                  className="flex-1"
                />
                {(() => {
                  let safeLinkUrl = null;
                  try {
                    const parsed = new URL(portalUrl.trim());
                    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
                      safeLinkUrl = parsed.href;
                    }
                  } catch (_) {
                    // not a valid URL – suppress the link
                  }
                  return safeLinkUrl ? (
                    <Button variant="outline" size="icon" asChild>
                      <a href={safeLinkUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </Button>
                  ) : null;
                })()}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                AI will read this page to understand what the funder is asking
              </p>
            </div>

            {/* Custom questions */}
            <div>
              <label className="text-sm font-medium text-slate-700 mb-1 block">
                Specific questions to answer <span className="text-slate-400">(optional)</span>
              </label>
              <Textarea
                value={customQuestions}
                onChange={(e) => setCustomQuestions(e.target.value)}
                placeholder="Paste questions from the portal here, one per line..."
                rows={3}
              />
            </div>

            {/* Generate button */}
            <Button
              onClick={handleAssist}
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700"
            >
              {loading ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analyzing & Writing Responses...</>
              ) : (
                <><Sparkles className="w-4 h-4 mr-2" /> Generate Application Answers</>
              )}
            </Button>

            {/* Error */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                <AlertTriangle className="w-4 h-4 inline mr-1" />
                {error}
              </div>
            )}

            {/* Summary */}
            {summary && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <h4 className="text-sm font-semibold text-blue-800 mb-1">Application Strength</h4>
                <p className="text-sm text-blue-700">{summary}</p>
              </div>
            )}

            {/* Tips */}
            {tips.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <h4 className="text-sm font-semibold text-amber-800 mb-1 flex items-center gap-1">
                  <HelpCircle className="w-4 h-4" /> Tips
                </h4>
                <ul className="text-sm text-amber-700 space-y-1">
                  {tips.map((t, i) => <li key={i}>• {t}</li>)}
                </ul>
              </div>
            )}

            {/* Answers */}
            {answers.length > 0 && (
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-slate-700">
                  Draft Answers ({answers.length})
                </h4>
                {answers.map((a, i) => (
                  <AnswerCard key={i} answer={a} index={i} />
                ))}
              </div>
            )}

            {/* Raw fallback */}
            {result?.raw && !answers.length && (
              <div className="bg-slate-50 rounded-lg p-4 text-sm whitespace-pre-wrap">
                {result.raw}
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
