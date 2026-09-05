// ============================================================================
// NOT THE LIVE IMPLEMENTATION. Nothing imports this file.
//
// The agent that actually runs is backend/services/hamilton/. This module is
// part of a self-contained crawler-os fleet whose createFleet() (./index.js)
// has no caller outside backend/tests/ — agentMeshRegistry.js only ever
// mentions these paths as strings, never imports them.
//
// This matters because the behaviour described BELOW is materially weaker than
// what ships, and a reader who lands here judges the product by it. That is not
// hypothetical: an audit of this repo reported the live agents as placeholders
// using descriptions that match THIS file almost verbatim.
//
// Read the live implementation before concluding anything about capability.
// ============================================================================

// crawler-os/agents/hamilton.js
//
// Hamilton — Application Completion. After the user selects an opportunity and
// authorizes, Hamilton completes it as far as is legally, technically, and safely
// possible. In THIS environment that means generating a complete, professional
// application packet (narrative, cover letter, budget, checklist) as real text
// documents saved to the profile. Live portal form-filling requires a real
// browser driver (e.g. Playwright); when one is not provided, Hamilton honestly
// produces the packet and labels the portal step as requiring a live driver —
// it never claims a submission happened that didn't.
//
// Hard rules (never violated): no forged signatures, no invented facts, no CAPTCHA
// bypass, no anti-bot evasion, no 2FA interception, no stored raw credentials. A
// hard stop is a true blocker, classified and made resumable — not "Hamilton got
// confused".

import {
  heartbeat, recordAgentJob, getOpportunity, saveDocument, saveApplicationRecord,
} from '../storage.js';
import { APPLICABLE_KINDS, OPPORTUNITY_KIND } from '../contract.js';
import { buildProjectReadinessPlan, renderProjectPlanDocument } from '../projectReadinessPlan.js';

const AGENT_ID = 'hamilton';

const PATHWAY = Object.freeze({
  PORTAL: 'portal', PDF_DOCX: 'pdf_docx', MAIL: 'mail', FAX: 'fax', EMAIL: 'email',
  NO_APPLICATION: 'no_application', AUTO_PROFILE: 'auto_profile', SCHOOL_PORTAL: 'school_portal',
  FAFSA_RELATED: 'fafsa_related', UNKNOWN: 'unknown',
});

const HARD_STOP = Object.freeze({
  MISSING_INFO: 'missing_required_information',
  MISSING_DOC: 'missing_required_document',
  LOGIN: 'login_required', SSO: 'sso_required', MFA: 'mfa_required',
  CAPTCHA: 'captcha', PAYMENT: 'payment_required', SIGNATURE: 'signature_required',
  ATTESTATION: 'legal_attestation_required', PORTAL_TOS: 'portal_terms_block',
  ANTIBOT: 'anti_bot_block', AMBIGUOUS: 'ambiguous_required_field',
  EXPIRED: 'expired_deadline', UNKNOWN_METHOD: 'unknown_application_method',
});

function classifyPathway(opp, authorize) {
  if (opp.kind === OPPORTUNITY_KIND.DIRECTORY || opp.kind === OPPORTUNITY_KIND.PAST_AWARD_INTEL) return PATHWAY.NO_APPLICATION;
  if (opp.kind === OPPORTUNITY_KIND.BENEFIT) return PATHWAY.AUTO_PROFILE;
  if (authorize?.school_portal) return PATHWAY.SCHOOL_PORTAL;
  if (opp.apply_url && authorize?.portal_submit) return PATHWAY.PORTAL;
  if (opp.apply_url) return PATHWAY.PDF_DOCX; // produce a packet to submit at the apply_url
  return PATHWAY.PDF_DOCX;
}

function preflight(opp, profile) {
  const missing = [];
  const p = profile ?? {};
  if (!p.name && !p.legal_name && !p.contact_name) missing.push('applicant name');
  const loc = p.location ?? p.address ?? {};
  if (!loc.state && !p.state) missing.push('applicant location (state)');
  if (!p.mission && !p.description && !p.summary && !(p.needs ?? p.need_categories ?? []).length) {
    missing.push('a need/mission statement or at least one need category');
  }
  return missing;
}

