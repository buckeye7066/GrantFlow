import React, { useMemo, useRef, useState } from "react"
import { format, formatDistanceToNow, parseISO } from "date-fns"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import PipelinePotentialBreakdown from "@/components/profiles/PipelinePotentialBreakdown"
import ProfileAutomationsCard from "@/components/profiles/ProfileAutomationsCard"
import ProfileActionPlanCard from "@/components/profiles/ProfileActionPlanCard"
import {
  ArrowRight,
  CalendarClock,
  ClipboardList,
  FileText,
  FolderOpen,
  HandCoins,
  HeartPulse,
  Home,
  MapPin,
  Medal,
  GraduationCap,
  PenSquare,
  ShieldCheck,
  Sparkles,
  Tag,
  Timer,
  Users,
  UserCircle,
  Briefcase,
  Building2,
  Loader2,
  Upload,
  UploadCloud,
  Globe,
  KeyRound,
} from "lucide-react"
import { normalizeTargetColleges } from "@/utils/targetCollegesSync"
import { SECTION_METADATA } from "@/config/sectionMetadata"
import { useDashboardPreferences } from "@/contexts/DashboardPreferencesContext.jsx"
import { useSettingsStore } from "@/stores/settingsStore"
import EditableField from "@/components/shared/EditableField.jsx"
import { useAuthenticatedAvatar } from "@/hooks/useAuthenticatedAvatar"
import { isRealProfileId } from "@/api/profileIdGuards"
import ProfileGapGate from "./ProfileGapGate"

// Anya's gap gate is OFF until VITE_GAP_GATE_ENABLED=true at build. Until then the
// mount below is fully inert (renders nothing, fetches nothing).
const GAP_GATE_ENABLED =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GAP_GATE_ENABLED === "true"
import {
  calculateProfileCompletion,
  hasMeaningfulProfileValue,
  normalizeProfileSections,
} from "@/utils/profileCompletion"
import {
  formatInlinePreviewValue,
  flattenObjectEntries,
  renderValue,
} from "./profileOverviewHelpers.jsx"
import {
  formatFieldLabel,
  formatStatusLabel,
  getFieldFormat,
  normalizeDisplayString,
} from "@/utils/fieldDisplay"

const SECTION_ICONS = {
  basic_information: UserCircle,
  organization_details: Building2,
  financial_information: HandCoins,
  government_assistance: ShieldCheck,
  health_medical: HeartPulse,
  medical_insurance: ShieldCheck,
  medical_history: HeartPulse,
  nonprofit_compliance: ClipboardList,
  small_business_details: Briefcase,
  demographics: Users,
  family_life: Home,
  military_service: Medal,
  occupation: Briefcase,
  location_focus: MapPin,
  narrative: FileText,
  student_details: GraduationCap,
  firearms: ShieldCheck,
  political_civic: Users,
}

const LEGACY_BENEFIT_FIELDS = [
  "medicaid_enrolled",
  "medicare_recipient",
  "ssi_recipient",
  "ssdi_recipient",
  "snap_recipient",
  "tanf_recipient",
  "section8_housing",
]

// Valid US state / territory 2-letter codes. Used to validate the secondary
// address state field so we don't silently truncate arbitrary text like
// "Tennessee" into "TE".
const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "AS", "MP",
])

// Map common full state names to their 2-letter code so a user typing
// "Tennessee" gets normalized to "TN" rather than silently truncated.
const US_STATE_NAME_TO_CODE = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
  "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
  "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
  "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
  "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
  "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
  "puerto rico": "PR",
}

function resolveStateCode(raw) {
  const trimmed = String(raw ?? "").trim()
  if (!trimmed) return { code: "", valid: true }
  const upper = trimmed.toUpperCase()
  if (upper.length === 2 && US_STATE_CODES.has(upper)) {
    return { code: upper, valid: true }
  }
  const byName = US_STATE_NAME_TO_CODE[trimmed.toLowerCase()]
  if (byName) return { code: byName, valid: true }
  return { code: upper.slice(0, 2), valid: false }
}

// Read a section out of the normalized sections collection without ever
// silently yielding undefined because the collection turned out to be a
// plain object or array instead of a Map. normalizeProfileSections is
// expected to return a Map keyed by section key, but this helper tolerates
// the other shapes defensively so the editor never opens with empty data.
function getSection(sections, key) {
  if (!sections || !key) return undefined
  if (typeof sections.get === "function") {
    return sections.get(key)
  }
  if (Array.isArray(sections)) {
    return sections.find((entry) => entry?.section_key === key || entry?.key === key)
  }
  if (typeof sections === "object") {
    return sections[key]
  }
  return undefined
}

function toEditableString(value) {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    const allPrimitive = value.every(
      (v) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v),
    )
    if (allPrimitive) return value.map((v) => (v === null || v === undefined ? "" : String(v))).join(", ")
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return ""
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toEditableStringForField(fieldKey, value) {
  // Special-case: address is often stored as an object,
  // but inline editing expects a human-friendly string.
  if (fieldKey === "address") {
    if (looksLikeAddressObject(value)) {
      const formatted = formatAddressObject(value)
      if (formatted) return formatted
    }
    if (typeof value === "string") {
      const trimmed = value.trim()
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsed = JSON.parse(trimmed)
          if (looksLikeAddressObject(parsed)) {
            const formatted = formatAddressObject(parsed)
            if (formatted) return formatted
          }
        } catch {
          // ignore parse failures; fall back to raw string
        }
      }
      return value
    }
  }

  return toEditableString(value)
}

function normalizeEntry([key, value]) {
  return hasMeaningfulProfileValue(value) ? [key, value] : null
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false
  return Object.prototype.toString.call(value) === "[object Object]"
}

