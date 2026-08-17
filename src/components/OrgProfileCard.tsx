import {
  OrganizationProfile,
  FOCUS_OPTIONS,
  ORG_TYPES,
} from '../types/organization';

type OrgProfileCardProps = {
  profile: OrganizationProfile;
  onEdit: () => void;
};

function focusLabels(values: string[]): string[] {
  return values.map((v) => {
    const match = FOCUS_OPTIONS.find((o) => o.value === v);
    return match ? match.label : v;
  });
}

function orgTypeLabel(value: string): string {
  const match = ORG_TYPES.find((o) => o.value === value);
  return match ? match.label : value;
}

// One labelled row. Renders nothing when there is no value to show.
function Row({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-sm font-medium text-slate-600">{label}</dt>
      <dd className="mt-0.5 text-base text-slate-900">{value}</dd>
    </div>
  );
}

export default function OrgProfileCard({ profile, onEdit }: OrgProfileCardProps) {
  const areas = [
    ...focusLabels(profile.focusAreas),
    ...(profile.focusAreasOther ? [profile.focusAreasOther] : []),
  ].join(', ');

  const hasAnything =
    profile.name ||
    profile.mission ||
    areas ||
    profile.whoWeServe ||
    profile.geographicArea ||
    profile.annualBudgetRange ||
    profile.organizationType;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="rounded-2xl border-2 border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-600">Your organization</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-900">
              {profile.name || 'Your organization'}
            </h1>
          </div>
          <button
            type="button"
            onClick={onEdit}
            className="shrink-0 rounded-xl bg-emerald-700 px-6 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-emerald-800 focus:outline-none focus:ring-4 focus:ring-emerald-300"
          >
            Edit
          </button>
        </div>

        {hasAnything ? (
          <dl className="mt-6 space-y-4">
            <Row label="Mission" value={profile.mission} />
            <Row label="Focus areas" value={areas} />
            <Row label="Who you serve" value={profile.whoWeServe} />
            <Row label="Where you work" value={profile.geographicArea} />
            <Row label="Yearly budget" value={profile.annualBudgetRange} />
            <Row
              label="Organization type"
              value={profile.organizationType ? orgTypeLabel(profile.organizationType) : ''}
            />
          </dl>
        ) : (
          <p className="mt-6 text-base text-slate-700">
            You haven&rsquo;t added any details yet. Tap Edit to fill in whatever you like.
          </p>
        )}
      </div>

      <p className="mt-4 text-center text-sm text-slate-600">
        Saved on this device. No account and no internet needed.
      </p>
    </div>
  );
}