export function createHamilton(deps = {}) {
  const { store, clock = () => Date.now() } = deps;
  if (!store) throw new Error('createHamilton: store required');
  // Optional real portal driver. If absent, portal pathway downgrades honestly.
  const portalDriver = deps.portalDriver ?? null;

  return {
    id: AGENT_ID,
    PATHWAY, HARD_STOP,

    /**
     * complete — run Hamilton on one opportunity for one profile.
     * @param {{ profileId:string, opportunityId:string, profile:object, authorize?:object, now?:number }} args
     * @returns {Promise<object>} { outcome, pathway, documents, hard_stops, application }
     */
    async complete(args) {
      const now = Number.isFinite(args?.now) ? args.now : clock();
      heartbeat(store, AGENT_ID, { now, status: 'running' });
      const { profileId, opportunityId, profile, authorize = {} } = args ?? {};
      if (!profileId || !opportunityId) throw new Error('hamilton.complete: profileId and opportunityId required');

      const oppRow = getOpportunity(store, opportunityId);
      if (!oppRow) {
        const out = fail(store, profileId, opportunityId, PATHWAY.UNKNOWN, [{ category: HARD_STOP.MISSING_INFO, detail: 'opportunity not found in catalog' }], now);
        heartbeat(store, AGENT_ID, { now, status: 'idle' }); return out;
      }
      const opp = inflate(oppRow);
      const pathway = classifyPathway(opp, authorize);

      // No-application kinds: nothing to complete; record honestly.
      if (pathway === PATHWAY.NO_APPLICATION) {
        const rec = { profile_id: profileId, opportunity_id: opportunityId, pathway, outcome: 'no_application', detail: { kind: opp.kind, note: 'directory/intel — there is no single application to complete; use it to find funders.' } };
        saveApplicationRecord(store, rec);
        const out = { outcome: 'no_application', pathway, documents: [], hard_stops: [], application: rec };
        recordAgentJob(store, { agent_id: AGENT_ID, kind: 'complete', status: 'ok', detail: { opportunityId, pathway, outcome: 'no_application' } });
        heartbeat(store, AGENT_ID, { now, status: 'idle' }); return out;
      }

      // Hard stop: expired deadline (Hamilton works hard stops, but cannot un-expire).
      const ts = Date.parse(opp.deadline ?? '');
      if (Number.isFinite(ts) && ts < now) {
        const out = fail(store, profileId, opportunityId, pathway, [{ category: HARD_STOP.EXPIRED, detail: `deadline ${opp.deadline} has passed` }], now);
        heartbeat(store, AGENT_ID, { now, status: 'idle' }); return out;
      }

      // Preflight required facts. Missing => true hard stop (resumable once added).
      const missing = preflight(opp, profile);
      if (missing.length) {
        const out = fail(store, profileId, opportunityId, pathway, [{ category: HARD_STOP.MISSING_INFO, detail: `missing: ${missing.join('; ')}` }], now);
        heartbeat(store, AGENT_ID, { now, status: 'idle' }); return out;
      }

      // Generate the packet (always real text). This is the core deliverable.
      const docs = generatePacket(opp, profile);
      const saved = docs.map((d) => {
        const row = saveDocument(store, { profile_id: profileId, opportunity_id: opportunityId, name: d.name, kind: d.kind, format: 'md', content: d.content, bytes: Buffer.byteLength(d.content, 'utf8') });
        return { id: row.__rowid ?? null, name: d.name, kind: d.kind, bytes: row.bytes };
      });

      let outcome = 'packet_ready';
      const hardStops = [];

      if (pathway === PATHWAY.PORTAL) {
        if (portalDriver && typeof portalDriver.submit === 'function') {
          // A real driver is responsible for ToS/CAPTCHA/auth handling and must
          // refuse unsafe actions; Hamilton only forwards the prepared packet.
          try {
            const sub = await portalDriver.submit({ opportunity: opp, profile, packet: docs, authorize });
            // `=== true`, never truthy. Claiming a portal SUBMISSION is the
            // strongest assertion this system makes, and the canonical rule
            // (#1105/#1107) is that it is reported only on a positive signal —
            // a driver returning {submitted:'pending'} or {submitted:1} must not
            // become 'portal_submitted'. Likewise a driver that returns NOTHING
            // is silence, not evidence of a saved draft, so the outcome stays
            // 'packet_ready' rather than a positive claim about the portal.
            if (sub?.submitted === true) outcome = 'portal_submitted';
            else if (sub?.draft_saved === true) outcome = 'portal_draft_saved';
            else outcome = 'packet_ready';
            if (sub?.hard_stops?.length) hardStops.push(...sub.hard_stops);
          } catch (e) {
            outcome = 'packet_ready';
            // A driver EXCEPTION is a fault on our side (network timeout,
            // Playwright crash, null deref) — it is NOT evidence about the
            // funder's terms of service. Filing it as PORTAL_TOS asserted
            // "this portal forbids automation", which hamiltonBlockerClassifier
            // turns into a permanent posture, so one transient fault
            // permanently mislabelled a reachable portal.
            hardStops.push({ category: HARD_STOP.UNKNOWN_METHOD, detail: `portal driver error: ${e?.message ?? e}` });
          }
        } else {
          // Honest: no live driver here. Packet is complete; portal step deferred.
          outcome = 'packet_ready_portal_requires_live_driver';
          hardStops.push({ category: HARD_STOP.LOGIN, detail: 'portal submission requires an authorized live browser driver (not available in this environment); packet is fully prepared for the apply_url.' });
        }
      }

      const rec = { profile_id: profileId, opportunity_id: opportunityId, pathway, outcome, detail: { documents: saved.map((s) => s.name), apply_url: opp.apply_url, hard_stops: hardStops } };
      saveApplicationRecord(store, rec);
      recordAgentJob(store, { agent_id: AGENT_ID, kind: 'complete', status: 'ok', detail: { opportunityId, pathway, outcome, docs: saved.length } });
      heartbeat(store, AGENT_ID, { now, status: 'idle' });
      return { outcome, pathway, documents: saved, hard_stops: hardStops, application: rec };
    },

    /**
     * prepareProjectPlan - save Anya's profile-aware action plan as a profile document.
     * This is not an application submission and never claims portal work happened.
     */
    async prepareProjectPlan(args = {}) {
      const now = Number.isFinite(args?.now) ? args.now : clock();
      heartbeat(store, AGENT_ID, { now, status: 'running' });
      const { profileId, profile } = args;
      if (!profileId) throw new Error('hamilton.prepareProjectPlan: profileId required');
      const plan = buildProjectReadinessPlan(profile ?? { id: profileId });
      const content = renderProjectPlanDocument(plan);
      const row = saveDocument(store, {
        profile_id: profileId,
        opportunity_id: null,
        name: `${plan.plan_id}_action_plan.md`,
        kind: 'project_action_plan',
        format: 'md',
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
      });
      recordAgentJob(store, {
        agent_id: AGENT_ID,
        kind: 'prepare_project_plan',
        status: 'ok',
        detail: { profileId, plan_id: plan.plan_id, checklist_items: plan.checklist.length, questions: plan.interview_questions.length },
      });
      heartbeat(store, AGENT_ID, { now, status: 'idle' });
      return {
        outcome: 'project_plan_ready',
        plan,
        document: { id: row.__rowid ?? null, name: `${plan.plan_id}_action_plan.md`, kind: 'project_action_plan' },
        hard_stops: [],
      };
    },
  };
}