function formatAddressObject(address) {
  if (!isPlainObject(address)) return null

  const line1 = address.line1 ?? address.address1 ?? address.street ?? address.street1
  const line2 = address.line2 ?? address.address2 ?? address.street2
  const city = address.city
  const state = address.state ?? address.region
  const postal = address.zip ?? address.postal ?? address.postal_code ?? address.zip_code
  const country = address.country

  const parts = []
  if (line1) parts.push(String(line1).trim())
  if (line2) parts.push(String(line2).trim())

  const cityState = [city, state].filter(Boolean).map((v) => String(v).trim()).join(", ")
  const cityStatePostal = [cityState, postal].filter(Boolean).join(" ").trim()
  if (cityStatePostal) parts.push(cityStatePostal)

  if (country) parts.push(String(country).trim())

  return parts.filter(Boolean).join("\n").trim() || null
}

function looksLikeAddressObject(value) {
  if (!isPlainObject(value)) return false
  const keys = new Set(Object.keys(value).map((k) => String(k).toLowerCase()))
  return (
    keys.has("street") ||
    keys.has("street1") ||
    keys.has("address1") ||
    keys.has("line1") ||
    keys.has("city") ||
    keys.has("state") ||
    keys.has("zip") ||
    keys.has("zip_code") ||
    keys.has("postal_code")
  )
}

function renderFlattenedPreview(flattened) {
  if (!flattened.length) {
    return <span className="text-sm text-slate-500">—</span>
  }
  const preview = flattened.slice(0, 6)
  const remaining = flattened.length - preview.length

  return (
    <div className="max-w-[320px] space-y-1 text-right">
      {preview.map(([key, inline]) => (
        <div key={key} className="flex items-start justify-end gap-2">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {String(key).replace(/\./g, " ")}
          </span>
          <span className="min-w-0 text-xs text-slate-900 whitespace-pre-wrap break-words">{inline}</span>
        </div>
      ))}
      {remaining > 0 ? (
        <div className="text-[11px] text-slate-400">{`+${remaining} more`}</div>
      ) : null}
    </div>
  )
}

// Funding Current "Pipeline potential" hero treatment: the figure sits on the
// dark ink card (matching design/grantflow-dashboard.html .potential). It's the
// same across themes so the headline funding number always reads as the hero.
const PIPELINE_HERO_CARD =
  "border-transparent bg-current-ink text-[#eaf1ec] shadow-[0_24px_48px_-30px_rgba(20,36,31,0.7)]"
const PIPELINE_HERO_LABEL = "text-[#9fb4a8]"

const THEME_PRESETS = {
  blue: {
    metric: "bg-blue-50 text-blue-700 border-blue-200",
    subtleMetric: "bg-blue-50 text-blue-700 border-blue-100",
    banner: "border-blue-100 bg-blue-50/70",
    pipelineCard: PIPELINE_HERO_CARD,
    pipelineLabel: PIPELINE_HERO_LABEL,
    gradient: "bg-gradient-to-br from-blue-500 to-blue-600",
    iconTone: "text-blue-600",
  },
  emerald: {
    metric: "bg-emerald-50 text-emerald-700 border-emerald-200",
    subtleMetric: "bg-emerald-50 text-emerald-700 border-emerald-100",
    banner: "border-emerald-100 bg-emerald-50/70",
    pipelineCard: PIPELINE_HERO_CARD,
    pipelineLabel: PIPELINE_HERO_LABEL,
    gradient: "bg-gradient-to-br from-emerald-500 to-emerald-600",
    iconTone: "text-emerald-600",
  },
  violet: {
    metric: "bg-violet-50 text-violet-700 border-violet-200",
    subtleMetric: "bg-violet-50 text-violet-700 border-violet-100",
    banner: "border-violet-100 bg-violet-50/70",
    pipelineCard: PIPELINE_HERO_CARD,
    pipelineLabel: PIPELINE_HERO_LABEL,
    gradient: "bg-gradient-to-br from-violet-500 to-violet-600",
    iconTone: "text-violet-600",
  },
  amber: {
    metric: "bg-amber-50 text-amber-700 border-amber-200",
    subtleMetric: "bg-amber-50 text-amber-700 border-amber-100",
    banner: "border-amber-100 bg-amber-50/70",
    pipelineCard: PIPELINE_HERO_CARD,
    pipelineLabel: PIPELINE_HERO_LABEL,
    gradient: "bg-gradient-to-br from-amber-500 to-amber-600",
    iconTone: "text-amber-600",
  },
}

function formatCurrency(value, { cents = false } = {}) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return null
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents || amount % 1 !== 0 ? 2 : 0,
  }).format(cents ? amount / 100 : amount)
}

// Parse a date string defensively. Prefer date-fns parseISO for ISO-like
// strings (deterministic across browsers/locales) and only fall back to the
// native Date constructor when the string is clearly not ISO. Returns null
// when the value cannot be parsed into a valid date.
function parseDateSafe(value) {
  const normalized = normalizeDisplayString(value)
  if (!normalized) return null
  // ISO-ish strings start with YYYY-MM-DD (optionally with time).
  if (/^\d{4}-\d{2}-\d{2}/.test(normalized)) {
    const isoDate = parseISO(normalized)
    if (!Number.isNaN(isoDate.getTime())) return isoDate
  }
  const fallback = new Date(normalized)
  if (!Number.isNaN(fallback.getTime())) return fallback
  return null
}

function formatDateValue(value, { includeTime = false } = {}) {
  const normalized = normalizeDisplayString(value)
  if (!normalized) return null
  const date = parseDateSafe(normalized)
  if (!date) return normalized
  return includeTime ? format(date, "PP p") : format(date, "PP")
}

function renderScalarValue(value, className = "text-sm text-slate-900") {
  const normalized = normalizeDisplayString(value)
  return normalized ? <span className={className}>{normalized}</span> : <span className="text-sm text-slate-500">—</span>
}

function formatCurrencyFromCents(cents) {
  if (cents === null || cents === undefined) return "Not set"
  if (cents === 0) return "$0"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
}

