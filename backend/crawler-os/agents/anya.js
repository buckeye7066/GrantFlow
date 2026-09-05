// ============================================================================
// NOT THE LIVE IMPLEMENTATION. Nothing imports this file.
//
// The agent that actually runs is backend/services/anyaOrchestrator.js. This module is
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

// crawler-os/agents/anya.js
//
// Anya — User Guide & Automation Navigator. Anya explains GrantFlow in plain
// language, translates the canonical telemetry (zero-result ladder, match
// explanations, pipeline state) for users, and routes them to the right
// automation. Anya invents nothing: she only presents canonical data and points
// at the real controls/agents. She never fabricates funding, facts, or match
// reasons, and never claims an action ran unless it actually did.

import { PIPELINE_STAGES, PIPELINE_STAGE } from '../stages.js';
import { getMatchesForProfile, getPipeline, getDocuments } from '../storage.js';
import { buildProjectReadinessPlan } from '../projectReadinessPlan.js';

const AGENT_ID = 'anya';

const STAGE_PLAIN = {
  discovered: 'We found this opportunity; you haven\u2019t acted on it yet.',
  saved: 'You saved this to look at later.',
  interested: 'You marked real interest in applying.',
  gathering_documents: 'You\u2019re collecting the documents the application needs.',
  drafting: 'The application is being written (Hamilton can do this for you).',
  ready_to_submit: 'Everything\u2019s prepared; it\u2019s ready to send.',
  submitted: 'The application has been submitted.',
  follow_up: 'Submitted \u2014 now waiting and following up with the funder.',
  awarded: 'You were awarded funding. \uD83C\uDF89',
  declined: 'This one was declined; the record is kept for learning.',
  archived: 'Closed out and filed away.',
};