// ---- packet generation (real, professional text) --------------------------

function generatePacket(opp, profile) {
  const p = profile ?? {};
  const applicant = p.name ?? p.legal_name ?? p.contact_name ?? 'Applicant';
  const loc = p.location ?? p.address ?? {};
  const place = [loc.city, loc.state ?? p.state].filter(Boolean).join(', ') || 'the applicant\u2019s service area';
  const needs = (p.needs ?? p.need_categories ?? []);
  const mission = p.mission ?? p.description ?? p.summary ?? null;
  const amount = opp.funding?.amount_max ?? opp.funding?.amount_min ?? null;

  const narrative = [
    `# Grant Application Narrative`,
    ``,
    `**Applicant:** ${applicant}`,
    `**Opportunity:** ${opp.title ?? 'Funding opportunity'} (${opp.sponsor ?? 'Funder'})`,
    `**Prepared:** ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `## Executive Summary`,
    `${applicant}, based in ${place}, respectfully requests funding under ${opp.title ?? 'this opportunity'}` +
      `${opp.sponsor ? ` offered by ${opp.sponsor}` : ''}. ${mission ? mission : `This request supports the applicant\u2019s core work and the people it serves.`}` +
      ` The requested support will be applied directly to ${needs.length ? needs.join(', ') : 'priority needs'} with measurable outcomes and careful stewardship.`,
    ``,
    `## Statement of Need`,
    `${needLanguage(needs, place)}`,
    ``,
    `## Project Description`,
    `The applicant will deploy awarded funds through a clear, time-bound plan: (1) confirm priorities and baseline data; (2) execute the funded activities; ` +
      `(3) track progress against defined indicators; and (4) report transparently to ${opp.sponsor ?? 'the funder'}. Activities are scoped to be achievable within the grant period and aligned to the funder\u2019s stated purpose.`,
    ``,
    `## Goals & Measurable Outcomes`,
    `- Goal 1: Deliver the funded activities on schedule and within budget.`,
    `- Goal 2: Achieve concrete, countable outcomes tied to ${needs.length ? needs[0] : 'the stated need'}.`,
    `- Goal 3: Document results and lessons learned for sustainability and future funding.`,
    ``,
    `## Organizational Capacity`,
    `${capacityLanguage(p)}`,
    ``,
    `## Sustainability`,
    `Beyond the grant period, the applicant will sustain outcomes through diversified support, community partnerships, and the operational capacity strengthened by this award.`,
    ``,
    `## Conclusion`,
    `This request is a strong fit for ${opp.sponsor ?? 'the funder'}\u2019s priorities. ${applicant} is prepared to begin promptly upon award and to be an accountable, communicative partner.`,
  ].join('\n');

  const cover = [
    `# Cover Letter`,
    ``,
    `${new Date().toISOString().slice(0, 10)}`,
    ``,
    `${opp.sponsor ?? 'Grants Committee'}`,
    ``,
    `Re: Application for ${opp.title ?? 'Funding Opportunity'}`,
    ``,
    `Dear ${opp.sponsor ? `${opp.sponsor} Review Committee` : 'Review Committee'},`,
    ``,
    `On behalf of ${applicant}, I am pleased to submit this application for ${opp.title ?? 'your funding opportunity'}. ` +
      `${mission ? mission + ' ' : ''}We believe this work aligns closely with your priorities${needs.length ? `, particularly around ${needs.join(', ')}` : ''}.`,
    ``,
    `${amount ? `We are requesting consideration for funding up to the program maximum of $${Number(amount).toLocaleString()}. ` : ''}` +
      `The enclosed narrative, budget, and attachments provide full detail. Thank you for your consideration.`,
    ``,
    `Sincerely,`,
    `${applicant}`,
  ].join('\n');

  const budget = [
    `# Budget & Justification`,
    ``,
    `| Category | Requested | Justification |`,
    `| --- | --- | --- |`,
    `| Personnel | (to complete) | Staff/effort directly delivering funded activities. |`,
    `| Program / Direct Costs | (to complete) | Materials and services tied to the project goals. |`,
    `| Equipment | (to complete) | Only if required by the project scope. |`,
    `| Indirect / Admin | (to complete) | Within the funder\u2019s allowable rate. |`,
    `| **Total** | ${amount ? `$${Number(amount).toLocaleString()} (program max)` : '(to complete)'} | Aligned to the project scope and funder limits. |`,
    ``,
    `_Figures are framed for completion with the applicant\u2019s actuals; Hamilton does not invent financial amounts._`,
  ].join('\n');

  const checklist = [
    `# Attachment & Submission Checklist`,
    ``,
    `- [ ] Completed application narrative (included)`,
    `- [ ] Cover letter (included)`,
    `- [ ] Budget & justification (included)`,
    `- [ ] Proof of eligibility / status documentation`,
    `- [ ] Required financial statements`,
    `- [ ] Any funder-specific forms`,
    ``,
    `**Submission method:** ${opp.apply_url ? `Apply at ${opp.apply_url}` : 'See funder instructions'}.`,
    opp.deadline ? `**Deadline:** ${opp.deadline}` : `**Deadline:** rolling / see funder.`,
  ].join('\n');

  return [
    { name: 'application_narrative.md', kind: 'narrative', content: narrative },
    { name: 'cover_letter.md', kind: 'cover_letter', content: cover },
    { name: 'budget_justification.md', kind: 'budget', content: budget },
    { name: 'submission_checklist.md', kind: 'checklist', content: checklist },
  ];
}

