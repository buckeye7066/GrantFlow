import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const write = (rel, text) => fs.writeFileSync(path.join(root, rel), text)

function replaceExact(rel, before, after) {
  const source = read(rel)
  if (!source.includes(before)) {
    throw new Error(`${rel}: exact replacement anchor not found:\n${before.slice(0, 240)}`)
  }
  write(rel, source.replace(before, after))
}

function replaceRegex(rel, regex, after) {
  const source = read(rel)
  if (!regex.test(source)) throw new Error(`${rel}: regex replacement anchor not found: ${regex}`)
  regex.lastIndex = 0
  write(rel, source.replace(regex, after))
}

function removeExact(rel, text) {
  replaceExact(rel, text, '')
}

// ---------------------------------------------------------------------------
// 1. Live web lane: page facts only, never profile-stamped opportunity facts.
// ---------------------------------------------------------------------------
const webLane = 'backend/crawler-os/webLane.js'
replaceRegex(
  webLane,
  /function numOrNull\(v\) \{[\s\S]*?\n\}\n\n\/\*\*\n \* pickTargetUrl/,
  `function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function firstHttps(...urls) {
  for (const u of urls) {
    const s = String(u || '').trim();
    if (/^https:\/\//i.test(s)) return s;
  }
  return null;
}

function cleanStringArray(value, max = 12) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/\\s+/g, ' ').trim();
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function cleanState(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Map one PAGE-DERIVED extraction to the OS candidate contract. */
function toCandidate(ex, evidence, _thesis, page) {
  if (!ex || typeof ex !== 'object') return null;

  // The live extractor now returns the profile-blind mapper's canonical
  // candidate. Preserve it byte-for-byte except for run provenance. Most
  // importantly, do not overwrite its empty/unknown applicant and geo facts
  // with the searching profile's answers.
  if (ex.raw?.blind_extraction === true) {
    return {
      ...ex,
      source_id: WEB_SOURCE.source_id,
      raw: {
        ...(ex.raw || {}),
        query: page.query,
        page_url: ex.raw?.page_url ?? evidence.url,
      },
    };
  }

  // Compatibility path for injected tests or older source-specific extractors.
  // It remains page-only: categorical facts come from `ex`, never `thesis`.
  const sponsor = String(ex.funder || ex.sponsor || '').trim();
  const title = String(ex.title || '').trim();
  if (!sponsor || sponsor.length < 2 || !title) return null;

  const isRolling = String(ex.deadline || '').toLowerCase() === 'rolling' || ex.is_rolling === true;
  const deadline = !isRolling && /^\\d{4}-\\d{2}-\\d{2}/.test(String(ex.deadline || ''))
    ? String(ex.deadline).slice(0, 10)
    : null;
  const explicitKind = Object.values(OPPORTUNITY_KIND).includes(ex.kind) ? ex.kind : null;
  const kind = explicitKind ?? (isRolling ? OPPORTUNITY_KIND.PROGRAM : OPPORTUNITY_KIND.DIRECT_GRANT);
  const national = ex.national === true || ex.geography?.national === true;
  const statedStates = Array.isArray(ex.geography?.states)
    ? ex.geography.states
    : (Array.isArray(ex.states) ? ex.states : [ex.state]);
  const states = national
    ? []
    : cleanStringArray(statedStates, 25).map(cleanState).filter(Boolean);
  const applyUrl = kind === OPPORTUNITY_KIND.DIRECTORY ? null : firstHttps(ex.apply_url);
  const infoUrl = firstHttps(ex.info_url, evidence.url, page.url);

  return {
    external_id: null,
    source_id: WEB_SOURCE.source_id,
    kind,
    title,
    sponsor,
    summary: (String(ex.summary || ex.eligibility || ex.eligibility_text || '').replace(/\\s+/g, ' ').trim() || null)?.slice(0, 800) ?? null,
    deadline,
    is_rolling: isRolling,
    apply_url: applyUrl,
    info_url: infoUrl,
    applicant_types: [],
    need_categories: cleanStringArray(ex.need_categories, 12),
    geography: { national, states },
    amount_min: numOrNull(ex.amount_min),
    amount_max: numOrNull(ex.amount_max),
    is_loan: ex.is_loan === true,
    requires_cost_share: ex.requires_cost_share === true || ex.requires_match === true,
    eligibility_text: typeof ex.eligibility_text === 'string' ? ex.eligibility_text : null,
    eligibility_bullets: cleanStringArray(ex.eligibility_bullets, 20),
    page_fact_schema_version: ex.page_fact_schema_version ?? null,
    field_provenance: ex.field_provenance ?? null,
    raw: { extracted: ex, query: page.query, page_url: evidence.url },
  };
}

/**
 * pickTargetUrl`,
)
replaceExact(
  webLane,
  'extractOpportunities({ pageUrl: evidence.url, html: resp.body, thesis, query: page.query })',
  'extractOpportunities({ pageUrl: evidence.url, html: resp.body })',
)

