import { useState, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';

const MAX_PDF_SIZE = 25 * 1024 * 1024; // 25MB
const PDF_MIME = 'application/pdf';

const STATUS = {
  IDLE: 'idle',
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  ERROR: 'error',
};

function coerceDateYYYYMMDD(value) {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeOutput(output, schema) {
  if (!output || typeof output !== 'object' || !schema?.properties) return output;

  const normalized = {};
  for (const [key, def] of Object.entries(schema.properties)) {
    const raw = output[key];
    if (raw == null) {
      normalized[key] = raw;
      continue;
    }

    switch (def.type) {
      case 'string': {
        const val = String(raw).trim();
        normalized[key] = def.format === 'date' ? coerceDateYYYYMMDD(val) : val;
        break;
      }
      case 'number': {
        const num = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,]/g, ''));
        normalized[key] = Number.isFinite(num) ? num : undefined;
        break;
      }
      case 'boolean': {
        if (typeof raw === 'boolean') normalized[key] = raw;
        else {
          const str = String(raw).toLowerCase().trim();
          normalized[key] = str === 'true' || str === 'yes' || str === '1';
        }
        break;
      }
      case 'array': {
        normalized[key] = Array.isArray(raw) ? raw : [raw];
        break;
      }
      default:
        normalized[key] = raw;
    }
  }

  return normalized;
}

function ensureHttpUrl(raw) {
  const s = (raw || '').trim();
  if (!s) throw new Error('Please enter a URL.');
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  const u = new URL(withProto);
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('Only http(s) URLs are supported.');
  }
  return u.toString();
}

/**
 * Custom hook for NOFO document parsing and processing
 * @param {string} selectedOrgId - Selected organization ID
 * @param {string} inputMode - 'file' or 'url'
 * @param {string} documentType - 'grant' or 'debt'
 */
