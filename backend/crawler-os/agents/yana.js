// crawler-os/agents/yana.js
//
// Yana — Client Discovery & Lead Intelligence. Yana finds and QUALIFIES potential
// GrantFlow clients. She is NOT the application agent and NOT John: she never
// sends email and never completes applications.
//
// Doctrine specifics enforced here:
//   - Up to 50 QUALIFIED leads per rolling 24h (hard cap on what is forwarded).
//   - May scan many sites to find them; the raw site scan is pluggable
//     (deps.discover) because it needs a real search/crawl provider in
//     production. The QUALIFICATION logic — fit/urgency scoring, evidence
//     requirement, dedup, suppression — is real and runs here.
//   - Deduplicates leads (stable lead_key) and respects the suppression list.
//   - Persists qualified leads via storage.saveLead (status 'qualified'); John
//     reads them from there.
//
// A "lead candidate" is a plain descriptor:
//   { name, source_url, profile_type?, contact?, evidence? (string|object), needs?[] }

import { createHash } from 'node:crypto';
import {
  heartbeat, recordAgentJob, saveLead, getLeads, isSuppressed,
} from '../storage.js';

const AGENT_ID = 'yana';
const DAILY_QUALIFIED_CAP = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIT_THRESHOLD = 50; // 0..100

function leadKey(c) {
  const basis = `${(c.source_url ?? '').toLowerCase()}|${(c.name ?? '').toLowerCase()}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

// Real, deterministic qualification scoring over the evidence we were given.
function scoreLead(c) {
  const reasons = [];
  let fit = 0;
  const evidenceText = typeof c.evidence === 'string' ? c.evidence : JSON.stringify(c.evidence ?? '');
  const normalizedEvidence = String(evidenceText ?? '').trim();
  const hasEvidence = Boolean(normalizedEvidence.length > 8 && normalizedEvidence !== 'null' && normalizedEvidence !== '{}');

  if (c.profile_type) { fit += 25; reasons.push(`identifiable profile type: ${c.profile_type}`); }
  if ((c.needs ?? []).length) { fit += 25; reasons.push(`stated need(s): ${(c.needs ?? []).join(', ')}`); }
  if (c.contact) { fit += 20; reasons.push('contact point present'); }
  if (hasEvidence) { fit += 20; reasons.push('public evidence captured'); }
  if (c.source_url) { fit += 10; reasons.push('source URL captured'); }

  // Urgency: explicit signal words in evidence raise urgency.
  let urgency = 30;
  if (/\b(deadline|urgent|closing|emergency|immediate|by \w+ \d)/i.test(evidenceText)) { urgency = 80; reasons.push('time-sensitive signal in evidence'); }
  else if ((c.needs ?? []).some((n) => /emergency|disaster|medical/i.test(n))) { urgency = 65; }

  return { fit: Math.min(100, fit), urgency, reasons, hasEvidence };
}

export function createYana(deps = {}) {
  const { store, clock = () => Date.now() } = deps;
  if (!store) throw new Error('createYana: store required');
  // Optional pluggable site-scan provider (production search/crawl). Must return
  // an array of lead candidates. Absent => Yana qualifies only injected input.
  const discover = typeof deps.discover === 'function' ? deps.discover : null;

  return {
    id: AGENT_ID,
    DAILY_QUALIFIED_CAP,

    /**
     * run — qualify lead candidates within the rolling-24h cap.
     * @param {{ candidates?:object[], maxScan?:number, now?:number }} [opts]
     */
    async run(opts = {}) {
      const now = Number.isFinite(opts.now) ? opts.now : clock();
      heartbeat(store, AGENT_ID, { now, status: 'running' });

      let candidates = opts.candidates ?? [];
      if (discover) {
        try { candidates = await discover({ maxScan: opts.maxScan ?? 1000, now }) ?? []; }
        catch (e) { recordAgentJob(store, { agent_id: AGENT_ID, kind: 'discover', status: 'error', detail: { error: String(e?.message ?? e) } }); }
      }

      // How many qualified already exist in the rolling window (counts toward cap).
      const windowStart = now - DAY_MS;
      const already = getLeads(store, { since: windowStart }).filter((l) => l.status === 'qualified').length;
      let remaining = Math.max(0, DAILY_QUALIFIED_CAP - already);

      const result = { agent: AGENT_ID, scanned: candidates.length, qualified: 0, rejected: 0, deferred: 0, suppressed: 0, duplicate: 0, cap: DAILY_QUALIFIED_CAP, window_existing: already, leads: [], rejections: [] };
      const seenThisRun = new Set();

      for (const c of candidates) {
        const key = leadKey(c);
        // dedup: within this run and against already-stored leads
        if (seenThisRun.has(key) || getLeads(store).some((l) => l.lead_key === key)) {
          result.duplicate += 1; result.rejections.push({ name: c.name, reason: 'duplicate' }); continue;
        }
        seenThisRun.add(key);

        const domain = safeDomain(c.source_url);
        if ((c.contact && isSuppressed(store, c.contact, 'email')) || (domain && isSuppressed(store, domain, 'domain'))) {
          result.suppressed += 1; result.rejections.push({ name: c.name, reason: 'suppressed' }); continue;
        }

        const sc = scoreLead(c);
        if (!sc.hasEvidence) { result.rejected += 1; result.rejections.push({ name: c.name, reason: 'no_evidence' }); continue; }
        if (sc.fit < FIT_THRESHOLD) { result.rejected += 1; result.rejections.push({ name: c.name, reason: `low_fit:${sc.fit}` }); continue; }

        if (remaining <= 0) { result.deferred += 1; result.rejections.push({ name: c.name, reason: 'daily_cap_reached' }); continue; }

        const lead = {
          lead_key: key, name: c.name ?? null, profile_type: c.profile_type ?? null,
          source_url: c.source_url ?? null, contact: c.contact ?? null,
          fit_score: sc.fit, urgency: sc.urgency, why: sc.reasons,
          evidence: { text: typeof c.evidence === 'string' ? c.evidence : null, needs: c.needs ?? [], domain },
          status: 'qualified', created_at: new Date(now).toISOString(),
        };
        saveLead(store, lead);
        remaining -= 1; result.qualified += 1;
        result.leads.push({ lead_key: key, name: lead.name, profile_type: lead.profile_type, fit_score: lead.fit_score, urgency: lead.urgency });
      }

      recordAgentJob(store, { agent_id: AGENT_ID, kind: 'qualify', status: 'ok', detail: { qualified: result.qualified, rejected: result.rejected, deferred: result.deferred } });
      heartbeat(store, AGENT_ID, { now, status: 'idle' });
      return result;
    },
  };
}

function safeDomain(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

export default { createYana };
