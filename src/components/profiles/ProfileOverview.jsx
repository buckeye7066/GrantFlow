import React, { useMemo, useRef } from "react"
import { format, formatDistanceToNow } from "date-fns"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  CalendarClock,
  ClipboardList,
  FileText,
  FolderOpen,
  HandCoins,
  HeartPulse,
  Home,
  MapPin,
  Medal,
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
} from "lucide-react"
import { SECTION_CONFIG } from "@/components/profiles/ProfileSectionEditor.jsx"
import { useDashboardPreferences } from "@/contexts/DashboardPreferencesContext.jsx"

const SECTION_ICONS = {
  basic_information: UserCircle,
  organization_details: Building2,
  financial_information: HandCoins,
  government_assistance: ShieldCheck,
  health_medical: HeartPulse,
  demographics: Users,
  family_life: Home,
  military_service: Medal,
  occupation: Briefcase,
  location_focus: MapPin,
  narrative: FileText,
}

function titleCase(value = "") {
  return value
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1))
}

function normalizeEntry([key, value]) {
  if (value === "" || value === null || value === undefined) {
    return null
  }
  if (Array.isArray(value) && value.length === 0) {
    return null
  }
  return [key, value]
}

const THEME_PRESETS = {
  blue: {
    metric: "bg-blue-50 text-blue-700 border-blue-200",
    subtleMetric: "bg-blue-50 text-blue-700 border-blue-100",
    banner: "border-blue-100 bg-blue-50/70",
    pipelineCard: "border-blue-200 bg-blue-50/80 text-blue-800",
    pipelineLabel: "text-blue-600",
    gradient: "bg-gradient-to-br from-blue-500 to-blue-600",
    iconTone: "text-blue-600",
  },
  emerald: {
    metric: "bg-emerald-50 text-emerald-700 border-emerald-200",
    subtleMetric: "bg-emerald-50 text-emerald-700 border-emerald-100",
    banner: "border-emerald-100 bg-emerald-50/70",
    pipelineCard: "border-emerald-200 bg-emerald-50/80 text-emerald-800",
    pipelineLabel: "text-emerald-600",
    gradient: "bg-gradient-to-br from-emerald-500 to-emerald-600",
    iconTone: "text-emerald-600",
  },
  violet: {
    metric: "bg-violet-50 text-violet-700 border-violet-200",
    subtleMetric: "bg-violet-50 text-violet-700 border-violet-100",
    banner: "border-violet-100 bg-violet-50/70",
    pipelineCard: "border-violet-200 bg-violet-50/80 text-violet-800",
    pipelineLabel: "text-violet-600",
    gradient: "bg-gradient-to-br from-violet-500 to-violet-600",
    iconTone: "text-violet-600",
  },
  amber: {
    metric: "bg-amber-50 text-amber-700 border-amber-200",
    subtleMetric: "bg-amber-50 text-amber-700 border-amber-100",
    banner: "border-amber-100 bg-amber-50/70",
    pipelineCard: "border-amber-200 bg-amber-50/80 text-amber-800",
    pipelineLabel: "text-amber-600",
    gradient: "bg-gradient-to-br from-amber-500 to-amber-600",
    iconTone: "text-amber-600",
  },
}

