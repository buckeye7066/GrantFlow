import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Copy, Check, ChevronLeft, ChevronRight, Download } from "lucide-react";

// Block 1: First 10 main functions (already read)
const BLOCK_1 = {
  'analyzeGrant': `import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { resolveGrantId, resolveOrganizationId } from './_utils/resolveEntityId.js';

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;

function validateResult(value) {
  if (value === undefined) throw new Error("API returned undefined");
  return value;
}

function getRetryDelay(attemptNumber) {
  return INITIAL_RETRY_DELAY * Math.pow(2, attemptNumber);
}

async function run(req) {
  const requestId = crypto.randomUUID().slice(0, 8);
  console.log(\`[\${requestId}] analyzeGrant START\`);
  
  const base44 = createClientFromRequest(req);
  
  let user = null;
  try {
    user = await base44.auth.me();
  } catch (authErr) {
    throw new Error('UNAUTHENTICATED');
  }
  
  if (!user) {
    throw new Error('UNAUTHENTICATED');
  }
  
  const sdk = base44.asServiceRole;
  
  let body = null;
  try {
    body = await req.json();
  } catch (parseError) {
    throw new Error('INVALID_JSON');
  }
  
  if (!body || typeof body !== 'object') {
    throw new Error('Invalid request body');
  }
  
  const { grant_id: rawGrantId, organization_id: rawOrgId, profile_id: rawProfileId } = body;
  
  if (!rawGrantId) {
    throw new Error('grant_id is required');
  }
  
  if (!rawOrgId) {
    throw new Error('organization_id is required');
  }
  
  let grant_id, organization_id;
  try {
    grant_id = await resolveGrantId(sdk, rawGrantId);
    organization_id = await resolveOrganizationId(sdk, rawOrgId);
  } catch (resolveErr) {
    throw new Error('INVALID_IDENTIFIER: ' + resolveErr.message);
  }
  
  const grant = await sdk.entities.Grant.get(grant_id);
  const organization = await sdk.entities.Organization.get(organization_id);
  
  if (!grant || !grant.id) {
    throw new Error('NOT_FOUND: Grant');
  }
  
  if (!organization || !organization.id) {
    throw new Error('NOT_FOUND: Organization');
  }
  
  if (grant.organization_id !== organization_id) {
    throw new Error('Grant does not belong to specified organization');
  }
  
  try {
    await sdk.entities.Grant.update(grant_id, { ai_status: 'running' });
  } catch (updateErr) {
    throw new Error(\`Write failure updating status: \${updateErr.message}\`);
  }
  
  const prompt = buildAnalysisPrompt(grant, organization);
  
  let lastError = null;
  let aiResult = null;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      aiResult = await sdk.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: "object",
          properties: {
            fit_score: { type: "number" },
            strengths: { type: "array", items: { type: "string" } },
            concerns: { type: "array", items: { type: "string" } },
            recommendations: { type: "array", items: { type: "string" } },
            summary: { type: "string" },
            estimated_effort_hours: { type: "number" },
            required_documents: { 
              type: "array", 
              items: { 
                type: "object",
                properties: {
                  name: { type: "string" },
                  type: { type: "string" },
                  description: { type: "string" },
                  priority: { type: "string" }
                }
              }
            },
            funder_tone: { type: "string" }
          }
        }
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES - 1) {
        const delay = getRetryDelay(attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  if (!aiResult) {
    try {
      await sdk.entities.Grant.update(grant_id, {
        ai_status: 'error',
        ai_error: lastError?.message || 'AI service unavailable'
      });
    } catch (updateErr) {
      console.error('Write failure updating error status');
    }
    throw new Error('LLM_ERROR: AI analysis failed');
  }
  
  const summary = buildAISummary(aiResult, grant, organization);
  
  try {
    await sdk.entities.Grant.update(grant_id, {
      ai_summary: summary,
      ai_status: 'ready',
      ai_updated_at: new Date().toISOString(),
      ai_error: null,
      match_score: Math.round(aiResult.fit_score || 0)
    });
  } catch (updateErr) {
    throw new Error(\`Write failure updating grant: \${updateErr.message}\`);
  }
  
  const requirementsCreated = [];
  if (aiResult.required_documents && Array.isArray(aiResult.required_documents)) {
    for (const doc of aiResult.required_documents) {
      try {
        const reqType = mapDocumentToRequirementType(doc.type || doc.name);
        const created = await sdk.entities.ApplicationRequirement.create({
          grant_id: grant_id,
          organization_id: organization_id,
          profile_id: organization_id,
          requirement_type: reqType,
          requirement_name: doc.name || doc.description || 'Unnamed',
          deadline: grant.deadline || null,
          status: 'not_started',
          priority: doc.priority || 'medium',
          notes: doc.description || ''
        });
        requirementsCreated.push(created);
        await new Promise(r => setTimeout(r, 50));
      } catch (reqErr) {
        console.warn('Failed to create requirement:', reqErr.message);
      }
    }
  }
  
  return {
    summary,
    analysis: aiResult,
    requirements_created: requirementsCreated.length
  };
}

function buildAnalysisPrompt(grant, organization) {
  const profileDetails = [];
  if (organization.age) profileDetails.push(\`Age: \${organization.age}\`);
  if (organization.gpa) profileDetails.push(\`GPA: \${organization.gpa}\`);
  if (organization.intended_major) profileDetails.push(\`Field: \${organization.intended_major}\`);
  if (organization.household_income) profileDetails.push(\`Income: $\${organization.household_income.toLocaleString()}\`);
  
  const flags = [];
  if (organization.first_generation) flags.push('first-generation');
  if (organization.low_income) flags.push('low-income');
  if (organization.veteran) flags.push('veteran');
  if (organization.foster_youth) flags.push('foster youth');

  return \`Analyze this funding opportunity.

OPPORTUNITY:
Title: \${grant.title}
Funder: \${grant.funder}
Award: $\${grant.award_floor || 0} - $\${grant.award_ceiling || 'N/A'}
Deadline: \${grant.deadline || 'N/A'}
Description: \${grant.program_description || 'N/A'}
Eligibility: \${grant.eligibility_summary || 'N/A'}

APPLICANT:
Name: \${organization.name}
Type: \${organization.applicant_type?.replace(/_/g, ' ') || 'individual'}
Location: \${organization.city || ''}, \${organization.state || ''}
\${profileDetails.length > 0 ? 'Details: ' + profileDetails.join(', ') : ''}
\${flags.length > 0 ? 'Circumstances: ' + flags.join(', ') : ''}
Goals: \${organization.goals || organization.primary_goal || 'N/A'}

Provide: fit_score (0-100), strengths, concerns, recommendations, summary, required_documents, funder_tone.\`;
}

function buildAISummary(aiResult, grant, organization) {
  const parts = [
    \`**Match Score: \${Math.round(aiResult.fit_score || 0)}/100**\`,
    '',
    aiResult.summary || 'Analysis completed.',
    ''
  ];
  
  if (aiResult.strengths?.length > 0) {
    parts.push('**Strengths:**');
    aiResult.strengths.forEach(s => parts.push(\`• \${s}\`));
    parts.push('');
  }
  
  if (aiResult.concerns?.length > 0) {
    parts.push('**Concerns:**');
    aiResult.concerns.forEach(c => parts.push(\`• \${c}\`));
    parts.push('');
  }
  
  if (aiResult.recommendations?.length > 0) {
    parts.push('**Recommendations:**');
    aiResult.recommendations.forEach(r => parts.push(\`• \${r}\`));
  }
  
  return parts.join('\\n');
}

function mapDocumentToRequirementType(docType) {
  if (!docType) return 'other';
  const lower = docType.toLowerCase();
  
  const typeMap = {
    'transcript': 'transcript',
    'test score': 'test_score',
    'essay': 'essay',
    'recommendation': 'recommendation_letter',
    'financial': 'financial_document',
    'form': 'application_form',
    'resume': 'resume',
    'personal statement': 'personal_statement'
  };
  
  for (const [key, value] of Object.entries(typeMap)) {
    if (lower.includes(key)) return value;
  }
  
  return 'other';
}

Deno.serve(async (req) => {
  try {
    const result = validateResult(await run(req));
    return Response.json({ ok: true, result });
  } catch (error) {
    console.error('analyzeGrant ERROR:', error.message);
    return Response.json({
      ok: false,
      error: error?.message ?? 'Unknown error',
      stack: error?.stack ?? null
    }, { status: error?.message?.includes('NOT_FOUND') ? 404 : error?.message?.includes('UNAUTH') ? 401 : 500 });
  }
});`
};