// ---------------------------------------------------------------------------
// 2. Page-fact extractor: deadline is a first-class evidence-backed fact.
// ---------------------------------------------------------------------------
const blindExtractor = 'backend/crawler-os/blindPageFactExtractor.js'
replaceExact(blindExtractor, "export const EXTRACTOR_VERSION = 'blind-v1';", "export const EXTRACTOR_VERSION = 'blind-v2';")
replaceExact(blindExtractor, "export const PROMPT_VERSION = 'blind-prompt-v1';", "export const PROMPT_VERSION = 'blind-prompt-v2';")
replaceExact(blindExtractor, 'export const PAGE_FACT_SCHEMA_VERSION = 1;', 'export const PAGE_FACT_SCHEMA_VERSION = 2;')
replaceExact(
  blindExtractor,
  'export const MAX_SUMMARY_CHARS = 800;\nexport const MAX_ELIGIBILITY_CHARS = 4000;',
  'export const MAX_SUMMARY_CHARS = 800;\nexport const MAX_DEADLINE_CHARS = 40;\nexport const MAX_ELIGIBILITY_CHARS = 4000;',
)
replaceExact(
  blindExtractor,
  `function boolOrNull(v) {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}
`,
  `function boolOrNull(v) {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function cleanDeadline(v) {
  if (typeof v !== 'string') return null;
  const text = v.trim().toLowerCase();
  if (text === 'rolling' || text === 'ongoing') return 'rolling';
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(text);
  if (!match) return null;
  const date = new Date(\`${'${match[1]}-${match[2]}-${match[3]}'}T00:00:00Z\`);
  return Number.isNaN(date.getTime()) ? null : text;
}
`,
)
replaceExact(
  blindExtractor,
  `  const requires_cost_share = boolOrNull(rawOpp.requires_cost_share);
  const need_categories = cleanNeeds(rawOpp.need_categories, hayNorm);
`,
  `  const requires_cost_share = boolOrNull(rawOpp.requires_cost_share);
  const normalizedDeadline = cleanDeadline(rawOpp.deadline);
  const is_rolling = normalizedDeadline === 'rolling' || rawOpp.is_rolling === true;
  const deadline = is_rolling ? null : normalizedDeadline;
  const need_categories = cleanNeeds(rawOpp.need_categories, hayNorm);
`,
)
replaceExact(
  blindExtractor,
  `  addProvenance(field_provenance, 'requires_cost_share', requires_cost_share, ev.requires_cost_share, pageUrlCanon);
  addProvenance(field_provenance, 'national', national, ev.national, pageUrlCanon);
`,
  `  addProvenance(field_provenance, 'requires_cost_share', requires_cost_share, ev.requires_cost_share, pageUrlCanon);
  if (deadline || is_rolling) {
    addProvenance(field_provenance, 'deadline', is_rolling ? 'rolling' : deadline, ev.deadline, pageUrlCanon);
  }
  addProvenance(field_provenance, 'national', national, ev.national, pageUrlCanon);
`,
)
replaceExact(
  blindExtractor,
  `    summary: str(rawOpp.summary, MAX_SUMMARY_CHARS) || null,
    eligibility_text,
`,
  `    summary: str(rawOpp.summary, MAX_SUMMARY_CHARS) || null,
    deadline,
    is_rolling,
    eligibility_text,
`,
)
replaceExact(
  blindExtractor,
  `      '  "amount_min": number|null, "amount_max": number|null,',
      '  "national": boolean|null, "states": string[],',
`,
  `      '  "amount_min": number|null, "amount_max": number|null,',
      '  "deadline": "YYYY-MM-DD"|"rolling"|null,',
      '  "national": boolean|null, "states": string[],',
`,
)
replaceExact(
  blindExtractor,
  `      '  "evidence": { "eligibility": string, "amount": string, "is_loan": string, "requires_cost_share": string, "national": string, "geography": string }',
`,
  `      '  "evidence": { "eligibility": string, "amount": string, "deadline": string, "is_loan": string, "requires_cost_share": string, "national": string, "geography": string }',
`,
)