function TargetCollegesCards({ colleges, onViewInUniversities }) {
  const list = normalizeTargetColleges(colleges)
  if (list.length === 0) return null
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">Target colleges</span>
        {onViewInUniversities ? (
          <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); onViewInUniversities() }}>
            <ArrowRight className="w-3.5 h-3.5 mr-1.5" />
            View in Universities
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {list.map((name, idx) => (
          <div
            key={`${name}-${idx}`}
            className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2.5 flex items-center gap-2 cursor-pointer hover:bg-slate-100 hover:border-slate-300 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              if (onViewInUniversities) onViewInUniversities()
            }}
            role="button"
            tabIndex={0}
          >
            <GraduationCap className="w-4 h-4 text-indigo-500 shrink-0" />
            <span className="text-sm font-medium text-slate-800 truncate">{name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Status values that mark a school as "the one I'm attending". Mirrors
// COMMITTED_SCHOOL_STATUSES in backend/services/crawlers/crawlerManager.js
// and isCommittedStatus in UniversityApplicationsSection.jsx so the
// Profile overview, the rich Universities tab, and the backend's
// school-card narrowing all agree on the same vocabulary.
const COMMITTED_APPLICATION_STATUSES = new Set(["committed", "enrolled", "attending"])
const STATUS_LABELS = {
  planning: "Planning",
  interested: "Interested",
  in_progress: "In progress",
  submitted: "Submitted",
  accepted: "Accepted",
  committed: "Committed",
  enrolled: "Enrolled",
  attending: "Attending",
  deferred: "Deferred",
  waitlisted: "Waitlisted",
  denied: "Denied",
}

function formatApplicationStatus(status) {
  const raw = String(status || "").trim().toLowerCase()
  if (!raw) return "Status unknown"
  return STATUS_LABELS[raw] ?? formatStatusLabel(raw)
}

function isCommittedApplicationStatus(status) {
  return COMMITTED_APPLICATION_STATUSES.has(String(status || "").trim().toLowerCase())
}

function UniversityApplicationsPreview({ applications, onViewInUniversities }) {
  const list = Array.isArray(applications) ? applications.filter(Boolean) : []
  if (list.length === 0) {
    return <span className="text-sm text-slate-500">—</span>
  }

  const committed = list.filter((app) => isCommittedApplicationStatus(app?.status))
  // Pin committed schools to the top so the chosen-school state is
  // unmissable in the Profile overview preview.
  const sorted = [...list].sort((a, b) => {
    const aCommitted = isCommittedApplicationStatus(a?.status)
    const bCommitted = isCommittedApplicationStatus(b?.status)
    if (aCommitted && !bCommitted) return -1
    if (!aCommitted && bCommitted) return 1
    return String(a?.name ?? "").localeCompare(String(b?.name ?? ""))
  })
  const previewLimit = 8
  const preview = sorted.slice(0, previewLimit)
  const remaining = sorted.length - preview.length

  return (
    <div className="space-y-2 max-w-[360px] text-right">
      {committed.length > 0 ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-left">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
            Attending
          </p>
          <p className="text-sm font-semibold text-emerald-900">
            {committed.map((app) => app?.name || "Unnamed school").join(", ")}
          </p>
          <p className="text-[11px] text-emerald-800 mt-0.5">
            Funding cards now scoped to {committed.length === 1 ? "this school" : "these schools"}.
          </p>
        </div>
      ) : null}
      <ul className="space-y-1 text-left">
        {preview.map((app, idx) => {
          const name = String(app?.name || `School ${idx + 1}`).trim() || `School ${idx + 1}`
          const status = formatApplicationStatus(app?.status)
          const isCommitted = isCommittedApplicationStatus(app?.status)
          return (
            <li
              key={app?.id || `${name}-${idx}`}
              className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50/80 px-2.5 py-1.5"
            >
              <span className="text-sm font-medium text-slate-800 truncate">{name}</span>
              <Badge
                variant={isCommitted ? "default" : "outline"}
                className={`text-[10px] uppercase tracking-wide ${
                  isCommitted ? "bg-emerald-100 text-emerald-800 border-emerald-200" : ""
                }`}
              >
                {status}
              </Badge>
            </li>
          )
        })}
      </ul>
      {remaining > 0 ? (
        <p className="text-[11px] text-slate-500">+{remaining} more</p>
      ) : null}
      {onViewInUniversities ? (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={(event) => {
            event.stopPropagation()
            onViewInUniversities()
          }}
        >
          <ArrowRight className="w-3.5 h-3.5 mr-1.5" />
          {committed.length > 0 ? "Manage in Universities" : "Choose attending school"}
        </Button>
      ) : null}
    </div>
  )
}

function TriStateField({ label, value, disabled, onChange }) {
  const state = value === true ? "yes" : value === false ? "no" : "unknown"
  const nextValue = state === "unknown" ? true : state === "yes" ? false : null
  const tone =
    state === "yes"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : state === "no"
      ? "border-slate-200 bg-slate-50 text-slate-600"
      : "border-amber-200 bg-amber-50/60 text-amber-700 opacity-80"

  return (
    <button
      type="button"
      disabled={disabled}
      className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${tone}`}
      onClick={() => onChange?.(nextValue)}
      aria-label={`${label}: ${state}. Click to change.`}
    >
      {state === "yes" ? "Yes" : state === "no" ? "No" : "Unknown"}
    </button>
  )
}

function SectionPreview({
  sectionKey,
  section,
  onEdit,
  onAskAI,
  onSaveField,
  isSaving,
  isAIProcessing,
  onNavigateToUniversities,
}) {
  const config = SECTION_METADATA[sectionKey]
  const SectionIcon = SECTION_ICONS[sectionKey] ?? FolderOpen
  const dataEntries = Object.entries(section?.data ?? {})
    .map(normalizeEntry)
    .filter(Boolean)
  const hasData = Object.values(section?.data ?? {}).some(hasMeaningfulProfileValue)
  const hasLegacyBenefitFlags =
    sectionKey === "government_assistance" &&
    LEGACY_BENEFIT_FIELDS.some((fieldKey) => Object.prototype.hasOwnProperty.call(section?.data ?? {}, fieldKey))

  const isInteractive = Boolean(onEdit) && !isSaving && !isAIProcessing
  const canInlineEdit = Boolean(onSaveField) && !isSaving && !isAIProcessing

  const updatedAtDate = section?.updated_at ? parseDateSafe(section.updated_at) : null

  const handleCardClick = () => {
    if (!isInteractive || !onEdit) return
    onEdit(sectionKey, section?.data ?? {})
  }

  const handleCardKeyDown = (event) => {
    if (!isInteractive) return
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onEdit?.(sectionKey, section?.data ?? {})
    }
  }

  return (
    <Card
      className={`border border-slate-200 bg-white/70 backdrop-blur-md shadow-sm transition ${
        isInteractive ? "cursor-pointer hover:border-blue-200 focus-within:ring-2 focus-within:ring-blue-200" : ""
      }`}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-lg bg-blue-50 text-blue-600">
                <SectionIcon className="w-4 h-4" />
              </span>
              <CardTitle className="text-base font-semibold text-slate-900">
                {config?.title ?? sectionKey}
              </CardTitle>
            </div>
            {config?.description ? (
              <p className="text-xs text-slate-500 leading-snug">{config.description}</p>
            ) : null}
          </div>
          <Badge variant={hasData ? "default" : "outline"} className="text-xs capitalize">
            {hasData ? "Captured" : "Pending"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasData ? (
          <div className="space-y-3">
            {hasLegacyBenefitFlags ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-left text-xs text-amber-800">
                Review benefit answers once: older recipient fields were mapped to applicant-level benefit flags.
              </div>
            ) : null}
            {dataEntries.slice(0, 8).map(([key, value]) => {
              const label = formatFieldLabel(sectionKey, key)
              const formatHint = getFieldFormat(sectionKey, key)
              const isTriState = formatHint === "boolean_tri"
              const isBoolean = typeof value === "boolean" || isTriState
              const isComplexValue =
                (Array.isArray(value) && value.some((v) => v && typeof v === "object")) ||
                (value && typeof value === "object" && !Array.isArray(value))

              if (sectionKey === "university_applications" && key === "applications") {
                return (
                  <div key={key} onClick={(e) => e.stopPropagation()}>
                    <UniversityApplicationsPreview
                      applications={value}
                      onViewInUniversities={onNavigateToUniversities}
                    />
                  </div>
                )
              }

              if (sectionKey === "education" && key === "target_colleges") {
                const colleges = normalizeTargetColleges(value)
                if (colleges.length > 0) {
                  return (
                    <div key={key} onClick={(e) => e.stopPropagation()}>
                      <TargetCollegesCards
                        colleges={value}
                        onViewInUniversities={onNavigateToUniversities}
                      />
                    </div>
                  )
                }
                return (
                  <div key={key} className="flex items-start justify-between gap-4">
                    <dt className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</dt>
                    <dd className="flex-1 text-right">{renderValue(key, value, sectionKey)}</dd>
                  </div>
                )
              }

              if (!canInlineEdit) {
                return (
                  <div key={key} className="flex items-start justify-between gap-4">
                    <dt className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</dt>
                    <dd className="flex-1 text-right">{renderValue(key, value, sectionKey)}</dd>
                  </div>
                )
              }

              if (isComplexValue) {
                return (
                  <div key={key} className="flex items-start justify-between gap-4">
                    <dt className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</dt>
                    <dd className="flex-1 text-right">{renderValue(key, value, sectionKey)}</dd>
                  </div>
                )
              }

              if (isBoolean) {
                return (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-4"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</span>
                    {isTriState ? (
                      <TriStateField
                        label={label}
                        value={value}
                        disabled={!canInlineEdit}
                        onChange={(nextValue) => onSaveField?.(sectionKey, key, nextValue)}
                      />
                    ) : (
                      <Switch
                        checked={Boolean(value)}
                        disabled={!canInlineEdit}
                        onCheckedChange={(checked) => onSaveField?.(sectionKey, key, checked)}
                      />
                    )}
                  </div>
                )
              }

              return (
                <div
                  key={key}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <EditableField
                    label={label}
                    value={toEditableStringForField(key, value)}
                    type={
                      typeof value === "string" && (value.includes("\n") || value.length > 80)
                        ? "textarea"
                        : "text"
                    }
                    isSubmitting={!canInlineEdit}
                    onSave={(next) => onSaveField?.(sectionKey, key, next)}
                  />
                </div>
              )
            })}
            {dataEntries.length > 8 ? (
              <p className="text-xs text-slate-400">{`+${dataEntries.length - 8} more field${
                dataEntries.length - 8 === 1 ? "" : "s"
              } stored`}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            No data captured yet. Use the editor or AI assist to fill out this section exactly as listed in the comprehensive
            application.
          </p>
        )}

        <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
          <span className="flex items-center gap-2">
            <CalendarClock className="w-3.5 h-3.5" />
            {hasData && updatedAtDate
              ? `Updated ${formatDistanceToNow(updatedAtDate, { addSuffix: true })}`
              : "Not updated yet"}
          </span>
          <div className="flex items-center gap-2">
            {onAskAI ? (
              <Button
                variant="outline"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation()
                  onAskAI()
                }}
                disabled={isAIProcessing || isSaving}
                className="h-8 gap-2"
              >
                {isAIProcessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {isAIProcessing ? "Asking AI…" : "Ask AI"}
              </Button>
            ) : null}
            {onEdit ? (
              <Button
                variant="outline"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation()
                  onEdit(sectionKey, section?.data ?? {})
                }}
                disabled={isSaving || isAIProcessing}
                className="h-8 gap-2"
              >
                <PenSquare className="w-3.5 h-3.5" />
                Edit
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// Optional label for a second address. Covers the common multi-location cases:
// a student's home vs. campus, a missionary's home vs. deployed, military home vs.
// duty station, a travel nurse's two homes.
const SECONDARY_ADDRESS_TYPES = [
  "Home",
  "School",
  "Campus",
  "Off-campus",
  "Deployed",
  "Duty station",
  "Mailing",
  "Work",
  "Other",
]

function normalizeSecondaryAddress(raw) {
  if (!isPlainObject(raw)) {
    return { line1: "", city: "", state: "", zip: "", type: "" }
  }
  return {
    line1: String(raw.line1 ?? raw.address1 ?? raw.street ?? raw.street1 ?? "").trim(),
    city: String(raw.city ?? "").trim(),
    state: String(raw.state ?? raw.region ?? "").trim(),
    zip: String(raw.zip ?? raw.zip_code ?? raw.postal ?? raw.postal_code ?? "").trim(),
    type: String(raw.type ?? raw.label ?? "").trim(),
  }
}

// A clean, optional editor for a SECOND address (line1/city/state/zip + a type label),
// shown alongside the primary address. Saves to basic_information.secondary_address via
// the same onSaveField mechanism the rest of the overview uses (no new route). Both
// addresses' states feed geo matching + local crawlers (see profileSignals `states[]`).
function SecondaryAddressCard({ value, onSave, isSaving }) {
  const initial = useMemo(() => normalizeSecondaryAddress(value), [value])
  const hasExisting = Boolean(
    initial.line1 || initial.city || initial.state || initial.zip || initial.type,
  )
  const [open, setOpen] = useState(hasExisting)
  const [form, setForm] = useState(initial)
  const [stateError, setStateError] = useState(null)

  React.useEffect(() => {
    setForm(initial)
    if (hasExisting) setOpen(true)
  }, [initial, hasExisting])

  const canSave = Boolean(onSave) && !isSaving
  const setField = (key) => (event) => {
    if (key === "state") setStateError(null)
    setForm((prev) => ({ ...prev, [key]: event.target.value }))
  }

  const handleSave = async () => {
    if (!canSave) return
    const { code: stateCode, valid: stateValid } = resolveStateCode(form.state)
    if (!stateValid) {
      setStateError(
        "Enter a valid 2-letter US state code (e.g. TN) or a recognized state name.",
      )
      return
    }
    setStateError(null)
    const trimmed = {
      line1: form.line1.trim(),
      city: form.city.trim(),
      state: stateCode,
      zip: form.zip.trim(),
      type: form.type.trim(),
    }
    const isEmpty = !trimmed.line1 && !trimmed.city && !trimmed.state && !trimmed.zip && !trimmed.type
    // Saving an empty form clears the secondary address (back to single-location behavior).
    await onSave(isEmpty ? null : trimmed)
  }

  const handleClear = async () => {
    if (!canSave) return
    setStateError(null)
    setForm({ line1: "", city: "", state: "", zip: "", type: "" })
    await onSave(null)
  }

  return (
    <Card className="border border-slate-200 bg-white/70 backdrop-blur-md shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-lg bg-blue-50 text-blue-600">
                <MapPin className="w-4 h-4" />
              </span>
              <CardTitle className="text-base font-semibold text-slate-900">Second address</CardTitle>
            </div>
            <p className="text-xs text-slate-500 leading-snug">
              Optional. Add a second address — e.g. home vs. school, or a deployment / duty station.
              Both locations are used for matching and local funding.
            </p>
          </div>
          <Badge variant={hasExisting ? "default" : "outline"} className="text-xs capitalize">
            {hasExisting ? "Captured" : "Optional"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!open ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen(true)}
            className="gap-2"
          >
            <PenSquare className="w-3.5 h-3.5" />
            Add a second address
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="secondary-address-type">Label</Label>
              <select
                id="secondary-address-type"
                value={form.type}
                onChange={setField("type")}
                disabled={!canSave}
                className="flex h-9 w-full rounded-md border border-slate-200 bg-white px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-60"
              >
                <option value="">Select a label (optional)</option>
                {SECONDARY_ADDRESS_TYPES.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="secondary-address-line1">Street address</Label>
              <Input
                id="secondary-address-line1"
                value={form.line1}
                onChange={setField("line1")}
                disabled={!canSave}
                placeholder="123 Campus Dr"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5 sm:col-span-1">
                <Label htmlFor="secondary-address-city">City</Label>
                <Input
                  id="secondary-address-city"
                  value={form.city}
                  onChange={setField("city")}
                  disabled={!canSave}
                  placeholder="Murfreesboro"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="secondary-address-state">State</Label>
                <Input
                  id="secondary-address-state"
                  value={form.state}
                  onChange={setField("state")}
                  disabled={!canSave}
                  placeholder="TN"
                  aria-invalid={stateError ? "true" : undefined}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="secondary-address-zip">ZIP code</Label>
                <Input
                  id="secondary-address-zip"
                  value={form.zip}
                  onChange={setField("zip")}
                  disabled={!canSave}
                  placeholder="37132"
                />
              </div>
            </div>
            {stateError ? (
              <p className="text-xs text-red-600">{stateError}</p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={handleSave} disabled={!canSave}>
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                Save second address
              </Button>
              {hasExisting ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClear}
                  disabled={!canSave}
                  className="text-slate-500"
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function ProfileOverview({
  profile,
  onEditSection,
  onSaveField,
  savingSectionKey,
  onAskSection,
  aiLoadingKey,
  onUploadAvatar,
  onRequestAvatarAI,
  onUseWebsiteLogo,
  isOrgProfile = false,
  hasWebsiteOnFile = false,
  isUploadingAvatar,
  isRequestingAvatar,
  isFetchingWebsiteLogo = false,
  onUploadDocument,
  isUploadingDocument,
  fundsTotal = 0,
  billing = null,
  onNavigateToUniversities,
  onNavigateToPortals,
  onRenameProfile,
  isRenamingProfile = false,
}) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState("")
  const { state: dashboardPrefs } = useDashboardPreferences()
  // Accent comes from settingsStore (single source of truth); layout stays on the
  // dashboard-preferences context.
  const accentColor = useSettingsStore((s) => s.preferences?.accent_color)
  const theme = THEME_PRESETS[accentColor] ?? THEME_PRESETS.blue
  const columnMap = {
    1: "md:grid-cols-1",
    2: "md:grid-cols-2",
    3: "md:grid-cols-3",
  }
  const gridColumnsClass = columnMap[dashboardPrefs.layoutColumns] ?? "md:grid-cols-2"
  const gapClass = dashboardPrefs.layoutStyle === "compact" ? "gap-4" : "gap-6"

  // Guard: profile may be null/undefined during loading. Compute completion
  // defensively and bail out early before any code dereferences profile.
  const profileCompletion = useMemo(
    () => (profile ? calculateProfileCompletion(profile) : null),
    [profile],
  )
  const sectionsMap = useMemo(() => {
    return profile ? normalizeProfileSections(profile.sections) : null
  }, [profile])

  const fileInputRef = useRef(null)
  const documentInputRef = useRef(null)

  const avatarInitials = useMemo(() => {
    const words = profile?.display_name?.split(/\s+/g) ?? []
    if (!words.length) return "U"
    return words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join("")
  }, [profile?.display_name])

  const avatarCacheBuster = useMemo(() => {
    // Prefer avatar_url (it changes per upload), then updated_at as a stable fallback.
    const raw = profile?.avatar_url || profile?.updated_at || ""
    const trimmed = String(raw || "").trim()
    return trimmed ? encodeURIComponent(trimmed) : null
  }, [profile?.avatar_url, profile?.updated_at])

  // Compute avatar URL, handling protected API endpoints. Robustly handle
  // empty/malformed urls and non-routable ids so we never emit a URL that
  // would 404 into a broken image.
  const avatarUrl = useMemo(() => {
    if (!profile) return null
    const downloadUrl = String(profile.avatar_download_url ?? "").trim()
    if (downloadUrl) {
      // IMPORTANT: avatar_download_url is stable across uploads, so add a cache-buster so the UI
      // refetches after a successful upload (otherwise users see a "stuck" avatar / broken image).
      return avatarCacheBuster
        ? `${downloadUrl}${downloadUrl.includes("?") ? "&" : "?"}v=${avatarCacheBuster}`
        : downloadUrl
    }
    const rawAvatarUrl = String(profile.avatar_url ?? "").trim()
    // Only emit /api/profiles/<id>/avatar/download for routable ids -- the
    // admin sentinel would 404 the avatar request and surface as a broken
    // image in the dashboard.
    if (
      rawAvatarUrl &&
      rawAvatarUrl.includes("/uploads/") &&
      isRealProfileId(profile.id)
    ) {
      const base = `/api/profiles/${profile.id}/avatar/download`
      return avatarCacheBuster ? `${base}?v=${avatarCacheBuster}` : base
    }
    // Only return a non-empty avatar_url; otherwise fall through to initials.
    return rawAvatarUrl || null
  }, [profile, avatarCacheBuster])

  // Use authenticated avatar hook to handle protected API endpoints
  const { blobUrl: avatarSrc } = useAuthenticatedAvatar(avatarUrl)

  const formattedFundsTotal = useMemo(() => {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    })
    // Coerce and validate so a bad (non-numeric) fundsTotal never renders as
    // "$NaN" -- fall back to 0 instead.
    const n = Number(fundsTotal)
    const safe = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
    return formatter.format(safe)
  }, [fundsTotal])

  const handleAvatarButton = () => {
    if (onUploadAvatar) {
      fileInputRef.current?.click()
    }
  }

  const handleAvatarFileChange = (event) => {
    try {
      const file = event.target.files?.[0]
      if (file && onUploadAvatar) {
        onUploadAvatar(file)
      }
    } catch (error) {
      // Defensive: never let a file-selection error crash the component.

      console.error("Failed to handle avatar file selection", error)
    } finally {
      if (event.target) {
        event.target.value = ""
      }
    }
  }

  const handleDocumentFileChange = (event) => {
    try {
      const file = event.target.files?.[0]
      if (file && onUploadDocument) {
        onUploadDocument(file)
      }
    } catch (error) {
      // Defensive: never let a file-selection error crash the component.

      console.error("Failed to handle document file selection", error)
    } finally {
      if (event.target) {
        event.target.value = ""
      }
    }
  }

  const totalSections = profileCompletion?.totalSections ?? 0
  const completedSections = profileCompletion?.completedSections ?? 0
  const applicableSectionKeys = profileCompletion?.applicableSectionKeys ?? []

  const updatedAtDate = profile?.updated_at ? parseDateSafe(profile.updated_at) : null
  const lastUpdated = updatedAtDate ? format(updatedAtDate, "PPP p") : "Not recorded"
  const relativeUpdated = updatedAtDate
    ? formatDistanceToNow(updatedAtDate, { addSuffix: true })
    : null

  // Early guard AFTER all hooks have been declared so we never break the
  // Rules of Hooks. When there's no profile (loading state) render nothing.
  if (!profile || !profileCompletion) {
    return null
  }

  const headerMetrics = [
    {
      label: "Sections Complete",
      value: `${completedSections}/${totalSections}`,
      icon: ClipboardList,
      tone: theme.metric,
    },
    {
      label: "Last Updated",
      value: relativeUpdated ?? lastUpdated,
      icon: Timer,
      tone: "bg-amber-50 text-amber-700 border-amber-200",
    },
    {
      label: "Tags",
      value: `${profile.tags?.length ?? 0}`,
      icon: Tag,
      tone: theme.subtleMetric,
    },
  ]

  if (billing) {
    const tierName = billing.is_pro_bono ? "Pro Bono" : billing.tier?.name ?? "Unassigned"
    const rateCents =
      billing.custom_monthly_cents ??
      (billing.tier?.base_monthly_cents ?? null)
    const discountLabel =
      billing.is_pro_bono
        ? "No invoices generated"
        : billing.discount_type && billing.discount_type !== "none"
        ? `${billing.discount_type.replace(/_/g, " ")} (${billing.discount_percent ?? 0}% off)`
        : null

    headerMetrics.push({
      label: "Billing Tier",
      value:
        rateCents !== null
          ? `${tierName} · ${rateCents === 0 ? "included" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(rateCents / 100)}/mo`
          : tierName,
      icon: HandCoins,
      tone: billing.is_pro_bono
        ? "bg-violet-50 text-violet-700 border-violet-200"
        : "bg-slate-50 text-slate-600 border-slate-200",
      subtext: discountLabel,
    })
  }

  const orderedSectionKeys = applicableSectionKeys

  return (
    <div className="space-y-10">
      {/* Anya's opening interview / gap gate. Inert unless VITE_GAP_GATE_ENABLED
          is set: when off it renders nothing; when on it prompts the owner to fill
          the profile's gaps (which then determine the type + eligibility). */}
      {GAP_GATE_ENABLED && profile?.id && isRealProfileId(profile.id) && (
        <ProfileGapGate profileId={profile.id} enabled={GAP_GATE_ENABLED} />
      )}
      <section className="rounded-3xl border border-slate-200 bg-white/80 backdrop-blur-sm shadow-sm p-6 md:p-8 space-y-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-5">
            <div className="relative">
              {avatarSrc ? (
                <img
                  src={avatarSrc}
                  alt={profile.display_name}
                  className="h-24 w-24 rounded-2xl border border-slate-200 object-cover shadow-md"
                />
              ) : (
                <div
                  className={`flex h-24 w-24 items-center justify-center rounded-2xl text-2xl font-semibold text-white shadow-inner ${theme.gradient}`}
                >
                  {avatarInitials}
                </div>
              )}
            </div>
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-3xl md:text-4xl font-bold text-slate-900">{profile.display_name}</h1>
                {onRenameProfile ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 text-slate-600"
                    onClick={() => {
                      setRenameValue(profile.display_name || "")
                      setRenameOpen(true)
                    }}
                  >
                    <PenSquare className="w-3.5 h-3.5" />
                    Edit name
                  </Button>
                ) : null}
                {profile.status ? (
                  <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 capitalize">{profile.status}</Badge>
                ) : null}
              </div>
              <p className="text-slate-600 text-sm md:text-base">
                {profile.primary_type ? formatStatusLabel(profile.primary_type) : "Profile"}{" "}
                {profile.organization_name ? (
                  <span className="text-slate-500">• Linked organization: {profile.organization_name}</span>
                ) : null}
              </p>
              <div className="flex flex-wrap gap-2">
                {profile.tags?.length
                  ? profile.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs capitalize">
                        {tag}
                      </Badge>
                    ))
                  : null}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarFileChange}
                />
                <input
                  ref={documentInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.txt,.rtf,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.heic,.heif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,application/rtf,text/rtf,image/jpeg,image/png,image/webp,image/gif,image/bmp,image/tiff,image/heic,image/heif"
                  className="hidden"
                  onChange={handleDocumentFileChange}
                />
                {isOrgProfile && onUseWebsiteLogo ? (
                  // For organizations, deriving the avatar from the org's own
                  // website logo is the suggested option (their real brand mark).
                  // It's the primary/highlighted button when a website is on file.
                  <Button
                    variant={hasWebsiteOnFile ? "default" : "outline"}
                    size="sm"
                    className="gap-2"
                    onClick={onUseWebsiteLogo}
                    disabled={isFetchingWebsiteLogo}
                    title={
                      hasWebsiteOnFile
                        ? "Use the organization's website logo"
                        : "No website on file — add one in Basic Information, or upload a photo"
                    }
                  >
                    {isFetchingWebsiteLogo ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Globe className="w-4 h-4" />
                    )}
                    {isFetchingWebsiteLogo ? "Fetching logo…" : "Use website logo"}
                  </Button>
                ) : null}
                {onUploadAvatar ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={handleAvatarButton}
                    disabled={isUploadingAvatar}
                  >
                    {isUploadingAvatar ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    {isUploadingAvatar ? "Uploading…" : "Upload Photo"}
                  </Button>
                ) : null}
                {onRequestAvatarAI ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={onRequestAvatarAI}
                    disabled={isRequestingAvatar}
                    title={isOrgProfile ? "Fallback: generate a logo with AI" : "Find or generate a photo with AI"}
                  >
                    {isRequestingAvatar ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    {isRequestingAvatar
                      ? "Locating…"
                      : isOrgProfile
                      ? "Generate with AI"
                      : "Use AI to find photo"}
                  </Button>
                ) : null}
                {onUploadDocument ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => documentInputRef.current?.click()}
                    disabled={isUploadingDocument}
                  >
                    {isUploadingDocument ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <UploadCloud className="w-4 h-4" />
                    )}
                    {isUploadingDocument ? "Uploading…" : "Upload Document"}
                  </Button>
                ) : null}
              </div>
              {isOrgProfile && onUseWebsiteLogo && !hasWebsiteOnFile ? (
                <p className="text-xs text-slate-500">
                  No website on file. Add the organization&apos;s website in Basic Information to pull its
                  logo automatically, or upload a photo / generate one with AI.
                </p>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full lg:max-w-xl">
            {headerMetrics.map(({ label, value, icon: Icon, tone, subtext }) => (
              <div key={label} className={`rounded-2xl border ${tone} px-4 py-3`}>
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide">{label}</div>
                <div className="flex items-center gap-2 mt-2 text-sm font-semibold text-slate-900">
                  <Icon className="w-4 h-4" />
                  <span>{value}</span>
                </div>
                {subtext ? <p className="mt-1 text-[11px] text-slate-500">{subtext}</p> : null}
              </div>
            ))}
          </div>
        </div>
        <div
          className={`flex flex-col gap-4 rounded-2xl border ${theme.banner} p-4 text-sm text-slate-900 md:flex-row md:items-center md:justify-between`}
        >
          <div className="flex items-start gap-3">
            <span className={`p-2 rounded-xl bg-white/70 shadow-sm ${theme.iconTone}`}>
              <Sparkles className="w-4 h-4" />
            </span>
            <div>
              <p className="font-semibold">Keep your profile complete and current</p>
              <p className="text-sm mt-1 text-blue-800">
                Each section below maps to what funders ask for. Edit manually or use AI assistance to fill gaps — a more
                complete profile means stronger, more accurate grant matches.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-start gap-3 md:flex-row md:items-center">
            <PipelinePotentialBreakdown
              profileId={profile?.id}
              profileName={profile?.display_name || profile?.organization_name || ""}
              formattedTotal={formattedFundsTotal}
              cardClassName={theme.pipelineCard}
              labelClassName={theme.pipelineLabel}
            />
            {onEditSection ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onEditSection("basic_information", getSection(sectionsMap, "basic_information")?.data ?? {})}
                >
                  Edit Basic Info
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onEditSection("narrative", getSection(sectionsMap, "narrative")?.data ?? {})}
                >
                  Update Narrative
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {onNavigateToPortals ? (
        <section>
          <button
            type="button"
            onClick={onNavigateToPortals}
            className="group w-full text-left rounded-3xl border border-slate-200 bg-white/80 backdrop-blur-sm shadow-sm p-6 md:p-7 flex items-center justify-between gap-4 transition hover:border-blue-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-200"
          >
            <div className="flex items-start gap-4">
              <span className="p-3 rounded-2xl bg-blue-50 text-blue-600 shrink-0">
                <KeyRound className="w-5 h-5" />
              </span>
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-slate-900">Portals &amp; Hamilton</h2>
                <p className="text-sm text-slate-600">
                  Open this profile&apos;s application portals and let Hamilton sign in, fill forms, and run
                  portal automations.
                </p>
              </div>
            </div>
            <ArrowRight className="w-5 h-5 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-blue-600" />
          </button>
        </section>
      ) : null}

      {isRealProfileId(profile.id) ? (
        <ProfileActionPlanCard
          profileId={profile.id}
          profileName={profile.display_name || profile.organization_name || ""}
        />
      ) : null}

      {isRealProfileId(profile.id) ? (
        <section>
          <ProfileAutomationsCard profileId={profile.id} />
        </section>
      ) : null}

      {billing ? (
        <section className="rounded-3xl border border-slate-200 bg-white/80 backdrop-blur-sm shadow-sm p-6 md:p-8 space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Billing Snapshot</h2>
              <p className="text-sm text-slate-600">
                {billing.is_pro_bono
                  ? "This profile is tracked as pro bono work. Time and expenses are logged but not invoiced."
                  : "Current tier and allowances based on the onboarding application. Admins can override at any time."}
              </p>
            </div>
            <Badge
              className={
                billing.is_pro_bono
                  ? "bg-violet-600 text-white text-xs"
                  : "bg-slate-900 text-white text-xs"
              }
            >
              {billing.is_pro_bono ? "Pro Bono Engagement" : billing.tier?.name ?? "Tier Pending"}
            </Badge>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Monthly Retainer</p>
              <p className="text-lg font-semibold text-slate-900 mt-1">
                {formatCurrencyFromCents(
                  billing.custom_monthly_cents ?? billing.tier?.base_monthly_cents ?? null,
                )}
              </p>
              {billing.discount_type && billing.discount_type !== "none" ? (
                <p className="text-[11px] text-slate-500 mt-1">
                  {billing.discount_type.replace(/_/g, " ")} discount ({billing.discount_percent ?? 0}%)
                </p>
              ) : null}
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Hourly Rate</p>
              <p className="text-lg font-semibold text-slate-900 mt-1">
                {formatCurrencyFromCents(
                  billing.custom_hourly_cents ?? billing.tier?.hourly_rate_cents ?? null,
                )}
              </p>
              {billing.assigned_reason ? (
                <p className="text-[11px] text-slate-500 mt-1">Reason: {billing.assigned_reason}</p>
              ) : null}
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Capabilities</p>
              <ul className="text-xs text-slate-600 space-y-1">
                {(billing.tier?.enable_pipeline_automation ? ["Pipeline automation insights"] : [])
                  .concat(billing.tier?.enable_item_funding ? ["Item funding discovery"] : [])
                  .concat(billing.tier?.enable_document_ai ? ["AI document enrichment"] : [])
                  .concat(billing.is_pro_bono ? ["Document time logged but not invoiced"] : [])
                  .concat(!billing.tier ? ["Awaiting tier assignment"] : [])
                  .map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
              </ul>
            </div>
          </div>
          {billing.pro_bono_reason ? (
            <div className="rounded-2xl border border-violet-200 bg-violet-50/70 p-4 text-sm text-violet-900">
              Pro bono notes: {billing.pro_bono_reason}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-5">
        <div className="flex items-center justify-between gap-2 text-sm text-slate-500">
          <span className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4" />
            {totalSections} sections defined • {completedSections} fully populated
          </span>
          <span>{lastUpdated}</span>
        </div>
        <div className={`grid ${gapClass} ${gridColumnsClass}`}>
          {orderedSectionKeys.map((sectionKey) => (
            <SectionPreview
              key={sectionKey}
              sectionKey={sectionKey}
              section={getSection(sectionsMap, sectionKey)}
              onEdit={onEditSection}
              onAskAI={onAskSection ? () => onAskSection(sectionKey) : undefined}
              onSaveField={onSaveField}
              isSaving={savingSectionKey === sectionKey}
              isAIProcessing={aiLoadingKey === sectionKey}
              onNavigateToUniversities={onNavigateToUniversities}
            />
          ))}
          {onSaveField ? (
            <SecondaryAddressCard
              value={getSection(sectionsMap, "basic_information")?.data?.secondary_address}
              onSave={(next) => onSaveField("basic_information", "secondary_address", next)}
              isSaving={savingSectionKey === "basic_information"}
            />
          ) : null}
        </div>
      </section>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit profile name</DialogTitle>
            <DialogDescription>
              This is the name shown across GrantFlow — billing, matching, and your profile list. For organizations,
              enter the legal or public organization name.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="profile-display-name">Profile / organization name</Label>
            <Input
              id="profile-display-name"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder="e.g. Church of God of Prophecy International Offices"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenameOpen(false)} disabled={isRenamingProfile}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={isRenamingProfile || !renameValue.trim()}
              onClick={async () => {
                const nextName = renameValue.trim()
                if (!nextName || !onRenameProfile) return
                await onRenameProfile(nextName)
                setRenameOpen(false)
              }}
            >
              {isRenamingProfile ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Saving…
                </>
              ) : (
                "Save name"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
