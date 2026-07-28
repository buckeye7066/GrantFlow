from pathlib import Path
import runpy


# Apply the original audited patch first, then refine the two issues exposed by
# the first real regression run.
runpy.run_path('scripts/agent-apply-audit-corrections.py', run_name='__main__')


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected exactly one replacement target, found {count}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')
    print(f'refined {path}')


# computeMatchDecision has rawOpportunity/oppNorm in scope; effectiveOpp belongs
# to scoreOpportunity and was correctly rejected by the focused test.
replace_once(
    'backend/services/matchEngine.js',
    """  const opportunityKind = String(\n    effectiveOpp?.opportunity_kind ??\n    rawOpportunity?.opportunity_kind ??\n    rawOpportunity?.opportunity_type ??""",
    """  const opportunityKind = String(\n    rawOpportunity?.opportunity_kind ??\n    rawOpportunity?.opportunity_type ??""",
)


# The existing Amy tuner fixtures still spoke the retired 75-80 scale. Keep the
# same behavioral proof, but express it on the live data-point scale: a real 12
# plus a generic-only ACCEPT at 11, with the floor rising from 8 to 12.
replace_once(
    'backend/tests/amyAgent.test.js',
    "import { ACCEPT_SCORE, DISCOVERY_MIN_SCORE_FLOOR } from '../config/matchThresholds.js'",
    "import { ACCEPT_SCORE, DISCOVERY_MIN_SCORE_FLOOR, REVIEW_SCORE } from '../config/matchThresholds.js'",
)

replace_once(
    'backend/tests/amyAgent.test.js',
    """  const candidates = scores.map((s, i) => ({\n    score: s,\n    decision: s >= 70 ? 'ACCEPT' : s >= 35 ? 'REVIEW' : 'REJECT',\n    title: generics[i] ? 'Resource Directory' : 'Specific Grant',\n    generic: Boolean(generics[i]),\n  }))\n  const false_positives = candidates.filter((c) => c.generic && (c.decision === 'ACCEPT' || c.score >= 70)).length""",
    """  const candidates = scores.map((s, i) => ({\n    score: s,\n    decision: s >= ACCEPT_SCORE ? 'ACCEPT' : s >= REVIEW_SCORE ? 'REVIEW' : 'REJECT',\n    title: generics[i] ? 'Resource Directory' : 'Specific Grant',\n    generic: Boolean(generics[i]),\n    genericOnly: Boolean(generics[i]),\n    locator: false,\n  }))\n  const false_positives = candidates.filter(\n    (c) => c.genericOnly && !c.locator && c.decision === 'ACCEPT',\n  ).length""",
)

replace_once(
    'backend/tests/amyAgent.test.js',
    """    // Every profile has a real 82 match plus a generic/directory 78 accepted as\n    // strong — raising the floor to 80 keeps coverage and removes the junk.\n    const evals = Array.from({ length: 16 }, () => evalFix({ scores: [82, 78], generics: [false, true] }))\n    const current = cohortMetricsAtFloor(evals, 75)\n    const { best } = sweepFloors(evals)\n    const decision = decideFloorChange({ currentFloor: 75, best, currentMetrics: current })\n    expect(decision.change).toBe(true)\n    expect(decision.to).toBe(80)""",
    """    // Every profile has a real 12 match plus a generic-only 11 ACCEPT.\n    // Raising the data-point floor from 8 to 12 keeps coverage and removes junk.\n    const evals = Array.from({ length: 16 }, () => evalFix({ scores: [12, 11], generics: [false, true] }))\n    const current = cohortMetricsAtFloor(evals, DISCOVERY_MIN_SCORE_FLOOR)\n    const { best } = sweepFloors(evals)\n    const decision = decideFloorChange({\n      currentFloor: DISCOVERY_MIN_SCORE_FLOOR,\n      best,\n      currentMetrics: current,\n    })\n    expect(decision.change).toBe(true)\n    expect(decision.to).toBe(12)""",
)

replace_once(
    'backend/tests/amyAgent.test.js',
    """    // Every profile finds a real 82 match plus a generic/directory 78 accepted\n    // as strong — the cohort PROVES raising the floor to 80 cuts the junk\n    // without losing coverage (the only direction the safety bound allows).""",
    """    // Every profile finds a real 12 match plus a generic-only 11 ACCEPT.\n    // The cohort proves raising the live data-point floor from 8 to 12 cuts the\n    // junk without losing direct-funding coverage.""",
)

replace_once(
    'backend/tests/amyAgent.test.js',
    """            { title: 'Specific Grant', match_score: 82, decision: 'ACCEPT' },\n            { title: 'Resource Directory', match_score: 78, decision: 'ACCEPT' },""",
    """            { title: 'Specific Grant', match_score: 12, decision: 'ACCEPT' },\n            { title: 'Resource Directory', match_score: 11, decision: 'ACCEPT' },""",
)

replace_once(
    'backend/tests/amyAgent.test.js',
    "const editorState = { value: 75 }",
    "const editorState = { value: DISCOVERY_MIN_SCORE_FLOOR }",
)

replace_once(
    'backend/tests/amyAgent.test.js',
    """      expect(editorState.value).toBe(80)\n      expect(pipelineCalled).toBe(true)\n      expect(out.combined.chain.sam.run_id).toBe('sam-9')\n      expect(out.combined.metrics.before).toBeTruthy()\n      expect(out.combined.metrics.best.floor).toBe(80)""",
    """      expect(editorState.value).toBe(12)\n      expect(pipelineCalled).toBe(true)\n      expect(out.combined.chain.sam.run_id).toBe('sam-9')\n      expect(out.combined.metrics.before).toBeTruthy()\n      expect(out.combined.metrics.best.floor).toBe(12)""",
)

print('v2 refinements staged')