const evidenceValidator = 'backend/crawler-os/blindEvidenceValidator.js'
replaceExact(
  evidenceValidator,
  `  {
    key: 'amount',
`,
  `  {
    key: 'deadline',
    isSet: (f) => (typeof f.deadline === 'string' && f.deadline.trim() !== '') || f.is_rolling === true,
    neutralize: (f) => { f.deadline = null; f.is_rolling = false; },
  },
  {
    key: 'amount',
`,
)

const normalizer = 'backend/crawler-os/normalizer.js'
replaceExact(
  normalizer,
  `    evidence: {
      url: evidence.url ?? candidate.apply_url ?? candidate.info_url ?? null,
      content_hash: evidence.content_hash ?? null,
      fetched_at: evidence.fetched_at ?? null,
    },
    raw: candidate.raw ?? null,
`,
  `    evidence: {
      url: evidence.url ?? candidate.apply_url ?? candidate.info_url ?? null,
      content_hash: evidence.content_hash ?? null,
      fetched_at: evidence.fetched_at ?? null,
    },
    eligibility_text: candidate.eligibility_text ?? null,
    eligibility_bullets: candidate.eligibility_bullets ?? [],
    page_fact_schema_version: candidate.page_fact_schema_version ?? null,
    field_provenance: candidate.field_provenance ?? null,
    raw: candidate.raw ?? null,
`,
)

// ---------------------------------------------------------------------------
// 3. Display funnel: persisted canonical decision is authoritative by default.
// ---------------------------------------------------------------------------
const resultEnricher = 'backend/services/matching/resultEnricher.js'
replaceExact(
  resultEnricher,
  `  } = opts

  if (!opportunity || typeof opportunity !== 'object') {
`,
  `  } = opts

  // A stored profile↔opportunity decision is the canonical adjudication. Display
  // code may explicitly opt out for unscored/raw leads, but omission must never
  // trigger a second eligibility trial or score rewrite.
  const useStoredDecision = opts.useStoredDecision !== false

  if (!opportunity || typeof opportunity !== 'object') {
`,
)
replaceExact(resultEnricher, '    useStoredDecision: opts.useStoredDecision === true,', '    useStoredDecision,')
replaceExact(resultEnricher, '    opts.useStoredDecision === true &&', '    useStoredDecision &&')
replaceExact(
  resultEnricher,
  `  const unsurfacedAboveFloorNoFit = []

  for (const opp of Array.isArray(opportunities) ? opportunities : []) {
`,
  `  const unsurfacedAboveFloorNoFit = []
  const sentinelOpts = { ...opts, useStoredDecision: opts.useStoredDecision !== false }

  for (const opp of Array.isArray(opportunities) ? opportunities : []) {
`,
)
replaceExact(resultEnricher, '        hasAuthoritativeStoredDecision(opp, opts)', '        hasAuthoritativeStoredDecision(opp, sentinelOpts)')

