// NOTE: Large file (756 lines) with complex AI matching - see full source in Base44 dashboard
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
import { withDiagnostics } from './_shared/withDiagnostics.js';

const handler = async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 });
  
  const sdk = base44.asServiceRole;
  const body = await req.json();
  const { profile_id, min_score = 60 } = body;
  if (!profile_id) return Response.json({ success: false, error: 'profile_id required' }, { status: 400 });

  const profile = await sdk.entities.Organization.get(profile_id);
  const opportunities = await sdk.entities.FundingOpportunity.list('-created_date', 500);
  
  // AI batch analysis (simplified for GitHub)
  const matches = [];
  for (const opp of opportunities) {
    const score = 50 + Math.random() * 50; // Real version uses AI
    if (score >= min_score) matches.push({ ...opp, match: score, matchScore: score });
  }
  
  return Response.json({ success: true, matches, count: matches.length });
};

Deno.serve(withDiagnostics(handler, 'aiGrantMatcher'));