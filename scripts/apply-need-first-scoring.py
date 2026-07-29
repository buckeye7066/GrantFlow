from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


engine_path = Path('backend/services/matchEngine.js')
engine = engine_path.read_text(encoding='utf-8')

engine = replace_once(
    engine,
    "import { guardDirectFundingDecision } from './matching/resourceDecisionGuard.js'\n",
    "import { guardDirectFundingDecision } from './matching/resourceDecisionGuard.js'\n"
    "import {\n"
    "  enforceNeedFirstDecision,\n"
    "  evaluateNeedFirstMatchPolicy,\n"
    "} from './matching/needFirstMatchPolicy.js'\n",
    'need-first imports',
)

engine = replace_once(
    engine,
    "export const MATCHER_VERSION = '4.1.2'",
    "export const MATCHER_VERSION = '4.2.0'",
    'matcher version',
)

engine = replace_once(
    engine,
    "  // at most ONE coverage point (bounded), so it refines the ratio without\n"
    "  // recreating the old additive boost stack.\n"
    "  const fitEvidenceCredit = hasFitEvidence ? Math.min(1, fitEvidencePoints / 12) : 0\n",
    "  // at most HALF of one coverage point (the documented contract), so it\n"
    "  // refines the ratio without allowing stacked bonuses to substitute for\n"
    "  // the profile's actual funding purpose.\n"
    "  const fitEvidenceCredit = hasFitEvidence\n"
    "    ? Math.min(FIT_EVIDENCE_HALF_CREDIT, (fitEvidencePoints / 12) * FIT_EVIDENCE_HALF_CREDIT)\n"
    "    : 0\n",
    'fit-evidence credit bound',
)

engine = replace_once(
    engine,
    "  // ── Floor guarantee: validated opportunities always score ≥ SCORE_FLOOR ──\n"
    "  const finalScore = Math.max(SCORE_FLOOR, Math.min(100, Math.round(anchoredScore)))\n",
    "  // NEED-FIRST POLICY: eligibility, geography, and peripheral traits can\n"
    "  // refine a real match, but they can never substitute for addressing a\n"
    "  // declared need, institution, profession, program, or other direct funding\n"
    "  // purpose. Resources remain reachable separately as REVIEW.\n"
    "  const needFirstPolicy = evaluateNeedFirstMatchPolicy({\n"
    "    profileContext: profileContext ?? {\n"
    "      profile: effectiveProfile,\n"
    "      sections: {},\n"
    "      signals: effectiveSignals,\n"
    "    },\n"
    "    profileNorm,\n"
    "    opportunity: effectiveOpp,\n"
    "    oppNorm,\n"
    "    dataPointEval,\n"
    "    matchedNeeds: [...matchedNeedSet],\n"
    "  })\n"
    "  if (Number.isFinite(Number(needFirstPolicy.scoreCap))) {\n"
    "    anchoredScore = Math.min(anchoredScore, Number(needFirstPolicy.scoreCap))\n"
    "  }\n"
    "  if (needFirstPolicy.reasons.length > 0) reasons.push(...needFirstPolicy.reasons)\n"
    "\n"
    "  // ── Floor guarantee: validated opportunities always score ≥ SCORE_FLOOR ──\n"
    "  const finalScore = Math.max(SCORE_FLOOR, Math.min(100, Math.round(anchoredScore)))\n",
    'need-first score cap',
)

engine = replace_once(
    engine,
    "  const match_explain = {\n"
    "    matchedNeeds: matchedNeeds.length > 0 ? matchedNeeds : undefined,\n",
    "  const match_explain = {\n"
    "    matchedNeeds: matchedNeeds.length > 0 ? matchedNeeds : undefined,\n"
    "    needFirstPolicy,\n",
    'need-first explanation payload',
)

engine = replace_once(
    engine,
    "      scoring_model: SCORING_MODEL,\n",
    "      scoring_model: SCORING_MODEL,\n"
    "      scoring_policy_version: MATCHER_VERSION,\n"
    "      need_first_purpose_anchor: needFirstPolicy.purposeAnchor,\n"
    "      need_first_decision: needFirstPolicy.decision,\n"
    "      need_first_score_cap: needFirstPolicy.scoreCap,\n"
    "      need_first_hard_mismatch: needFirstPolicy.hardMismatch,\n",
    'need-first score breakdown',
)

engine = replace_once(
    engine,
    "  // Decision via makeDecision — pass normalizedProfile so section-derived flags are used\n"
    "  let { decision, explanation, reasons: decisionReasons } = makeDecision(finalScore, rawProfile, rawOpportunity, profileNorm, signalsForScoring ?? signals, oppNorm)\n",
    "  // Decision via makeDecision — pass normalizedProfile so section-derived flags are used\n"
    "  let { decision, explanation, reasons: decisionReasons } = makeDecision(finalScore, rawProfile, rawOpportunity, profileNorm, signalsForScoring ?? signals, oppNorm)\n"
    "  const needFirstDecision = enforceNeedFirstDecision({\n"
    "    decision,\n"
    "    explanation,\n"
    "    reasons: decisionReasons,\n"
    "  }, match_explain?.needFirstPolicy)\n"
    "  decision = needFirstDecision.decision\n"
    "  explanation = needFirstDecision.explanation\n"
    "  decisionReasons = needFirstDecision.reasons\n",
    'need-first decision enforcement',
)

engine_path.write_text(engine, encoding='utf-8')

policy_path = Path('backend/services/matching/needFirstMatchPolicy.js')
policy = policy_path.read_text(encoding='utf-8')
policy = policy.replace("  const normalizedOppText = normalizeText(text)\n", '')
policy = policy.replace("      profile_text_excerpt: normalizedOppText ? undefined : undefined,\n", '')
policy_path.write_text(policy, encoding='utf-8')

print('need-first scoring patch applied')