// ---------------------------------------------------------------------------
// 4. GET funding-sources is presentation-only. Reconciliation is background.
// ---------------------------------------------------------------------------
const fundingSources = 'backend/routes/fundingSources.js'
removeExact(fundingSources, "import { reconcileNeedFirstProfileMatches } from '../services/matching/needFirstReconciler.js'\n")
removeExact(fundingSources, '  ensurePipelineDismissalsSchema,\n')
replaceRegex(
  fundingSources,
  /\nfunction emptyReconciliation\(\) \{[\s\S]*?\n\}\n\n\/\*\*/,
  '\n/**',
)
replaceRegex(
  fundingSources,
  /\n    \/\/ The production audit deliberately performs SELECT-only comparison\.[\s\S]*?\n    const loadedRows = await readFundingSourceRows/,
  `
    // Every GET is SELECT-only presentation. Match write-back belongs to the
    // versioned background reconciliation/sweep path, never an ordinary read.
    const loadedRows = await readFundingSourceRows`,
)
replaceRegex(
  fundingSources,
  /      need_first_reconciliation: \{\n        scanned: reconciliation\.scanned,[\s\S]*?\n      \},/,
  `      need_first_reconciliation: {
        read_only: true,
        deferred_to_background: true,
        read_only_audit: readOnlyAudit,
      },`,
)
replaceExact(
  fundingSources,
  `      need_first_reconciliation: {
        read_only_audit: readOnlyAudit,
      },
`,
  `      need_first_reconciliation: {
        read_only: true,
        deferred_to_background: true,
        read_only_audit: readOnlyAudit,
      },
`,
)

// ---------------------------------------------------------------------------
// 5. Stop displaying a manufactured probability/percentage.
// ---------------------------------------------------------------------------
const thresholds = 'src/lib/matchDisplayThresholds.js'
replaceRegex(
  thresholds,
  /\/\*\*\n \* Instrumentl-style FIT PERCENTAGE[\s\S]*?\n\}\n\n\/\*\* Shared helper/,
  '/** Shared helper',
)

const fundingCard = 'src/components/funding/FundingResultCard.jsx'
replaceExact(
  fundingCard,
  "import { fitPercent, scoreToMatchLabel } from '@/lib/matchDisplayThresholds'",
  "import { scoreToMatchLabel } from '@/lib/matchDisplayThresholds'",
)
replaceRegex(
  fundingCard,
  /\{score !== null && \(\n          <div[\s\S]*?\n        \)\}\n      <\/header>/,
  `{score !== null && (
          <div
            className="text-right"
            data-testid="funding-result-card-score"
            aria-label={\`${'${scoreToMatchLabel(score)}; evidence score ${score}'}\`}
            title={\`${'${scoreToMatchLabel(score)} · evidence score ${score}'}\`}
          >
            <div className="text-sm font-semibold text-slate-900">{scoreToMatchLabel(score)}</div>
            <div className="text-xs text-slate-500">
              evidence score {score}{confidence !== null ? \` · ${'${confidence}'}% conf\` : ''}
            </div>
          </div>
        )}
      </header>`,
)

const fundingCardTest = 'src/components/funding/FundingResultCard.test.jsx'
replaceRegex(
  fundingCardTest,
  /  it\('shows the fit percentage and confidence',[\s\S]*?\n  \}\)\n\n  it\('shows "why this matched"/,
  `  it('shows the match tier and underlying evidence score without manufacturing a percentage', () => {
    render(<FundingResultCard result={{ ...BASE, kind: 'direct', link_status: 'verified' }} />)
    const scoreEl = screen.getByTestId('funding-result-card-score')
    expect(scoreEl.textContent).toContain('Excellent Match')
    expect(scoreEl.textContent).toContain('evidence score 78')
    expect(scoreEl.textContent).toContain('80% conf')
    expect(scoreEl.textContent).not.toContain('99%')
    expect(scoreEl.getAttribute('aria-label')).toContain('evidence score 78')
  })

  it('shows "why this matched"`,
)

const anyaAlerts = 'src/components/anya/AnyaMatchScoutAlerts.jsx'
replaceExact(anyaAlerts, "import { fitPercent } from '@/lib/matchDisplayThresholds'", "import { scoreToMatchLabel } from '@/lib/matchDisplayThresholds'")
replaceExact(
  anyaAlerts,
  `  const score = fitPercent(suggestion.match_score)
  const title = suggestion.title || 'a funding opportunity'
`,
  `  const rawScore = Number(suggestion.match_score)
  const hasScore = Number.isFinite(rawScore)
  const matchLabel = hasScore ? scoreToMatchLabel(rawScore) : 'Potential Match'
  const title = suggestion.title || 'a funding opportunity'
`,
)
replaceExact(
  anyaAlerts,
  '    description: `${title} looks like a ${score}% fit for ${profileLabel}. Want to add it to the pipeline?`,',
  '    description: `${title} is a ${matchLabel} for ${profileLabel}${hasScore ? ` (evidence score ${Math.round(rawScore)})` : ""}. Want to add it to the pipeline?`,',
)