export function useNOFOParse(selectedOrgId, inputMode, documentType = 'grant') {
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState(STATUS.IDLE);
  const [error, setError] = useState(null);
  const [extractedData, setExtractedData] = useState(null);
  const { toast } = useToast();

  const lastToastRef = useRef(0);
  const safeToast = useCallback(
    (opts) => {
      const now = Date.now();
      if (now - lastToastRef.current < 600) return;
      lastToastRef.current = now;
      toast(opts);
    },
    [toast]
  );

  const debtSchemaForExtraction = {
    type: 'object',
    properties: {
      creditor_name: { type: 'string', description: 'Name of the original creditor' },
      collector_name: { type: 'string', description: 'Name of the debt collection agency' },
      collector_address: { type: 'string', description: 'Mailing address of the collector' },
      collector_phone: { type: 'string', description: 'Phone number of the collector' },
      account_number: { type: 'string', description: 'Account or reference number' },
      original_amount: { type: 'number', description: 'Original debt amount in dollars' },
      current_amount: { type: 'number', description: 'Current amount being claimed' },
      debt_type: { type: 'string', description: 'Type of debt (medical, credit card, etc.)' },
      date_of_letter: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
      response_deadline: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
      dispute_rights: { type: 'string', description: 'Summary of dispute rights mentioned' },
      validation_notice: { type: 'boolean', description: 'Whether this is a validation notice' },
      legal_threats: { type: 'boolean', description: 'Whether the letter contains lawsuit threats' },
      suggested_actions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recommended actions to take',
      },
      potential_violations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Any potential FDCPA or state law violations detected',
      },
      assistance_programs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Suggested assistance programs based on debt type',
      },
    },
    required: ['collector_name', 'current_amount', 'debt_type'],
  };

  const grantSchemaForExtraction = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      funder: { type: 'string' },
      opportunity_number: { type: 'string' },
      deadline: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
      award_floor: { type: 'number' },
      award_ceiling: { type: 'number' },
      eligibility_summary: { type: 'string' },
      program_description: { type: 'string' },
      selection_criteria: { type: 'string' },
      funder_email: { type: 'string' },
      funder_phone: { type: 'string' },
      funder_fax: { type: 'string' },
      funder_address: { type: 'string' },
    },
    required: ['title', 'funder', 'program_description'],
  };

  const validateFile = useCallback((selectedFile) => {
    if (!selectedFile) return { valid: false, error: null };
    if (selectedFile.type !== PDF_MIME && !selectedFile.name.toLowerCase().endsWith('.pdf')) {
      return {
        valid: false,
        error: 'Only PDF files are supported at this time. Please convert your document to PDF first.',
      };
    }
    if (selectedFile.size > MAX_PDF_SIZE) {
      return {
        valid: false,
        error: `PDF too large. Max size is ${Math.round(MAX_PDF_SIZE / (1024 * 1024))}MB.`,
      };
    }
    return { valid: true, error: null };
  }, []);

  const handleFileChange = useCallback(
    (e) => {
      const selectedFile = e.target.files?.[0];
      const validation = validateFile(selectedFile || null);
      if (!validation.valid) {
        setError(validation.error);
        setFile(null);
        return;
      }
      setFile(selectedFile || null);
      setError(null);
    },
    [validateFile]
  );

  const handleUrlChange = useCallback((newUrl) => {
    setUrl(newUrl);
    setError(null);
  }, []);

  const processDocument = useCallback(async () => {
    if (!selectedOrgId) {
      setError('Please select a profile to associate this document with.');
      setStatus(STATUS.ERROR);
      return;
    }
    if (inputMode === 'file' && !file) {
      setError('Please select a PDF file to process.');
      setStatus(STATUS.ERROR);
      return;
    }
    if (inputMode === 'url') {
      try {
        const ensured = ensureHttpUrl(url);
        setUrl(ensured);
      } catch (e) {
        setError(e.message || 'Please enter a valid URL.');
        setStatus(STATUS.ERROR);
        return;
      }
    }

    setError(null);
    setExtractedData(null);
    setStatus(STATUS.UPLOADING);

    try {
      let fileUrl;
      if (inputMode === 'file' && file) {
        const upload = await base44.integrations.Core.UploadPrivateFile({ file });
        if (!upload?.file_uri) throw new Error('Upload failed. No file URI returned.');
        fileUrl = upload.file_uri;
      } else {
        fileUrl = ensureHttpUrl(url);
      }

      setStatus(STATUS.PROCESSING);

      const schema = documentType === 'debt' ? debtSchemaForExtraction : grantSchemaForExtraction;

      const response = await base44.functions.invoke('parseNOFO', {
        body: {
          file_url: fileUrl,
          json_schema: schema,
          is_url: inputMode === 'url',
          document_type: documentType,
          organization_id: selectedOrgId,
        }
      });

      const data = response?.data;
      const fnError = response?.error;

      if (fnError) {
        throw new Error(fnError.message || 'Failed to parse document.');
      }

      if (!data || !data.success) {
        const dmsg = data?.message || data?.details || 'Could not extract data from the document.';
        throw new Error(dmsg);
      }

      const rawOutput = data.output;
      const normalized = normalizeOutput(rawOutput, schema);

      setExtractedData(normalized);
      setStatus(STATUS.SUCCESS);
      safeToast({
        title: 'Document Processed! ✨',
        description: 'Review the extracted information below.',
      });
    } catch (err) {
      const msg =
        err?.response?.data?.message ||
        err?.response?.data?.details ||
        err?.message ||
        'An unexpected error occurred while processing the document.';
      setError(msg);
      setStatus(STATUS.ERROR);
      safeToast({
        variant: 'destructive',
        title: 'Processing Failed',
        description: msg,
      });
    }
  }, [selectedOrgId, inputMode, file, url, documentType, safeToast]);

  const reset = useCallback(() => {
    setFile(null);
    setUrl('');
    setStatus(STATUS.IDLE);
    setError(null);
    setExtractedData(null);
  }, []);

  const isProcessing = status === STATUS.UPLOADING || status === STATUS.PROCESSING;
  const canProcess =
    Boolean(selectedOrgId) &&
    !isProcessing &&
    ((inputMode === 'file' && !!file) || (inputMode === 'url' && !!url.trim()));

  return {
    file,
    url,
    status,
    error,
    extractedData,
    isProcessing,
    canProcess,
    handleFileChange,
    handleUrlChange,
    processDocument,
    reset,
  };
}