import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileText, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { useQuery } from '@tanstack/react-query';

/**
 * Safe helpers
 */
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const coerceBoolean = (v) =>
  v === true ||
  (typeof v === 'string' && v.toLowerCase().trim() === 'true') ||
  v === 1;

/** Extract plain text from a harvested_data payload (JSON string or object) */
function extractTextFromHarvested(harvested) {
  try {
    const obj = typeof harvested === 'string' ? JSON.parse(harvested) : harvested;
    if (!isObject(obj)) return '';
    // Prefer explicit text keys
    const candidates = [
      obj.full_text,
      obj.text,
      obj.content,
      obj.body,
      obj.raw_text,
    ].filter(isNonEmptyString);
    if (candidates.length) return candidates.join('\n');
    // Fallback: join all string leaves (shallow)
    const shallowStrings = Object.values(obj).filter(isNonEmptyString);
    return shallowStrings.join('\n');
  } catch {
    // If not JSON, return as-is (string) or empty
    return typeof harvested === 'string' ? harvested : '';
  }
}

/** Build a compact, capped document corpus for the prompt */
function buildDocCorpus(documents, organizationId, cap = 60000) {
  const pieces = [];
  for (const d of documents) {
    if (!d || d.organization_id !== organizationId) continue;
    const fromHarvest = d.harvested_data ? extractTextFromHarvested(d.harvested_data) : '';
    const fromDesc = d.description || '';
    const text = [fromHarvest, fromDesc].filter(isNonEmptyString).join('\n').trim();
    if (isNonEmptyString(text)) pieces.push(text);
  }
  if (pieces.length === 0) return '';
  // Deduplicate roughly and cap size
  const joined = Array.from(new Set(pieces)).join('\n\n').slice(0, cap);
  return joined;
}

/**
 * ParseFromDocsButton - Parses organization data from uploaded documents
 * Uses AI to extract section-specific fields from document content
 */