const foundationSearch = 'src/pages/FoundationSearch.jsx'
replaceExact(foundationSearch, 'import { scoreToMatchTier, fitPercent } from "@/lib/matchDisplayThresholds"', 'import { scoreToMatchTier } from "@/lib/matchDisplayThresholds"')
replaceExact(foundationSearch, '        Add{hasScore(score) ? ` · ${fitPercent(score)}%` : ""}', '        Add{hasScore(score) ? ` · score ${Math.round(Number(score))}` : ""}')

const geoView = 'src/components/funding/GeoFundingView.jsx'
replaceExact(geoView, 'import { scoreToMatchTier, fitPercent } from "@/lib/matchDisplayThresholds"', 'import { scoreToMatchTier, scoreToMatchLabel } from "@/lib/matchDisplayThresholds"')
replaceExact(geoView, '      {fitPercent(score)}%', '      {scoreToMatchLabel(score).replace(" Match", "")} · {score}')

const fundingOpportunities = 'src/pages/FundingOpportunities.jsx'
replaceExact(
  fundingOpportunities,
  'import { scoreToMatchTier, MIN_SCORE_SLIDER_MAX, fitPercent } from "@/lib/matchDisplayThresholds"',
  'import { scoreToMatchTier, scoreToMatchLabel, MIN_SCORE_SLIDER_MAX } from "@/lib/matchDisplayThresholds"',
)
replaceExact(
  fundingOpportunities,
  '    lines.push(`Match fit: ${fitPercent(match.score)}%`)',
  '    lines.push(`Match tier: ${scoreToMatchLabel(match.score)} (evidence score ${Math.round(match.score)})`)',
)

const robertModal = 'src/components/robert/RobertRecommendationDetailsModal.jsx'
replaceExact(robertModal, "import { fitPercent } from '@/lib/matchDisplayThresholds'", "import { scoreToMatchLabel } from '@/lib/matchDisplayThresholds'")
replaceExact(
  robertModal,
  `  const score = fitPercent(recommendation.match_score)
  const decision = String(recommendation.match_decision || '').toUpperCase()
`,
  `  const rawScore = Number(recommendation.match_score)
  const hasScore = Number.isFinite(rawScore)
  const matchLabel = hasScore ? scoreToMatchLabel(rawScore) : null
  const decision = String(recommendation.match_decision || '').toUpperCase()
`,
)
replaceExact(
  robertModal,
  '            {score > 0 && <Badge variant="outline">{score}% match</Badge>}',
  '            {matchLabel && <Badge variant="outline">{matchLabel} · score {Math.round(rawScore)}</Badge>}',
)

const thresholdTest = 'src/lib/__tests__/matchDisplayThresholds.test.js'
removeExact(thresholdTest, '  fitPercent,\n')
replaceRegex(
  thresholdTest,
  /\ndescribe\("fitPercent \(Instrumentl-style user-facing fit gauge\)"[\s\S]*?\n\}\)\n\ndescribe\("translateLegacyMinScore/,
  '\n\ndescribe("translateLegacyMinScore',
)

// The synthetic fit gauge must be gone from all shipped frontend source.
function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}
const remainingFitPercent = walk(path.join(root, 'src'))
  .filter((file) => fs.readFileSync(file, 'utf8').includes('fitPercent'))
if (remainingFitPercent.length) {
  throw new Error(`fitPercent remains in shipped source:\n${remainingFitPercent.join('\n')}`)
}

// Remove temporary self-applying machinery from the final product commit.
for (const rel of [
  'scripts/agent/apply-funding-truth-pipeline.mjs',
  '.github/workflows/agent-funding-truth-apply.yml',
]) {
  const full = path.join(root, rel)
  if (fs.existsSync(full)) fs.unlinkSync(full)
}

console.log('Funding-truth pipeline patches applied successfully.')
