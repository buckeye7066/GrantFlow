import React, { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/api/client';
import { listProfiles } from '@/api/profiles';
import { createPageUrl } from '@/utils';
import { scoreToMatchTier } from '@/lib/matchDisplayThresholds';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Radar,
  AlertTriangle,
  CheckCircle2,
  Clock,
  DollarSign,
  ExternalLink,
  HelpCircle,
  ListChecks,
  Loader2,
  ShieldCheck,
  Sparkles,
  Target,
  XCircle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

/**
 * CoverageEvidence — per-profile "Coverage & Evidence" dashboard (owner
 * directive). Four panels answering four questions so bad recommendations
 * become diagnosable failure classes:
 *   1. WHAT DID WE SEARCH — the 9 source lanes with searched/no-results/missing badges
 *   2. WHAT DID WE MISS   — concrete gap statements per lane / profile fact
 *   3. WHY DID EACH MATCH SURVIVE — per-match evidence from match_explain
 *   4. WHAT SHOULD THE USER ANSWER NEXT — prioritized missing fields/questions
 *
 * Plus two owner-directed card sections, both fully clickable:
 *   - "Almost qualifies for" — the `near` slice of GET /api/ai/threshold-report
 *     (thresholdAnalyzer.js) with the exact gap and what closes it.
 *   - "Similar funding sources you might qualify for" — merged, deduped
 *     GET /api/opportunities/:id/similar for the profile's top scored matches.
 *
 * Data: GET /api/profiles/:id/coverage-evidence (coverageEvidenceService.js).
 */
export default function CoverageEvidence() {
  const [searchParams, setSearchParams] = useSearchParams();
  const profileId = searchParams.get('profile_id') || searchParams.get('id') || '';

  const { data: profiles = [] } = useQuery({
    queryKey: ['profiles', 'coverage-evidence-picker'],
    queryFn: () => listProfiles({ summary: true }),
    refetchOnWindowFocus: false,
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['coverage-evidence', profileId],
    queryFn: () => apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/coverage-evidence`),
    enabled: Boolean(profileId),
    refetchOnWindowFocus: false,
  });

  const sortedProfiles = useMemo(
    () => [...profiles].sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || ''))),
    [profiles],
  );

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900">
            <Radar className="h-6 w-6 text-indigo-600" />
            Coverage &amp; Evidence
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            What we searched, what we missed, why each match survived, and what to answer next.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          Profile
          <select
            value={profileId}
            onChange={(e) => setSearchParams(e.target.value ? { profile_id: e.target.value } : {})}
            className="w-64 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">Select a profile…</option>
            {sortedProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name || p.id}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!profileId ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-10 text-sm text-slate-500">
            <HelpCircle className="h-4 w-4" /> Pick a profile to see its coverage and match evidence.
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Building coverage &amp; evidence…
        </div>
      ) : isError ? (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-center gap-2 py-6 text-red-700">
            <XCircle className="h-5 w-5" />
            Failed to load coverage: {error?.message || 'unknown error'}
          </CardContent>
        </Card>
      ) : data ? (
        <>
          <ProfileSummary data={data} />
          <LanesPanel lanes={data.lanes || []} />
          <GapsPanel gaps={data.gaps || []} profileId={profileId} />
          <MatchesPanel matches={data.matches || []} />
          <AlmostQualifiesPanel profileId={profileId} />
          <SimilarSourcesPanel matches={data.matches || []} />
          <AnswerNextPanel items={data.answer_next || []} profileId={profileId} />
        </>
      ) : null}
    </div>
  );
}

function ProfileSummary({ data }) {
  const plan = data.plan || {};
  const loc = plan.location || {};
  const place = [loc.city, loc.county, loc.state].filter(Boolean).join(', ') || 'no location on file';
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
      <span className="font-semibold text-slate-900">{data.display_name || data.profile_id}</span>
      <Chip>{data.primary_type || 'unknown type'}</Chip>
      <Chip>{place}</Chip>
      {(plan.applicant_types || []).slice(0, 4).map((t) => (
        <Chip key={t} tone="indigo">{t}</Chip>
      ))}
      {(plan.needs || []).slice(0, 6).map((n) => (
        <Chip key={n} tone="slate">need: {n}</Chip>
      ))}
      {Number.isFinite(Number(plan.readiness_score)) && (
        <Chip tone={plan.readiness_score >= 65 ? 'emerald' : 'amber'}>readiness {plan.readiness_score}</Chip>
      )}
    </div>
  );
}

const CHIP_TONES = {
  slate: 'bg-slate-100 text-slate-700',
  indigo: 'bg-indigo-50 text-indigo-700',
  emerald: 'bg-emerald-100 text-emerald-800',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800',
};

function Chip({ children, tone = 'slate', title }) {
  return (
    <span title={title} className={`rounded-full px-2 py-0.5 text-xs font-medium ${CHIP_TONES[tone] || CHIP_TONES.slate}`}>
      {children}
    </span>
  );
}

const LANE_STATUS = {
  searched: { label: 'Searched — has matches', tone: 'border-emerald-300 bg-emerald-50', chip: 'emerald' },
  no_results: { label: 'Searched — no current match', tone: 'border-amber-300 bg-amber-50', chip: 'amber' },
  missing: { label: 'Not covered', tone: 'border-red-300 bg-red-50', chip: 'red' },
};

// ── 1. WHAT DID WE SEARCH ────────────────────────────────────────────────────
function LanesPanel({ lanes }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Radar className="h-4 w-4 text-indigo-600" /> 1. What did we search
        </CardTitle>
        <CardDescription>
          The 9 source lanes: green = searched with matches, amber = searched but no current match,
          red = not covered for this profile.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {lanes.map((lane) => {
            const st = LANE_STATUS[lane.status] || LANE_STATUS.missing;
            return (
              <div key={lane.lane} className={`rounded-lg border p-3 ${st.tone}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-800">{lane.label}</span>
                  <Chip tone={st.chip}>{st.label}</Chip>
                </div>
                {lane.selected_sources?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {lane.selected_sources.map((s) => (
                      <Chip
                        key={s.source_id}
                        tone={s.with_results ? 'emerald' : 'slate'}
                        title={s.with_results ? 'Has current matches' : 'Checked — no current match'}
                      >
                        {s.name}
                      </Chip>
                    ))}
                  </div>
                )}
                {lane.status === 'missing' && lane.gap && (
                  <p className="mt-2 text-xs text-red-700">{lane.gap}</p>
                )}
                {lane.excluded_sources?.length > 0 && (
                  <ExcludedSourcesDisclosure sources={lane.excluded_sources} />
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ExcludedSourcesDisclosure({ sources }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {sources.length} source{sources.length === 1 ? '' : 's'} not searched — why
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
          {sources.map((s) => (
            <li key={s.source_id}>
              <span className="font-medium text-slate-600">{s.name}</span>
              {s.reasons?.length ? ` — ${s.reasons.join('; ')}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 2. WHAT DID WE MISS ──────────────────────────────────────────────────────
function GapsPanel({ gaps, profileId }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-500" /> 2. What did we miss
        </CardTitle>
        <CardDescription>
          Concrete coverage gaps for this profile — each one is a diagnosable failure class, not a
          vague &quot;no results&quot;.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {gaps.length === 0 ? (
          <div className="flex items-center gap-2 py-2 text-sm text-slate-500">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" /> No coverage gaps detected for this profile.
          </div>
        ) : (
          gaps.map((g, i) => {
            // A gap whose fix lives on the PROFILE (add a need/fact) links to
            // the profile editor; registry-level gaps (new source adapter) are
            // owner work with no in-app target, so they stay plain.
            const action = String(g.suggested_action || '');
            const profileActionable = /profile/i.test(action) && !/sourceRegistry/i.test(action);
            const body = (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {g.lane && <Chip tone="red">{g.lane.replace(/_/g, ' ')}</Chip>}
                  <span className="text-sm font-medium text-slate-800">{g.statement}</span>
                </div>
                <div className="mt-1 text-xs text-slate-600">
                  {g.profile_fact && <span className="mr-3 font-mono">{g.profile_fact}</span>}
                  {g.suggested_action}
                  {profileActionable && (
                    <span className="ml-2 font-medium text-indigo-600">Open profile →</span>
                  )}
                </div>
              </>
            );
            return profileActionable && profileId ? (
              <Link
                key={`${g.lane || 'general'}-${i}`}
                to={createPageUrl('ProfileDetail', { id: profileId })}
                className="block rounded-md border border-amber-200 bg-amber-50 px-3 py-2 transition hover:border-indigo-300 hover:bg-indigo-50"
              >
                {body}
              </Link>
            ) : (
              <div key={`${g.lane || 'general'}-${i}`} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                {body}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

// ── 3. WHY DID EACH MATCH SURVIVE ────────────────────────────────────────────
function MatchesPanel({ matches }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-emerald-600" /> 3. Why did each match survive
        </CardTitle>
        <CardDescription>
          Per-match evidence: the profile facts, eligibility, geography, deadline, amount, and source
          trust behind every stored match ({matches.length} shown, top {matches.length < 200 ? matches.length : 200} by score).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {matches.length === 0 ? (
          <div className="py-2 text-sm text-slate-500">
            No stored matches for this profile yet — run discovery first.
          </div>
        ) : (
          matches.map((m) => <MatchRow key={m.id} match={m} />)
        )}
      </CardContent>
    </Card>
  );
}

function MatchRow({ match }) {
  const [open, setOpen] = useState(false);
  const ev = match.evidence || {};
  // Tone bands come from the canonical scoreToMatchTier — never inline cutoffs.
  const scoreTier = scoreToMatchTier(match.score);
  const scoreTone = scoreTier === 'excellent' || scoreTier === 'good' ? 'emerald' : scoreTier === 'fair' || scoreTier === 'potential' ? 'amber' : 'slate';
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Hide match evidence' : 'Show match evidence'}
          className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <Link
          to={createPageUrl('GrantDetail', { id: match.id })}
          className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 hover:text-indigo-700 hover:underline"
          title="Open this grant"
        >
          {match.title}
        </Link>
        {match.sponsor && <span className="hidden truncate text-xs text-slate-500 md:inline">{match.sponsor}</span>}
        <Chip tone={scoreTone}>{match.score === null || match.score === undefined ? 'not scored' : `score ${Math.round(match.score)}`}</Chip>
        {match.decision && <Chip>{String(match.decision).toLowerCase()}</Chip>}
      </div>
      {open && (
        <div className="grid grid-cols-1 gap-3 border-t border-slate-100 px-4 py-3 text-xs text-slate-600 md:grid-cols-2 xl:grid-cols-3">
          <EvidenceCell label="Data points">
            {ev.data_points ? (
              <>
                <div>
                  {ev.data_points.matched_count}/{ev.data_points.total} profile data points matched
                  {Number.isFinite(Number(ev.data_points.credit)) ? ` (credit ${ev.data_points.credit})` : ''}
                </div>
                <ul className="mt-1 list-disc pl-4">
                  {(ev.data_points.matched || []).slice(0, 8).map((d, i) => (
                    <li key={d.id || i}>
                      {d.kind ? `${d.kind}: ` : ''}{String(d.value ?? d.id ?? '')}{d.via ? ` (via ${d.via})` : ''}
                    </li>
                  ))}
                </ul>
              </>
            ) : ev.matched_needs?.length ? (
              <div>Matched needs: {ev.matched_needs.join(', ')}{Number.isFinite(Number(ev.need_coverage)) ? ` — ${ev.need_coverage}% of main needs` : ''}</div>
            ) : (
              <span className="text-slate-400">No need-level evidence recorded.</span>
            )}
          </EvidenceCell>
          <EvidenceCell label="Applicant type">
            {ev.applicant_type?.matched ? 'Matches this applicant type' : 'Applicant-type match not confirmed'}
          </EvidenceCell>
          <EvidenceCell label="Geography">
            {ev.geography?.tier ? `Matched at ${ev.geography.tier} level` : 'No geo signal'}
            {ev.geography?.factor !== null && ev.geography?.factor !== undefined ? ` (factor ${ev.geography.factor})` : ''}
          </EvidenceCell>
          <EvidenceCell label="Eligibility">
            {ev.eligibility?.factor !== null && ev.eligibility?.factor !== undefined ? `Factor ${ev.eligibility.factor}. ` : ''}
            {ev.eligibility?.mismatches?.length ? `Mismatches: ${ev.eligibility.mismatches.join(', ')}. ` : ''}
            {ev.eligibility?.missing_fields?.length
              ? `Unverified: ${ev.eligibility.missing_fields.join(', ')}`
              : 'No unverified eligibility fields.'}
          </EvidenceCell>
          <EvidenceCell label="Deadline">
            {ev.deadline?.date || (ev.deadline?.type ? `${ev.deadline.type}` : 'unknown')}
          </EvidenceCell>
          <EvidenceCell label="Amount">
            {ev.amount?.max
              ? `$${Number(ev.amount.min || 0).toLocaleString()}–$${Number(ev.amount.max).toLocaleString()}`
              : ev.amount?.text || 'No amount listed'}
          </EvidenceCell>
          <EvidenceCell label="Apply link">
            {ev.apply_url ? (
              <a href={ev.apply_url} target="_blank" rel="noreferrer" className="text-indigo-600 underline break-all">
                {ev.apply_url}
              </a>
            ) : (
              <span className="text-red-600">No application URL</span>
            )}
          </EvidenceCell>
          <EvidenceCell label="Source & trust">
            {ev.source || 'unknown source'}
            {ev.trust_tier ? ` · tier: ${ev.trust_tier}` : ''}
            {ev.source_trust ? ` · trust: ${ev.source_trust}` : ''}
            {Number.isFinite(Number(ev.confidence)) ? ` · confidence ${ev.confidence}` : ''}
          </EvidenceCell>
          {ev.reasons?.length > 0 && (
            <EvidenceCell label="Engine reasons">
              <ul className="list-disc pl-4">
                {ev.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </EvidenceCell>
          )}
        </div>
      )}
    </div>
  );
}

function EvidenceCell({ label, children }) {
  return (
    <div>
      <div className="mb-0.5 font-semibold uppercase tracking-wide text-[10px] text-slate-400">{label}</div>
      <div>{children}</div>
    </div>
  );
}

// ── ALMOST QUALIFIES FOR (owner directive) ───────────────────────────────────
// The `near` slice of the canonical threshold report (thresholdAnalyzer.js via
// GET /api/ai/threshold-report): sources where one explicit number (ACT / SAT /
// GPA / income / age) stands between the profile and eligibility. The analysis
// is NOT re-implemented here — cards render the report verbatim.
function AlmostQualifiesPanel({ profileId }) {
  const { data } = useQuery({
    queryKey: ['threshold-report', profileId],
    queryFn: () => apiFetch(`/api/ai/threshold-report?profile_id=${encodeURIComponent(profileId)}`),
    enabled: Boolean(profileId),
    refetchOnWindowFocus: false,
    retry: false,
  });

  const near = Array.isArray(data?.near) ? data.near : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="h-4 w-4 text-amber-600" /> Almost qualifies for
        </CardTitle>
        <CardDescription>
          Sources where one number stands between this profile and eligibility — with the exact gap
          and what closes it. Update the profile fact and this list re-checks itself.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {near.length === 0 ? (
          <div className="flex items-center gap-2 py-2 text-sm text-slate-500">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            No near-miss thresholds right now
            {Number(data?.qualified?.length) > 0
              ? ` — and this profile already clears the stated thresholds on ${data.qualified.length} source${data.qualified.length === 1 ? '' : 's'}.`
              : '.'}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {near.map((item) => {
              const gaps = (item.requirements || []).filter((r) => r.status === 'near');
              const inner = (
                <>
                  <p className="mb-1 text-sm font-medium text-slate-900 line-clamp-2">{item.title}</p>
                  {gaps.map((r, i) => (
                    <div key={`${r.kind}-${i}`} className="mt-1">
                      <Chip tone="amber">needs {r.label} {r.need}, has {r.have}</Chip>
                      {r.advice && <p className="mt-1 text-xs text-slate-600 line-clamp-3">{r.advice}</p>}
                    </div>
                  ))}
                </>
              );
              const cardClass =
                'block rounded-lg border border-amber-200 bg-amber-50/60 p-4 transition hover:border-amber-400 hover:shadow-sm';
              if (item.grant_id) {
                return (
                  <Link key={item.grant_id} to={createPageUrl('GrantDetail', { id: item.grant_id })} className={cardClass}>
                    {inner}
                  </Link>
                );
              }
              if (item.link) {
                return (
                  <a key={item.title} href={item.link} target="_blank" rel="noreferrer" className={cardClass}>
                    {inner}
                    <span className="mt-1 inline-flex items-center gap-1 text-xs text-indigo-600">
                      <ExternalLink className="h-3 w-3" /> Open source page
                    </span>
                  </a>
                );
              }
              return (
                <div key={item.title} className={cardClass}>
                  {inner}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── SIMILAR FUNDING SOURCES (owner directive) ────────────────────────────────
// For the profile's top 3 scored matches, reuse GET /api/opportunities/:id/similar
// and render a merged, deduped card row — excluding anything already shown in
// the matches panel. Card layout mirrors GrantDetail's SimilarGrants sidebar.
function SimilarSourcesPanel({ matches }) {
  const topIds = useMemo(
    () => (matches || [])
      .filter((m) => m.id && /^[A-Za-z0-9_-]+$/.test(String(m.id)))
      .slice(0, 3)
      .map((m) => String(m.id)),
    [matches],
  );
  const knownIds = useMemo(() => new Set((matches || []).map((m) => String(m.id))), [matches]);

  const { data: similar = [] } = useQuery({
    queryKey: ['coverage-similar', topIds],
    queryFn: async () => {
      const results = await Promise.all(
        topIds.map((id) =>
          apiFetch(`/api/opportunities/${encodeURIComponent(id)}/similar`)
            .then((r) => (Array.isArray(r?.similar) ? r.similar : []))
            .catch(() => []),
        ),
      );
      const seen = new Set();
      const merged = [];
      for (const opp of results.flat()) {
        const id = String(opp?.id || '');
        if (!id || seen.has(id) || knownIds.has(id)) continue;
        seen.add(id);
        merged.push(opp);
      }
      return merged.slice(0, 9);
    },
    enabled: topIds.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (topIds.length === 0 || similar.length === 0) return null;

  const fmtAmount = (min, max) => {
    const f = (n) => (n >= 1000000 ? `$${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `$${(n / 1000).toFixed(0)}K` : `$${n}`);
    if (max && min) return `${f(min)}–${f(max)}`;
    if (max) return `Up to ${f(max)}`;
    if (min) return `From ${f(min)}`;
    return null;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-blue-500" /> Similar funding sources you might qualify for
        </CardTitle>
        <CardDescription>
          Related to this profile&apos;s top matches by sponsor, category, and keywords — not yet in
          the matches list above.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {similar.map((opp) => {
            const hasValidDeadline = opp.deadline && !Number.isNaN(Date.parse(opp.deadline));
            const amount = fmtAmount(opp.amount_min, opp.amount_max);
            return (
              <Link
                key={opp.id}
                to={createPageUrl('GrantDetail', { id: opp.id })}
                className="block rounded-lg border border-slate-200 bg-white p-4 transition-all hover:border-blue-300 hover:shadow-sm"
              >
                <p className="mb-1 text-sm font-medium text-slate-900 line-clamp-2">{opp.title}</p>
                {opp.sponsor && <p className="mb-2 text-xs text-slate-500">{opp.sponsor}</p>}
                <div className="flex flex-wrap gap-1.5">
                  {amount && (
                    <Chip>
                      <DollarSign className="mr-0.5 inline h-3 w-3" />
                      {amount}
                    </Chip>
                  )}
                  {hasValidDeadline && (
                    <Chip>
                      <Clock className="mr-0.5 inline h-3 w-3" />
                      {new Date(opp.deadline).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </Chip>
                  )}
                  {opp.link_status === 'broken' && <Chip tone="red">Link issue</Chip>}
                </div>
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ── 4. WHAT SHOULD THE USER ANSWER NEXT ──────────────────────────────────────
function AnswerNextPanel({ items, profileId }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="h-4 w-4 text-indigo-600" /> 4. What should you answer next
        </CardTitle>
        <CardDescription>
          Missing facts ranked by impact — questions that unblock the most potential matches come
          first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 ? (
          <div className="flex items-center gap-2 py-2 text-sm text-slate-500">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Nothing outstanding — the profile has every high-value fact.
          </div>
        ) : (
          items.map((item, i) => {
            const target = profileId
              ? createPageUrl('ProfileDetail', {
                  id: profileId,
                  ...(item.section_key ? { section: item.section_key } : {}),
                })
              : null;
            const body = (
              <>
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-semibold text-indigo-700">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">{item.question}</span>
                    {item.blocked_matches > 0 && (
                      <Chip tone="amber">unblocks {item.blocked_matches} match{item.blocked_matches === 1 ? '' : 'es'}</Chip>
                    )}
                    <span className="text-xs font-medium text-indigo-600">Answer in profile →</span>
                  </div>
                  {item.why && <p className="mt-0.5 text-xs text-slate-500">{item.why}</p>}
                </div>
              </>
            );
            return target ? (
              <Link
                key={item.field}
                to={target}
                className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 transition hover:border-indigo-300 hover:bg-indigo-50"
              >
                {body}
              </Link>
            ) : (
              <div key={item.field} className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                {body}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
