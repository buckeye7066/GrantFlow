import { useState } from 'react';
import {
  OrganizationProfile,
  FOCUS_OPTIONS,
  BUDGET_RANGES,
  ORG_TYPES,
  emptyProfile,
} from '../types/organization';

type OrgProfileFormProps = {
  initial: OrganizationProfile | null;
  onSave: (values: Partial<OrganizationProfile>) => void;
  onCancel: () => void;
};

// Large, tappable option card used for budget range and organization type.
function SelectCard({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-xl border-2 px-4 py-3 text-left text-base transition ${
        selected
          ? 'border-emerald-700 bg-emerald-50 text-emerald-900'
          : 'border-slate-300 bg-white text-slate-800 hover:border-emerald-400'
      }`}
    >
      {label}
    </button>
  );
}

export default function OrgProfileForm({ initial, onSave, onCancel }: OrgProfileFormProps) {
  const start = initial ?? emptyProfile();
  const [name, setName] = useState(start.name);
  const [mission, setMission] = useState(start.mission);
  const [focusAreas, setFocusAreas] = useState<string[]>(start.focusAreas);
  const [focusAreasOther, setFocusAreasOther] = useState(start.focusAreasOther);
  const [whoWeServe, setWhoWeServe] = useState(start.whoWeServe);
  const [geographicArea, setGeographicArea] = useState(start.geographicArea);
  const [annualBudgetRange, setAnnualBudgetRange] = useState(start.annualBudgetRange);
  const [organizationType, setOrganizationType] = useState(start.organizationType);

  // Add or remove a focus area value from the selected list.
  function toggleFocus(value: string) {
    setFocusAreas((current) =>
      current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value],
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name: name.trim(),
      mission: mission.trim(),
      focusAreas,
      focusAreasOther: focusAreasOther.trim(),
      whoWeServe: whoWeServe.trim(),
      geographicArea: geographicArea.trim(),
      annualBudgetRange,
      organizationType,
    });
  }

  const fieldClass =
    'mt-2 w-full rounded-xl border-2 border-slate-300 bg-white px-4 py-3 text-base text-slate-900 placeholder:text-slate-500 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-200';
  const labelClass = 'block text-base font-semibold text-slate-900';

  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">Your organization</h1>
        <p className="mt-2 text-base text-slate-700">
          Fill in whatever you like &mdash; every part is optional. You can change it any time.
        </p>
      </div>

      <div>
        <label htmlFor="org-name" className={labelClass}>
          Organization name
        </label>
        <input
          id="org-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="For example, Riverside Community Center"
          className={fieldClass}
        />
      </div>

      <div>
        <label htmlFor="org-mission" className={labelClass}>
          What is your mission?
        </label>
        <textarea
          id="org-mission"
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          rows={3}
          placeholder="In a sentence or two, what does your organization do?"
          className={fieldClass}
        />
      </div>

      <fieldset>
        <legend className={labelClass}>What do you focus on?</legend>
        <p className="mt-1 text-sm text-slate-600">Pick any that apply.</p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {FOCUS_OPTIONS.map((opt) => {
            const checked = focusAreas.includes(opt.value);
            return (
              <label
                key={opt.value}
                className={`flex items-center gap-3 rounded-xl border-2 px-4 py-3 text-base ${
                  checked
                    ? 'border-emerald-700 bg-emerald-50 text-emerald-900'
                    : 'border-slate-300 bg-white text-slate-800'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleFocus(opt.value)}
                  className="h-5 w-5 accent-emerald-700"
                />
                {opt.label}
              </label>
            );
          })}
        </div>
        <div className="mt-4">
          <label htmlFor="focus-other" className="block text-base font-medium text-slate-800">
            Anything else?
          </label>
          <input
            id="focus-other"
            type="text"
            value={focusAreasOther}
            onChange={(e) => setFocusAreasOther(e.target.value)}
            placeholder="Tell us in your own words"
            className={fieldClass}
          />
        </div>
      </fieldset>

      <div>
        <label htmlFor="who-we-serve" className={labelClass}>
          Who do you serve?
        </label>
        <input
          id="who-we-serve"
          type="text"
          value={whoWeServe}
          onChange={(e) => setWhoWeServe(e.target.value)}
          placeholder="For example, families, students, small farmers"
          className={fieldClass}
        />
      </div>

      <div>
        <label htmlFor="geo-area" className={labelClass}>
          Where do you work?
        </label>
        <input
          id="geo-area"
          type="text"
          value={geographicArea}
          onChange={(e) => setGeographicArea(e.target.value)}
          placeholder="A town, county, state, or region"
          className={fieldClass}
        />
      </div>

      <fieldset>
        <legend className={labelClass}>About how much is your yearly budget?</legend>
        <p className="mt-1 text-sm text-slate-600">A rough range is fine.</p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {BUDGET_RANGES.map((range) => (
            <SelectCard
              key={range}
              label={range}
              selected={annualBudgetRange === range}
              onClick={() =>
                setAnnualBudgetRange((cur) => (cur === range ? '' : range))
              }
            />
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className={labelClass}>What kind of organization are you?</legend>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ORG_TYPES.map((opt) => (
            <SelectCard
              key={opt.value}
              label={opt.label}
              selected={organizationType === opt.value}
              onClick={() =>
                setOrganizationType((cur) => (cur === opt.value ? '' : opt.value))
              }
            />
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <button
          type="submit"
          className="rounded-2xl bg-emerald-700 px-8 py-4 text-lg font-semibold text-white shadow-md transition hover:bg-emerald-800 focus:outline-none focus:ring-4 focus:ring-emerald-300"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-2xl border-2 border-slate-300 px-8 py-4 text-lg font-medium text-slate-800 transition hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