export function createAnya(deps = {}) {
  const { store } = deps;

  return {
    id: AGENT_ID,

    /** Plain-language tour of the 11 canonical pipeline stages, in order. */
    explainStages() {
      return PIPELINE_STAGES.map((s, i) => ({ order: i + 1, stage: s, meaning: STAGE_PLAIN[s] ?? s }));
    },

    /** Translate a discovery run's zero-result ladder into guidance. */
    explainZeroResult(run) {
      const z = run?.zero_result;
      if (!z) {
        return { ok: true, message: `Found ${run?.stored ?? 0} opportunit${(run?.stored ?? 0) === 1 ? 'y' : 'ies'}. ${run?.recommendations?.length ? `${run.recommendations.length} look like strong matches worth reviewing.` : 'Open them to review and save the ones that fit.'}` };
      }
      const lines = [];
      lines.push(reasonToPlain(z.zero_result_reason));
      if (z.searched_sources?.length) lines.push(`I searched: ${z.searched_sources.join(', ')}.`);
      if (z.skipped_sources?.length) lines.push(`I skipped (honestly, not faked): ${z.skipped_sources.map((s) => `${s.source_id} [${s.reason}]`).join(', ')}.`);
      if (z.missing_profile_fields?.length) lines.push(`To do better, add: ${z.missing_profile_fields.join('; ')}.`);
      return { ok: false, message: lines.join(' '), next_steps: z.next_steps ?? [] };
    },

    /** Explain one match decision for a user, from canonical match_explain. */
    explainMatch(matchRow) {
      if (!matchRow) return 'No match to explain.';
      const ex = safeParse(matchRow.match_explain_json) ?? matchRow.match_explain ?? {};
      const decisionWord = matchRow.decision === 'accept' ? 'a strong match' : matchRow.decision === 'review' ? 'worth a look' : 'not a fit right now';
      const why = ex.why ?? `score ${matchRow.match_score}/100`;
      const warn = (ex.warnings ?? []).length ? ` Heads-up: ${ex.warnings.join('; ')}.` : '';
      return `This is ${decisionWord} (${matchRow.match_score}/100). ${why}.${warn}`;
    },

    /** Suggest the next best action for a profile, pointing at real automation. */
    suggestNextAction(profileId) {
      if (!store || !profileId) return { action: 'complete_profile', why: 'A fuller profile unlocks better matches.', control: 'Profile editor' };
      const recs = getMatchesForProfile(store, profileId, { minScore: 0 }).filter((m) => m.decision === 'accept');
      const pipeline = getPipeline(store, profileId);
      if (recs.length && !pipeline.length) {
        return { action: 'review_recommendations', why: `You have ${recs.length} strong match(es) ready to review.`, control: 'Recommendations list \u2192 Save / Automate with Hamilton' };
      }
      const drafting = pipeline.find((p) => p.stage === PIPELINE_STAGE.GATHERING_DOCUMENTS || p.stage === PIPELINE_STAGE.DRAFTING || p.stage === PIPELINE_STAGE.INTERESTED);
      if (drafting) {
        return { action: 'automate_with_hamilton', why: 'An opportunity in your pipeline is ready for application work.', control: 'Pipeline card \u2192 Automate selected with Hamilton' };
      }
      if (!recs.length && !pipeline.length) {
        return { action: 'run_discovery', why: 'Let Robert search for funding that matches your profile.', control: 'Find funding (Robert)' };
      }
      return { action: 'follow_pipeline', why: 'Keep moving your saved opportunities toward submission.', control: 'Pipeline' };
    },

    /** Route a free-text intent to the right agent/control (no NLP magic claimed). */
    route(intent = '') {
      const s = String(intent).toLowerCase();
      if (/find|search|discover|more funding|grants?/.test(s)) return { agent: 'robert', control: 'Find funding', why: 'Robert discovers and matches real funding.' };
      if (/apply|complete|submit|packet|write/.test(s)) return { agent: 'hamilton', control: 'Automate with Hamilton', why: 'Hamilton completes applications and builds packets.' };
      if (/client|lead|prospect/.test(s)) return { agent: 'yana', control: 'Client discovery', why: 'Yana finds and qualifies potential clients.' };
      if (/email|outreach|draft/.test(s)) return { agent: 'john', control: 'Outreach drafts', why: 'John drafts outreach for review (never sends).' };
      if (/health|broken|error|stuck|fix/.test(s)) return { agent: 'sam', control: 'System health', why: 'Sam supervises and self-heals the system.' };
      if (/stage|pipeline|status|where/.test(s)) return { agent: 'anya', control: 'Pipeline explainer', why: 'I can walk you through your pipeline stages.' };
      return { agent: 'anya', control: 'Guide', why: 'I can help you figure out the next step.' };
    },

    /** A compact profile snapshot in plain language. */
    summarizeProfileState(profileId) {
      if (!store || !profileId) return 'No profile selected.';
      const recs = getMatchesForProfile(store, profileId, { minScore: 0 });
      const accepts = recs.filter((m) => m.decision === 'accept').length;
      const pipeline = getPipeline(store, profileId);
      const docs = getDocuments(store, profileId);
      return `You have ${accepts} strong match(es), ${pipeline.length} opportunit(ies) in your pipeline, and ${docs.length} document(s) on file.`;
    },

    /** Build a profile-aware interview that starts from known profile fields. */
    buildProjectInterview(profile = {}) {
      const plan = buildProjectReadinessPlan(profile);
      const questions = plan.interview_questions ?? [];
      const intro = questions.length
        ? `Good job. Now that you have gotten this far, I have a few questions to narrow down what you actually need. I will keep this practical: answer what you know, skip what you do not, and I will turn it into a working checklist.`
        : `Good job. You have enough detail for a first action plan, so I can start building the checklist and tighten the next round as we learn more.`;
      return {
        intro,
        plan,
        first_question: questions[0] ?? null,
        questions,
      };
    },
  };
}

function reasonToPlain(reason) {
  switch (reason) {
    case 'no_sources_selected': return 'No funding sources matched your profile\u2019s scope yet.';
    case 'all_sources_skipped': return 'Every source was skipped (usually a missing API key or an unimplemented adapter) \u2014 nothing was faked to fill the gap.';
    case 'all_fetches_failed': return 'The sources couldn\u2019t be reached this run (a network/connectivity issue).';
    case 'no_candidates_parsed': return 'Sources responded, but returned no results for these search terms.';
    case 'all_below_match_floor': return 'We found opportunities, but none cleared your match threshold.';
    case 'all_rejected_by_reality': return 'We found candidates, but they failed our reality checks (placeholder, loan, expired, or bad link).';
    default: return 'No results this time \u2014 here\u2019s what happened and what to try next.';
  }
}
function safeParse(s) { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? null); } catch { return null; } }

export default { createAnya };