export default function ParseFromDocsButton({
  organizationId,
  sectionName,
  fieldsToExtract = [], // Array of { field: 'field_name', type: 'boolean'|'string'|'number', label?, description? }
  onUpdate,
  disabled = false,
  className = ''
}) {
  const [isParsing, setIsParsing] = useState(false);
  const { toast } = useToast();

  // Fetch documents for THIS organization ONLY - strict isolation
  const { data: documents = [] } = useQuery({
    queryKey: ['documents', 'parse', organizationId],
    queryFn: async () => {
      if (!organizationId) {
        console.error('[ParseFromDocsButton] ❌ NO ORGANIZATION ID - cannot fetch documents');
        return [];
      }
      // SECURITY: Only fetch documents for this exact organization
      const docs = await base44.entities.Document.filter({ organization_id: organizationId });

      // SECURITY: Double-verify ALL documents belong to this organization
      const validDocs = (docs || []).filter(d => d.organization_id === organizationId);
      const invalidCount = (docs || []).length - validDocs.length;

      console.log('[ParseFromDocsButton] ISOLATION CHECK:', {
        organizationId,
        documentsFound: (docs || []).length,
        validDocuments: validDocs.length,
        invalidDocuments: invalidCount,
        allMatchProfile: invalidCount === 0
      });

      if (invalidCount > 0) {
        console.error('[ParseFromDocsButton] ❌ SECURITY VIOLATION: Found documents from other profiles!', {
          organizationId,
          invalidDocs: (docs || []).filter(d => d.organization_id !== organizationId).map(d => ({ id: d.id, org: d.organization_id }))
        });
      }

      return validDocs; // Only return documents that actually belong to this organization
    },
    enabled: !!organizationId,
    staleTime: 0, // Always refetch to ensure isolation
  });

  const handleParse = async () => {
    if (!organizationId) {
      toast({ variant: 'destructive', title: 'Missing Profile', description: 'Profile ID is required.' });
      return;
    }
    if (!Array.isArray(fieldsToExtract) || fieldsToExtract.length === 0) {
      toast({ variant: 'destructive', title: 'No Fields Configured', description: 'Fields to extract are required.' });
      return;
    }
    if (!documents.length) {
      toast({ variant: 'destructive', title: 'No Documents', description: 'Upload documents first to parse information.' });
      return;
    }

    setIsParsing(true);
    try {
      // SECURITY: Verify ALL documents belong to this organization
      const invalidDocs = documents.filter(d => d.organization_id !== organizationId);
      if (invalidDocs.length > 0) {
        console.error('[ParseFromDocsButton] SECURITY: Cross-profile document contamination detected', {
          organizationId,
          invalidDocs: invalidDocs.map(d => ({ id: d.id, org: d.organization_id }))
        });
        toast({ variant: 'destructive', title: 'Security Error', description: 'Document isolation violation detected.' });
        return;
      }

      // Build corpus from ONLY this organization's docs
      const docContents = buildDocCorpus(documents, organizationId, 60000);
      if (!isNonEmptyString(docContents)) {
        toast({ variant: 'destructive', title: 'No Content', description: 'Documents have not been processed yet.' });
        return;
      }

      console.log('[ParseFromDocsButton] SECURITY: Parsing from isolated documents', {
        organizationId,
        documentCount: documents.length,
        sectionName
      });

      // Build schema for extraction (boolean/string/number only)
      const properties = {};
      for (const f of fieldsToExtract) {
        if (!f || !isNonEmptyString(f.field)) continue;
        const desc = f.description || f.label || f.field;
        if (f.type === 'boolean') {
          properties[f.field] = { type: 'boolean', description: `True ONLY if explicit evidence exists: ${desc}` };
        } else if (f.type === 'number') {
          properties[f.field] = { type: 'number', description: desc };
        } else {
          properties[f.field] = { type: 'string', description: desc };
        }
      }

      const fieldsList = fieldsToExtract.map(f => `- ${f.label || f.field}`).join('\n');

      // Get organization name for context (helps AI know which profile)
      let orgName = 'this profile';
      try {
        const org = await base44.entities.Organization.get(organizationId);
        if (org && org.name) orgName = org.name;
      } catch {
        console.warn('[ParseFromDocsButton] Could not fetch org name');
      }

      // SECURITY: Build isolated AI prompt - NO external context
      const isolatedPrompt = `⚠️ HIPAA/PHI SECURITY DIRECTIVE - MANDATORY COMPLIANCE ⚠️

YOU MUST EXTRACT INFORMATION ONLY FROM THE DOCUMENTS PROVIDED BELOW.
YOU MUST NOT USE ANY:
- Previously seen data
- Cached context
- Information from other profiles
- External knowledge
- Prior conversation history

THIS IS FOR PROFILE: "${orgName}" (ID: ${organizationId})
SECTION: ${sectionName}

═══════════════════════════════════════════════════════
DOCUMENTS FOR ${orgName.toUpperCase()} ONLY:
═══════════════════════════════════════════════════════
${docContents}
═══════════════════════════════════════════════════════

FIELDS TO EXTRACT:
${fieldsList}

EXTRACTION RULES:
- For boolean fields, return true ONLY if there's explicit evidence in the documents ABOVE, false otherwise.
- For string fields, extract the relevant text ONLY from the documents ABOVE.
- For number fields, extract numeric values ONLY from the documents ABOVE.
- Do NOT infer, assume, or use external knowledge.
- Only include fields that have clear evidence in the documents ABOVE.
- Return empty/null/false for fields with no evidence.
- If you're uncertain, return null/empty - NEVER guess.

⚠️ VIOLATION WARNING: Any data from other profiles/sources constitutes a HIPAA violation.
Only extract from the documents provided in this prompt for ${orgName}.`;

      // Invoke LLM with schema
      const response = await base44.integrations.Core.InvokeLLM({
        prompt: isolatedPrompt,
        response_json_schema: { type: 'object', properties }
      });

      const aiOutput = response && typeof response === 'object' ? response : {};

      // SECURITY: Validate AI output contains only expected fields and coerce types
      const allowedKeys = new Set(fieldsToExtract.map(f => f.field));
      const updateData = {};
      let fieldsFound = 0;

      for (const [key, raw] of Object.entries(aiOutput)) {
        if (!allowedKeys.has(key)) continue;
        const def = fieldsToExtract.find(f => f.field === key);
        if (!def) continue;

        if (def.type === 'boolean') {
          if (coerceBoolean(raw)) {
            updateData[key] = true;
            fieldsFound++;
          }
        } else if (def.type === 'number') {
          // CRITICAL: Handle empty strings and null values - don't include them
          if (raw === '' || raw === null || raw === undefined) continue;
          const num = typeof raw === 'number' ? raw : Number(raw);
          if (isFiniteNumber(num)) {
            updateData[key] = num;
            fieldsFound++;
          }
          // Skip invalid numbers entirely - don't add to updateData
        } else {
          // string
          if (isNonEmptyString(raw)) {
            updateData[key] = String(raw).trim();
            fieldsFound++;
          }
        }
      }

      console.log('[ParseFromDocsButton] SECURITY_VALIDATION:', {
        organizationId,
        sectionName,
        fieldsExtracted: fieldsFound,
        output_validated: true
      });

      if (fieldsFound > 0 && organizationId && onUpdate) {
        onUpdate({ id: organizationId, data: updateData });
        toast({ title: `✨ Parsed ${sectionName}`, description: `Found ${fieldsFound} field${fieldsFound === 1 ? '' : 's'} from documents.` });
      } else {
        toast({ title: 'No Data Found', description: `Could not find ${String(sectionName || '').toLowerCase()} data in documents.` });
      }
    } catch (err) {
      console.error('[ParseFromDocsButton] Parse error:', err);
      const msg = err?.message || 'Failed to parse documents';
      toast({ variant: 'destructive', title: 'Parse Failed', description: msg });
    } finally {
      setIsParsing(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleParse}
      disabled={isParsing || disabled || !documents.length}
      className={`text-green-600 hover:text-green-700 hover:bg-green-50 ${className}`}
      title={documents.length ? 'Parse from uploaded documents' : 'Upload documents first'}
    >
      {isParsing ? (
        <>
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          Parsing...
        </>
      ) : (
        <>
          <FileText className="w-4 h-4 mr-2" />
          From Docs
        </>
      )}
    </Button>
  );
}