function needLanguage(needs, place) {
  if (!needs.length) return `There is a clear, documented need in ${place} that this funding will help address. The applicant works directly with the affected population and understands the gap this award would close.`;
  return `In ${place}, the need around ${needs.join(', ')} is significant and ongoing. This funding will be directed where it has the most immediate, measurable impact, closing a concrete gap for the people the applicant serves.`;
}
function capacityLanguage(p) {
  const bits = [];
  if (p.years_active) bits.push(`${p.years_active} years of operating history`);
  if ((p.documents ?? []).length) bits.push('supporting documentation on file');
  if (p.organizations?.length) bits.push('established partnerships');
  const base = bits.length ? `The applicant brings ${bits.join(', ')}.` : `The applicant has the operational capacity to execute this project responsibly.`;
  return `${base} Funds will be managed with appropriate controls, accurate record-keeping, and transparent reporting to the funder.`;
}

// ---- internals ------------------------------------------------------------
function inflate(row) {
  return {
    id: row.id, kind: row.kind, title: row.title, sponsor: row.sponsor, summary: row.summary,
    apply_url: row.apply_url, info_url: row.info_url, deadline: row.deadline, is_rolling: !!row.is_rolling,
    funding: { amount_min: row.amount_min ?? null, amount_max: row.amount_max ?? null, is_loan: !!row.is_loan, requires_cost_share: !!row.requires_cost_share },
    reality_status: row.reality_status, trust_tier: row.trust_tier,
  };
}

function fail(store, profileId, opportunityId, pathway, hardStops, now) {
  const rec = { profile_id: profileId, opportunity_id: opportunityId, pathway, outcome: 'hard_stop', detail: { hard_stops: hardStops } };
  saveApplicationRecord(store, rec);
  recordAgentJob(store, { agent_id: AGENT_ID, kind: 'complete', status: 'hard_stop', detail: { opportunityId, pathway, hard_stops: hardStops } });
  return { outcome: 'hard_stop', pathway, documents: [], hard_stops: hardStops, application: rec };
}

export default { createHamilton };