export default function GithubTunnel() {
  const [copiedKey, setCopiedKey] = useState(null);
  const [activeTab, setActiveTab] = useState('block1');

  const copyToClipboard = (key, content) => {
    navigator.clipboard.writeText(content);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const downloadAll = () => {
    const allCode = Object.entries(BLOCK_1)
      .map(([name, code]) => `// ===== functions/${name}.js =====\n\n${code}\n\n`)
      .join('\n');
    
    const blob = new Blob([allCode], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'grantflow-functions-block1.js';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">GitHub Code Tunnel</h1>
        <p className="text-slate-600 mb-4">
          Copy function code blocks to push to GitHub. Each block contains the actual source code.
        </p>
        <Button onClick={downloadAll} className="gap-2">
          <Download className="w-4 h-4" />
          Download Block 1 as File
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="block1">Block 1 (analyzeGrant)</TabsTrigger>
          <TabsTrigger value="instructions">Instructions</TabsTrigger>
        </TabsList>

        <TabsContent value="block1">
          <div className="space-y-4">
            {Object.entries(BLOCK_1).map(([name, code]) => (
              <Card key={name}>
                <CardHeader className="flex flex-row items-center justify-between py-3">
                  <CardTitle className="text-lg font-mono">functions/{name}.js</CardTitle>
                  <Button
                    variant={copiedKey === name ? "default" : "outline"}
                    size="sm"
                    onClick={() => copyToClipboard(name, code)}
                  >
                    {copiedKey === name ? (
                      <><Check className="w-4 h-4 mr-1" /> Copied!</>
                    ) : (
                      <><Copy className="w-4 h-4 mr-1" /> Copy Code</>
                    )}
                  </Button>
                </CardHeader>
                <CardContent>
                  <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg overflow-x-auto text-xs max-h-64 overflow-y-auto">
                    {code.slice(0, 2000)}...
                  </pre>
                  <p className="text-xs text-slate-500 mt-2">
                    {code.length} characters • Click "Copy Code" to get the full source
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="instructions">
          <Card>
            <CardContent className="py-6">
              <h3 className="font-semibold mb-4">How to Push to GitHub:</h3>
              <ol className="space-y-3 list-decimal list-inside text-sm">
                <li>Click "Copy Code" for each function</li>
                <li>Go to github.com/buckeye7066/GrantFlow</li>
                <li>Navigate to the functions/ folder</li>
                <li>Click "Add file" → "Create new file" or edit existing</li>
                <li>Name it exactly as shown (e.g., analyzeGrant.js)</li>
                <li>Paste the code</li>
                <li>Commit with message "Add [function name]"</li>
                <li>Repeat for all functions</li>
              </ol>
              
              <div className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-amber-800 text-sm">
                  <strong>Note:</strong> This page shows Block 1 only. Ask me to generate more blocks as needed.
                  Each block will contain ~10-20 functions with their complete source code.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}