function renderValue(value) {
  if (typeof value === "boolean") {
    return (
      <Badge className={value ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-100 text-slate-600"}>
        {value ? "Yes" : "No"}
      </Badge>
    )
  }

  if (Array.isArray(value)) {
    return (
      <div className="flex flex-wrap justify-end gap-1">
        {value.map((item, index) => (
          <Badge key={`${item}-${index}`} variant="secondary" className="text-xs">
            {String(item)}
          </Badge>
        ))}
      </div>
    )
  }

  if (typeof value === "object") {
    return (
      <pre className="text-xs text-slate-600 bg-slate-50 rounded-md p-2 max-w-[280px] whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  }

  return <span className="text-sm text-slate-900">{String(value)}</span>
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

function SectionPreview({ sectionKey, section, onEdit, onAskAI, isSaving, isAIProcessing }) {
  const config = SECTION_CONFIG[sectionKey]
  const SectionIcon = SECTION_ICONS[sectionKey] ?? FolderOpen
  const dataEntries = Object.entries(section?.data ?? {})
    .map(normalizeEntry)
    .filter(Boolean)
  const hasData = dataEntries.length > 0

  const isInteractive = Boolean(onEdit) && !isSaving && !isAIProcessing

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
              <CardTitle className="text-base font-semibold text-slate-900">{config?.title ?? titleCase(sectionKey)}</CardTitle>
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
          <dl className="space-y-2">
            {dataEntries.slice(0, 8).map(([key, value]) => (
              <div key={key} className="flex items-start justify-between gap-4">
                <dt className="text-xs font-medium text-slate-500 uppercase tracking-wide">{titleCase(key)}</dt>
                <dd className="flex-1 text-right">{renderValue(value)}</dd>
              </div>
            ))}
            {dataEntries.length > 8 ? (
              <p className="text-xs text-slate-400">{`+${dataEntries.length - 8} more field${dataEntries.length - 8 === 1 ? "" : "s"} stored`}</p>
            ) : null}
          </dl>
        ) : (
          <p className="text-sm text-slate-500">
            No data captured yet. Use the editor or AI assist to fill out this section exactly as listed in the comprehensive
            application.
          </p>
        )}

        <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
          <span className="flex items-center gap-2">
            <CalendarClock className="w-3.5 h-3.5" />
            {section?.updated_at
              ? `Updated ${formatDistanceToNow(new Date(section.updated_at), { addSuffix: true })}`
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

export default function ProfileOverview({
  profile,
  onEditSection,
  savingSectionKey,
  onAskSection,
  aiLoadingKey,
  onUploadAvatar,
  onRequestAvatarAI,
  isUploadingAvatar,
  isRequestingAvatar,
  onUploadDocument,
  isUploadingDocument,
  fundsTotal = 0,
  billing = null,
}) {
  const { state: dashboardPrefs } = useDashboardPreferences()
  const theme = THEME_PRESETS[dashboardPrefs.colorTheme] ?? THEME_PRESETS.blue
  const columnMap = {
    1: "md:grid-cols-1",
    2: "md:grid-cols-2",
    3: "md:grid-cols-3",
  }
  const gridColumnsClass = columnMap[dashboardPrefs.layoutColumns] ?? "md:grid-cols-2"
  const gapClass = dashboardPrefs.layoutStyle === "compact" ? "gap-4" : "gap-6"
  const totalSections = useMemo(() => Object.keys(SECTION_CONFIG).length, [])
  const sectionsMap = useMemo(() => {
    const map = new Map()
    ;(profile.sections ?? []).forEach((section) => {
      map.set(section.section_key, section)
    })
    return map
  }, [profile.sections])

  const fileInputRef = useRef(null)
  const documentInputRef = useRef(null)

  const avatarInitials = useMemo(() => {
    const words = profile.display_name?.split(/\s+/g) ?? []
    if (!words.length) return "U"
    return words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join("")
  }, [profile.display_name])

  const formattedFundsTotal = useMemo(() => {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    })
    return formatter.format(Math.max(0, Math.round(fundsTotal)))
  }, [fundsTotal])

  const handleAvatarButton = () => {
    if (onUploadAvatar) {
      fileInputRef.current?.click()
    }
  }

  const handleAvatarFileChange = (event) => {
    const file = event.target.files?.[0]
    if (file && onUploadAvatar) {
      onUploadAvatar(file)
    }
    if (event.target) {
      event.target.value = ""
    }
  }

  const handleDocumentFileChange = (event) => {
    const file = event.target.files?.[0]
    if (file && onUploadDocument) {
      onUploadDocument(file)
    }
    if (event.target) {
      event.target.value = ""
    }
  }

  const completedSections = useMemo(() => {
    return Array.from(sectionsMap.values()).filter((section) => {
      const entries = Object.entries(section?.data ?? {}).map(normalizeEntry).filter(Boolean)
      return entries.length > 0
    }).length
  }, [sectionsMap])

  const lastUpdated = profile.updated_at ? format(new Date(profile.updated_at), "PPP p") : "Not recorded"
  const relativeUpdated = profile.updated_at
    ? formatDistanceToNow(new Date(profile.updated_at), { addSuffix: true })
    : null

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
        rateCents != null
          ? `${tierName} · ${rateCents === 0 ? "included" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(rateCents / 100)}/mo`
          : tierName,
      icon: HandCoins,
      tone: billing.is_pro_bono
        ? "bg-violet-50 text-violet-700 border-violet-200"
        : "bg-slate-50 text-slate-600 border-slate-200",
      subtext: discountLabel,
    })
  }

  const orderedSectionKeys = Object.keys(SECTION_CONFIG)

  return (
    <div className="space-y-10">
      <section className="rounded-3xl border border-slate-200 bg-white/80 backdrop-blur-sm shadow-sm p-6 md:p-8 space-y-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-5">
            <div className="relative">
              {profile.avatar_url ? (
                <img
                  src={profile.avatar_url}
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
                {profile.status ? (
                  <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 capitalize">{profile.status}</Badge>
                ) : null}
              </div>
              <p className="text-slate-600 text-sm md:text-base">
                {profile.primary_type ? titleCase(profile.primary_type) : "Profile"}{" "}
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
                  accept=".pdf,.doc,.docx,.txt,.rtf,.jpg,.jpeg,.png,.heic,.heif,image/*"
                  className="hidden"
                  onChange={handleDocumentFileChange}
                />
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
                  >
                    {isRequestingAvatar ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    {isRequestingAvatar ? "Locating…" : "Use AI to find photo"}
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
              <p className="font-semibold">Comprehensive application parity in progress</p>
              <p className="text-sm mt-1 text-blue-800">
                Each section below mirrors the Base44 schema. Edit manually or use AI assistance in the section editor to keep
                data synced between local and production deployments.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-start gap-3 md:flex-row md:items-center">
            <div className={`rounded-2xl border px-4 py-3 ${theme.pipelineCard}`}>
              <p className={`text-xs font-medium uppercase tracking-wide ${theme.pipelineLabel}`}>Pipeline Potential</p>
              <p className="text-2xl font-bold mt-1">{formattedFundsTotal}</p>
            </div>
            {onEditSection ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onEditSection("basic_information", sectionsMap.get("basic_information")?.data ?? {})}
                >
                  Edit Basic Info
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onEditSection("narrative", sectionsMap.get("narrative")?.data ?? {})}
                >
                  Update Narrative
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </section>

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
              section={sectionsMap.get(sectionKey)}
              onEdit={onEditSection}
              onAskAI={onAskSection ? () => onAskSection(sectionKey) : undefined}
              isSaving={savingSectionKey === sectionKey}
              isAIProcessing={aiLoadingKey === sectionKey}
            />
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white/70 p-6 space-y-3 text-sm text-slate-600">
        <div className="flex items-center gap-2 text-slate-800 font-semibold uppercase tracking-wide text-xs">
          <PenSquare className="w-4 h-4" />
          Editing roadmap
        </div>
        <ul className="list-disc list-inside space-y-1">
          <li>Autosave each section directly to `/api/profiles/:id/sections/:key` with validation feedback.</li>
          <li>Surface AI suggestions per section seeded by uploaded documents and existing profile context.</li>
          <li>Introduce audit history, reviewer assignments, and collaborative comments ahead of grants intake.</li>
        </ul>
      </section>
    </div>
  )
}
