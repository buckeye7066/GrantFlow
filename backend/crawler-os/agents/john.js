// crawler-os/agents/john.js
//
// John — Outreach Drafting. John turns Yana's QUALIFIED leads into warm,
// personalized email DRAFTS and saves them for a human to review and send.
//
// Hard doctrine, enforced structurally:
//   - John NEVER sends. There is no send path in this module — only saveDraft.
//   - Drafts are authored from the alias Annie@axiombiolabs.org.
//   - Every draft includes opt-out language and avoids guarantees/false
//     personalization; it uses only the evidence Yana captured.
//   - John respects the suppression list and only drafts from qualified leads
//     (Yana already enforces the 50/24h cap on what becomes qualified).

import {
  heartbeat, recordAgentJob, getLeads, getDrafts, saveDraft, isSuppressed,
} from '../storage.js';

const AGENT_ID = 'john';
const DEFAULT_ALIAS = 'Annie@axiombiolabs.org';

function composeSubject(lead) {
  const who = lead.profile_type ? titleCase(lead.profile_type) : 'your organization';
  return `Funding support for ${who}`;
}

function composeBody(lead, outreach) {
  const name = lead.name ? lead.name : 'Hello';
  const needs = parseNeeds(lead);
  const needLine = needs.length
    ? `Based on what's publicly visible, it looks like ${needs.join(', ')} may be priorities for you right now.`
    : `It looks like you may have funding needs we could help with.`;
  const typeLine = lead.profile_type
    ? `GrantFlow works with ${pluralize(lead.profile_type)} to find real, matched funding and to help complete applications.`
    : `GrantFlow helps people and organizations find real, matched funding and complete applications.`;

  const lines = [
    `Hi ${name},`,
    ``,
    `I'm reaching out from GrantFlow. ${needLine}`,
    ``,
    typeLine,
    `We focus on real opportunities that fit your situation — no guarantees, just a clearer path to funding you may qualify for.`,
    ``,
    `If that would be useful, just reply and we can take it from there.`,
    ``,
    `Warm regards,`,
    `The GrantFlow Team`,
    ``,
    `— ${outreach.alias}`,
  ];
  if (outreach.mailingAddress) lines.push(outreach.mailingAddress);
  lines.push(``, `If you'd prefer not to hear from us, reply "unsubscribe" and we won't contact you again.`);
  return lines.join('\n');
}

export function createJohn(deps = {}) {
  const { store, clock = () => Date.now() } = deps;
  if (!store) throw new Error('createJohn: store required');
  const outreach = {
    alias: deps.outreach?.alias ?? DEFAULT_ALIAS,
    mailingAddress: deps.outreach?.mailingAddress ?? null,
  };

  return {
    id: AGENT_ID,
    alias: outreach.alias,
    // Intentionally NO send() method. John is draft-only by design.

    /**
     * run — draft outreach for qualified leads that don't yet have a draft.
     * @param {{ now?:number }} [opts]
     */
    async run(opts = {}) {
      const now = Number.isFinite(opts.now) ? opts.now : clock();
      heartbeat(store, AGENT_ID, { now, status: 'running' });

      const existingDraftKeys = new Set(getDrafts(store).map((d) => d.lead_key));
      const qualified = getLeads(store).filter((l) => l.status === 'qualified' && !existingDraftKeys.has(l.lead_key));

      const result = { agent: AGENT_ID, considered: qualified.length, drafted: 0, blocked: 0, alias: outreach.alias, drafts: [], blocks: [] };

      for (const lead of qualified) {
        // Safety: suppression re-check at draft time.
        const domain = lead.evidence_json ? safeParse(lead.evidence_json)?.domain : null;
        if ((lead.contact && isSuppressed(store, lead.contact, 'email')) || (domain && isSuppressed(store, domain, 'domain'))) {
          saveDraft(store, { lead_key: lead.lead_key, alias_from: outreach.alias, to: lead.contact, subject: null, body: null, status: 'blocked', blocked_reason: 'suppressed' });
          result.blocked += 1; result.blocks.push({ lead_key: lead.lead_key, reason: 'suppressed' }); continue;
        }
        // Evidence requirement: never draft without public evidence.
        const ev = safeParse(lead.evidence_json) ?? {};
        const hasEvidence = Boolean(ev.text || (ev.needs ?? []).length || lead.contact);
        if (!hasEvidence) {
          saveDraft(store, { lead_key: lead.lead_key, alias_from: outreach.alias, to: lead.contact, subject: null, body: null, status: 'blocked', blocked_reason: 'insufficient_evidence' });
          result.blocked += 1; result.blocks.push({ lead_key: lead.lead_key, reason: 'insufficient_evidence' }); continue;
        }

        const leadView = { ...lead, _needs: ev.needs ?? [] };
        const subject = composeSubject(lead);
        const body = composeBody(leadView, outreach);
        saveDraft(store, { lead_key: lead.lead_key, alias_from: outreach.alias, to: lead.contact, subject, body, status: 'draft', blocked_reason: null });
        result.drafted += 1;
        result.drafts.push({ lead_key: lead.lead_key, to: lead.contact, subject, alias_from: outreach.alias });
      }

      recordAgentJob(store, { agent_id: AGENT_ID, kind: 'draft', status: 'ok', detail: { drafted: result.drafted, blocked: result.blocked } });
      heartbeat(store, AGENT_ID, { now, status: 'idle' });
      return result;
    },
  };
}

// ---- helpers --------------------------------------------------------------
function parseNeeds(lead) {
  if (Array.isArray(lead._needs)) return lead._needs;
  const ev = safeParse(lead.evidence_json);
  return ev?.needs ?? [];
}
function safeParse(s) { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? null); } catch { return null; } }
function titleCase(s) { return String(s).replace(/\b\w/g, (m) => m.toUpperCase()); }
function pluralize(t) {
  const s = String(t).toLowerCase();
  if (s.endsWith('y')) return `${s.slice(0, -1)}ies`;
  if (s.endsWith('s')) return s;
  return `${s}s`;
}

export default { createJohn };
