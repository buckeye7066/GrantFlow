import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { v4 as uuid } from "uuid"
import { Loader2, Search, Send, Sparkles, Plus, Shield, Database, Activity, Code, Wrench, ChevronDown, ChevronRight, Compass, FolderOpen, Kanban, User, Monitor, Trash2, RotateCcw, MapPin, CheckSquare, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatDistanceToNow } from "date-fns"
import { toast } from "@/components/ui/use-toast"
import { useAuthStore, normalizeUserAdmin } from "@/stores/authStore"
import { createLogger } from "@/utils/logger"
import {
  createAnyaSession,
  deleteAnyaSession,
  getAnyaMessages,
  postAnyaMessage,
  listAnyaTools,
  invokeAnyaTool,
  getAnyaTasks,
  createAnyaTask,
  updateAnyaTask,
  getAnyaRun,
  cancelAnyaRun,
} from "@/lib/anyaClient"
import { bootstrapAnyaSession } from "./anyaSession"
import { enqueueAnyaBackgroundRun, subscribeAnyaBackground } from "@/lib/anyaBackgroundQueue"
import { useAnyaContext, serializeAnyaContext } from "@/contexts/AnyaContext"
import { createPageUrl } from "@/utils"
import { useFeatureFlags } from "@/lib/featureFlags"
import { apiFetch } from "@/api/client"
import { getProfile } from "@/api/profiles"
import { isRealProfileId } from "@/api/profileIdGuards"
import { getNextIncompleteStep } from "@/utils/workspaceSteps"
import { useQuery, useQueryClient } from "@tanstack/react-query"
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
import { Checkbox } from "@/components/ui/checkbox"
import { useLanguage } from "@/i18n"

// ---------------------------------------------------------------------------
// Onboarding constants
// ---------------------------------------------------------------------------

const ONBOARDING_LS_KEY = "anya_onboarded"
const NUDGE_SS_KEY = "anya_nudge_shown"
const TOTAL_PROFILE_SECTIONS = 21

// ---------------------------------------------------------------------------
// Chat appearance (user-directed via Anya's chat.setAppearance tool)
// ---------------------------------------------------------------------------
// The backend resolves the user's ask ("dark mode", "#1e293b") into a full
// contrast-checked palette and persists it on the assistant message
// (tool_name 'chat.setAppearance'). The panel applies the LAST such payload in
// history; localStorage is only a warm-start cache so the colors don't flash
// back to default while messages load.

// Scoped per USER id — a shared computer must never carry one account's chat
// colors into another account's session (adversarial-review finding).
function appearanceStorageKey(userId) {
  return `anya_chat_appearance_v1:${userId || "anon"}`
}

function loadStoredAppearance(userId) {
  try {
    const raw = window.localStorage.getItem(appearanceStorageKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && typeof parsed.panelBg === "string" ? parsed : null
  } catch {
    return null
  }
}

function persistAppearance(userId, appearance) {
  try {
    if (appearance) window.localStorage.setItem(appearanceStorageKey(userId), JSON.stringify(appearance))
    else window.localStorage.removeItem(appearanceStorageKey(userId))
  } catch {
    /* storage unavailable (private mode) — colors still apply for this view */
  }
}

// Anya onboarding chips. The display labels here intentionally read
// like spoken English ("Volunteer Fire / EMS") rather than the
// canonical snake_case ids from the registry; the lookup below
// canonicalizes them on the way to /api/profiles.
const PROFILE_TYPES = [
  "Individual",
  "Family",
  "Student",
  "Nonprofit",
  "Church",
  "Ministry",
  "Public School",
  "School District",
  "Classroom Teacher",
  "Library",
  "Volunteer Fire / EMS",
  "Small Business",
  "County Government",
  "City / Municipality",
  "Public Health Department",
  "Tribal Government",
  "Food Pantry",
  "Animal Rescue",
  "Medical / Health Need",
  "Other",
]

const LIFE_SITUATIONS = [
  "Currently on strike",
  "Recently laid off",
  "Caregiver",
  "Fleeing domestic violence",
  "Recently released",
  "Disaster survivor",
  "Chronic illness",
  "Foster care alumni",
  "Refugee/immigrant",
  "In recovery",
  "Experiencing homelessness",
]

// Maps onboarding display labels → backend primary_type canonical ids
// (matches shared/profileTypeOptions.js). The backend further
// canonicalizes through profileTypeRegistry.resolveProfileType so any
// alias here still resolves cleanly even if a label is renamed.
const PROFILE_TYPE_MAP = {
  Individual: "individual",
  Family: "family",
  Student: "student",
  Nonprofit: "nonprofit",
  Church: "church",
  Ministry: "ministry",
  "Public School": "public_school",
  "School District": "school_district",
  "Classroom Teacher": "classroom_teacher",
  Library: "library",
  "Volunteer Fire / EMS": "volunteer_fire_department",
  "Small Business": "business",
  "County Government": "county_government",
  "City / Municipality": "municipality",
  "Public Health Department": "public_health_department",
  "Tribal Government": "tribal_government",
  "Food Pantry": "food_pantry",
  "Animal Rescue": "animal_rescue",
  "Medical / Health Need": "medical_need",
  Other: "individual",
}

// Maps life situation labels → profile section field patches
function situationsToSectionPatches(situations) {
  const financial = {}
  const employment = {}
  const housing = {}
  const health = {}
  const demographics = {}

  for (const s of situations) {
    switch (s) {
      case "Currently on strike":
      case "Recently laid off":
        employment.employment_status = "unemployed"
        financial.displaced_worker = true
        break
      case "Caregiver":
        demographics.is_caregiver = true
        break
      case "Fleeing domestic violence":
        financial.financial_need_level = "high"
        housing.housing_status = "unstable"
        break
      case "Recently released":
        demographics.recently_incarcerated = true
        break
      case "Disaster survivor":
        financial.financial_need_level = "high"
        break
      case "Chronic illness":
        health.has_chronic_condition = true
        break
      case "Foster care alumni":
        demographics.foster_care_alumni = true
        break
      case "Refugee/immigrant":
        demographics.is_refugee_or_immigrant = true
        break
      case "In recovery":
        health.in_recovery = true
        break
      case "Experiencing homelessness":
        housing.housing_status = "homeless"
        financial.financial_need_level = "high"
        break
    }
  }

  const patches = []
  if (Object.keys(financial).length) patches.push({ section_key: "financial_information", data: financial })
  if (Object.keys(employment).length) patches.push({ section_key: "employment", data: employment })
  if (Object.keys(housing).length) patches.push({ section_key: "housing", data: housing })
  if (Object.keys(health).length) patches.push({ section_key: "health_medical", data: health })
  if (Object.keys(demographics).length) patches.push({ section_key: "demographics", data: demographics })
  return patches
}

const US_STATES = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut",
  "Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa",
  "Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan",
  "Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire",
  "New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio",
  "Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota",
  "Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia",
  "Wisconsin","Wyoming","District of Columbia",
]

// ---------------------------------------------------------------------------
// Onboarding step component
// ---------------------------------------------------------------------------

function OnboardingFlow({ step, onAdvance, onboarding, t, languages, onPickLanguage }) {
  const { profileType, setProfileType, situations, setSituations, state, setState } = onboarding

  const toggleSituation = (item) => {
    setSituations((prev) =>
      prev.includes(item) ? prev.filter((s) => s !== item) : [...prev, item]
    )
  }

  const AnyaBubble = ({ children }) => (
    <div className="rounded-lg border border-blue-200 bg-blue-50/80 px-3 py-2 text-sm text-slate-800 shadow-sm">
      <div className="flex items-center gap-2 pb-1 text-xs text-slate-600">
        <Badge variant="secondary" className="text-[11px] uppercase tracking-wide">Anya</Badge>
      </div>
      <div className="whitespace-pre-wrap leading-relaxed">{children}</div>
    </div>
  )

  // VERY FIRST onboarding step: pick a language. Shown in a bilingual-safe way
  // (each option in its own script) so the user can self-select regardless of
  // the language they currently read. Picking one immediately switches the app
  // and persists the choice, then advances to the welcome step.
  if (step === "language") {
    return (
      <div className="flex flex-col gap-4 p-4">
        <AnyaBubble>
          {`${t("language.picker.title")} · ${t("language.picker.subtitle")}`}
        </AnyaBubble>
        <div className="flex flex-wrap gap-2">
          {languages.map((lang) => (
            <button
              key={lang.code}
              type="button"
              lang={lang.code}
              onClick={() => onPickLanguage(lang.code)}
              className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700"
            >
              {lang.nativeName}
            </button>
          ))}
        </div>
      </div>
    )
  }

  // Normalize the step to a number for numeric step comparisons. The step may
  // arrive as either a number (0-4) or, in unusual cases, a numeric string.
  // Coercing here means a step of "0" still matches the welcome step below
  // instead of falling through to unreachable code.
  const numericStep = typeof step === "string" ? Number(step) : step

  if (numericStep === 0) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <AnyaBubble>
          {`${t("anya.greeting")} ${t("anya.intro")}`}
        </AnyaBubble>
        <div className="flex justify-end">
          <Button size="sm" className="gap-2" onClick={() => onAdvance(1)}>
            {t("anya.letsGo")} →
          </Button>
        </div>
      </div>
    )
  }

  if (numericStep === 1) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <AnyaBubble>
          {t("anya.onboarding.whoTitle")}
        </AnyaBubble>
        <div className="flex flex-wrap gap-2">
          {PROFILE_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => {
                setProfileType(type)
                onAdvance(2)
              }}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                profileType === type
                  ? "border-purple-500 bg-purple-100 text-purple-800"
                  : "border-slate-200 bg-white text-slate-700 hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700"
              )}
            >
              {type}
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (numericStep === 2) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <AnyaBubble>
          {t("anya.onboarding.situationsTitle")}
        </AnyaBubble>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {LIFE_SITUATIONS.map((item) => (
            <label
              key={item}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm hover:border-purple-200 hover:bg-purple-50 transition-colors"
            >
              <Checkbox
                checked={situations.includes(item)}
                onCheckedChange={() => toggleSituation(item)}
                className="h-3.5 w-3.5"
              />
              <span>{item}</span>
            </label>
          ))}
        </div>
        <div className="flex justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => onAdvance(3)}>
            None of these
          </Button>
          <Button size="sm" onClick={() => onAdvance(3)}>
            Next →
          </Button>
        </div>
        {situations.length > 0 && (
          <p className="text-xs text-slate-500 italic">
            Thank you for sharing. I&apos;ll keep this in mind while finding resources that can genuinely help.
          </p>
        )}
      </div>
    )
  }

  if (numericStep === 3) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <AnyaBubble>
          {t("anya.onboarding.stateTitle")}
        </AnyaBubble>
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-slate-500 shrink-0" />
          <select
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="flex-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-purple-400"
          >
            <option value="">Select a state…</option>
            {US_STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={!state} onClick={() => onAdvance(4)}>
            Next →
          </Button>
        </div>
      </div>
    )
  }

  if (numericStep === 4) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <AnyaBubble>
          {t("anya.onboarding.allSet")}
        </AnyaBubble>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => {
              onAdvance(null)
              window.dispatchEvent(new CustomEvent("navigate", { detail: { path: createPageUrl("DiscoverGrants") + "?autorun=1" } }))
            }}
          >
            <Compass className="h-3.5 w-3.5" />
            {t("anya.onboarding.findMatches")} →
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              onAdvance(null)
              window.dispatchEvent(new CustomEvent("navigate", { detail: { path: createPageUrl("MyProfiles") } }))
            }}
          >
            <User className="h-3.5 w-3.5" />
            {t("anya.onboarding.fillMoreDetails")}
          </Button>
        </div>
      </div>
    )
  }

  return null
}

const MessageBubble = React.memo(function MessageBubble({ message, appearance }) {
  const isAssistant = message.role === "assistant"
  const isAppearanceUpdate = message.tool_name === "chat.setAppearance"
  // Inline styles win over the static Tailwind palette only when the user has
  // asked Anya for different chat colors; otherwise the stock look is untouched.
  const bubbleStyle = appearance
    ? {
        background: isAssistant ? appearance.assistantBubbleBg : appearance.userBubbleBg,
        borderColor: appearance.border,
        color: isAssistant ? appearance.assistantText : appearance.userText,
      }
    : undefined
  const metaStyle = appearance ? { color: appearance.mutedText } : undefined
  return (
    <div
      className={cn(
        // min-w-0 + overflow-hidden keep a bubble from being widened by a long
        // unbreakable token; the panel hugs the viewport's right edge, so any
        // overflow here would be clipped off-screen ("half-readable menu").
        "min-w-0 max-w-full overflow-hidden rounded-lg border px-3 py-2 text-sm shadow-sm transition",
        isAssistant
          ? "border-blue-200 bg-blue-50/80 text-slate-800"
          : "border-slate-200 bg-white text-slate-700",
      )}
      style={bubbleStyle}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-slate-600 pb-1" style={metaStyle}>
        <Badge variant={isAssistant ? "secondary" : "outline"} className="text-[11px] uppercase tracking-wide">
          {isAssistant ? "Anya" : "You"}
        </Badge>
        <span>
          {message.created_at
            ? formatDistanceToNow(new Date(message.created_at), { addSuffix: true })
            : "now"}
        </span>
      </div>
      {/* break-words wraps long URLs / unbroken tokens so Anya's reply never
          runs past the right edge of the panel. */}
      <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
      {isAppearanceUpdate ? (
        <div className="mt-2 text-xs text-slate-600" style={metaStyle}>
          🎨 {message.tool_payload?.description || "Chat colors updated."}
        </div>
      ) : message.tool_name ? (
        <div className="mt-2 space-y-2 text-xs text-slate-600" style={metaStyle}>
          <div>
            Tool: <span className="font-mono text-xs text-slate-700" style={metaStyle}>{message.tool_name}</span>
          </div>
          {message.tool_payload ? (
            <div className="max-h-48 overflow-auto rounded-md border border-slate-200 bg-white/80 p-2 text-xs text-slate-800">
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(message.tool_payload, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

function resolvePageName(pathname) {
  if (!pathname) return null
  const path = pathname.toLowerCase()
  if (path === "/" || path === "/dashboard" || path.startsWith("/dashboard")) return "Dashboard"
  if (path.startsWith("/discover") || path.startsWith("/grants")) return "Discovery"
  if (path.startsWith("/pipeline")) return "Pipeline"
  if (path.startsWith("/proposals")) return "Proposals"
  if (path.startsWith("/applications")) return "Applications"
  if (path.startsWith("/profile")) return "Profile"
  if (path.startsWith("/settings")) return "Settings"
  return null
}

export default function AnyaChat({ profileId, currentPage: currentPageProp, initialSessionOptions, prefillMessage, prefillHidden = false, onPrefillConsumed }) {
  const user = useAuthStore((state) => state.user)
  const profiles = useAuthStore((state) => state.profiles)
  // Accept every admin shape the auth store normalizes (is_admin snake_case,
  // isAdmin camelCase from JWT payloads, role === 'admin', roles array).
  // Previously we hard-coded `user.is_admin`, which greyed out admin-only
  // quick actions when the user object carried the camelCase flag from a
  // fresh `/api/auth/me` bootstrap — violating Anya goals 4 and 8.
  const isAdmin = normalizeUserAdmin(user)
  const { t, setLanguage, languages } = useLanguage()
  // Filter out the UI-only admin sentinel ('__admin__') — it is NOT a real
  // profile UUID. Leaking it into the Anya bootstrap causes createSession to
  // fall back to a profile-less session while `findExisting` below keeps
  // looking for `profile_id === '__admin__'`, which never matches → infinite
  // createSession loop → `isLoading` stays true → the Admin Tools button
  // stays disabled (Anya goals 4, 6, 8).
  const effectiveProfileId = profileId && profileId !== '__admin__' ? profileId : null
  const [isUnavailable, setIsUnavailable] = useState(false)
  const queryClient = useQueryClient()

  // Read the SAME profile detail the Workspace page reads (identical query key
  // + fn → react-query dedupes to one fetch and one cached object). This lets
  // Anya's next-step guidance come from the exact same object the pulsing step
  // cards use, so the two can never disagree about the next logical step.
  const { data: workspaceProfile } = useQuery({
    queryKey: ["profile", effectiveProfileId],
    queryFn: () => getProfile(effectiveProfileId),
    enabled: Boolean(effectiveProfileId) && isRealProfileId(effectiveProfileId),
    staleTime: 30_000,
  })
  const log = useMemo(() => createLogger("AnyaChat"), [])
  const location = useLocation()
  const currentPage = currentPageProp ?? resolvePageName(location?.pathname) ?? "Unknown"

  // ---------------------------------------------------------------------------
  // First-run / onboarding detection
  // ---------------------------------------------------------------------------
  // The first-run chat-chips onboarding has been retired. New users go through
  // the dedicated /start conversational quiz with Anya before they ever see
  // the floating chat panel, so `isFirstRun` is always false here. The chip
  // wizard below remains in the file as dead code so this change stays
  // minimal; the next cleanup pass will excise it entirely.
  const isFirstRun = false

  // onboardingStep: null = not in onboarding; 'language' = first step; 0-4 = step index
  const [onboardingStep, setOnboardingStep] = useState(null)
  const onboardingStartedRef = useRef(false)

  // Onboarding data collected across steps
  const [obProfileType, setObProfileType] = useState("")
  const [obSituations, setObSituations] = useState([])
  const [obState, setObState] = useState("")

  // ---------------------------------------------------------------------------
  // Profile completeness nudge (shown once per session for returning users)
  // ---------------------------------------------------------------------------
  const [nudgeMessage, setNudgeMessage] = useState(null)

  const [sessionId, setSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  // Chat colors the user asked Anya for (null = stock look). Applied from the
  // newest chat.setAppearance payload in message history; cached in
  // localStorage (per user id) so a reload doesn't flash back to default.
  const [chatAppearance, setChatAppearance] = useState(() => loadStoredAppearance(user?.id))
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isSending, setIsSending] = useState(false)
  // A background reply is in flight (Anya is working out of band). Holds the
  // run_id so an open panel can show a "working…" line and clear it when the
  // matching reply-ready event arrives.
  const [awaitingRunId, setAwaitingRunId] = useState(null)
  // Live "watch her work" feed for the in-flight run + Stop/Escape state.
  const [runProgress, setRunProgress] = useState([])
  const [isStopping, setIsStopping] = useState(false)
  const [tools, setTools] = useState([])
  const [isLoadingTools, setIsLoadingTools] = useState(false)
  const [isCodeSearchOpen, setIsCodeSearchOpen] = useState(false)
  const [codeSearchForm, setCodeSearchForm] = useState({ query: "", scope: "" })
  const [isInvokingTool, setIsInvokingTool] = useState(false)
  const [isFetchingInsights, setIsFetchingInsights] = useState(false)
  const [tasks, setTasks] = useState([])
  const [isLoadingTasks, setIsLoadingTasks] = useState(false)
  const [isSavingTask, setIsSavingTask] = useState(false)
  const [taskForm, setTaskForm] = useState({ title: "", dueDate: "" })
  const [isTasksExpanded, setIsTasksExpanded] = useState(false)
  const [updatingTaskId, setUpdatingTaskId] = useState(null)
  const [isAdminToolsOpen, setIsAdminToolsOpen] = useState(false)
  const [adminToolForm, setAdminToolForm] = useState({})
  const [invokingAdminTool, setInvokingAdminTool] = useState(null)
  const isSendingRef = useRef(false)
  // Tracks the last prefill text we actually consumed, so a prefill message is
  // never re-sent across a sessionId change even if the parent hasn't cleared
  // the prop yet (e.g. on "New conversation").
  const consumedPrefillRef = useRef(null)

  // ---------------------------------------------------------------------------
  // Auto-start onboarding when first-run and the panel mounts
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isFirstRun) return
    if (onboardingStartedRef.current) return
    onboardingStartedRef.current = true
    // Language is the VERY FIRST onboarding step.
    setOnboardingStep("language")
  }, [isFirstRun])

  // First onboarding step: language. Switch the app immediately + persist, then
  // continue to the welcome step.
  const handlePickLanguage = useCallback((code) => {
    try {
      setLanguage(code)
    } catch (err) {
      // Surface the failure in logs rather than silently swallowing it; the
      // provider is always present at app root so this should be rare.
      log.warn("[onboarding] setLanguage failed:", err?.message ?? err)
    }
    setOnboardingStep(0)
  }, [setLanguage, log])

  // Handle advancing onboarding steps (null = complete → persist to profile)
  const handleOnboardingAdvance = useCallback(async (nextStep) => {
    if (nextStep !== null) {
      setOnboardingStep(nextStep)
      return
    }

    // Onboarding complete — persist collected data to the backend profile.
    // Do NOT mark onboarding done yet: the flag is only set after a confirmed
    // write below, so a failed save re-prompts the wizard instead of silently
    // claiming "I've saved your profile" with nothing persisted.
    setOnboardingStep(null)

    try {
      const activeProfile =
        (profiles ?? []).find((p) => String(p.id) === String(effectiveProfileId)) ??
        (profiles ?? [])[0]

      const primaryType = PROFILE_TYPE_MAP[obProfileType] || "individual"

      let profileId = activeProfile?.id
      // Guard against a truthy-but-invalid id (e.g. '__admin__' or a malformed
      // string) being used to construct API endpoints. If we have a value that
      // does NOT pass the real-id check, fail loudly instead of silently routing
      // to create — except when it's falsy (no profile yet), which we handle by
      // creating below.
      if (profileId && !isRealProfileId(profileId)) {
        throw new Error('[onboarding] active profile has an invalid (non-routable) id')
      }
      if (!isRealProfileId(profileId)) {
        // No real profile yet (or admin sentinel) — create one with collected type.
        // The admin sentinel is never a routable id, so we always promote to "create".
        const created = await apiFetch("/api/profiles", {
          method: "POST",
          body: JSON.stringify({
            display_name: user?.name || user?.email || "My Profile",
            primary_type: primaryType,
          }),
        })
        // Validate response shape explicitly — distinguish "no response body"
        // from "response present but missing id" so an API contract mismatch is
        // not masked by the generic guard below.
        if (!created || typeof created !== "object") {
          throw new Error('[onboarding] profile create returned no response body')
        }
        const createdId = created.id ?? created?.data?.id ?? null
        if (!createdId) {
          throw new Error('[onboarding] profile create response missing id field')
        }
        profileId = createdId
      } else {
        // Update existing profile's primary_type
        await apiFetch(`/api/profiles/${profileId}`, {
          method: "PUT",
          body: JSON.stringify({ primary_type: primaryType }),
        })
      }

      if (!isRealProfileId(profileId)) {
        // Defensive: createProfile must return a real id; if it didn't, abort
        // before touching `/api/profiles/${id}/...` endpoints with junk.
        throw new Error('[onboarding] profile create did not return a routable id')
      }

      // Persist state → basic_information section
      if (obState) {
        await apiFetch(`/api/profiles/${profileId}/sections/basic_information`, {
          method: "PUT",
          body: JSON.stringify({ data: { state: obState }, updated_by: "anya-onboarding" }),
        })
      }

      // Persist life situations → relevant sections.
      // Use Promise.allSettled so a single failing section update does not abort
      // the others (avoids leaving the profile in a worse partial state than
      // necessary) and lets us report exactly which sections failed.
      const patches = situationsToSectionPatches(obSituations)
      const results = await Promise.allSettled(
        patches.map((p) =>
          apiFetch(`/api/profiles/${profileId}/sections/${p.section_key}`, {
            method: "PUT",
            body: JSON.stringify({ data: p.data, updated_by: "anya-onboarding" }),
          })
        )
      )
      const failedPatches = results
        .map((r, idx) => ({ r, section: patches[idx]?.section_key }))
        .filter(({ r }) => r.status === "rejected")
      if (failedPatches.length > 0) {
        const failedSections = failedPatches.map(({ section }) => section).filter(Boolean)
        for (const { r, section } of failedPatches) {
          log.warn(`[onboarding] section patch failed (${section}):`, r.reason?.message ?? r.reason)
        }
        // Surface a partial-save error so the user knows exactly what to revisit
        // and the onboarding flag is NOT set (handled by the throw below).
        throw new Error(
          `[onboarding] failed to persist ${failedSections.length} section(s): ${failedSections.join(", ")}`
        )
      }

      // Write confirmed — now it is honest to mark onboarding complete.
      localStorage.setItem(ONBOARDING_LS_KEY, "1")

      // Refresh profile data across the app
      queryClient.invalidateQueries({ queryKey: ["profiles"] })
      queryClient.invalidateQueries({ queryKey: ["profile"] })

      log.info("[onboarding] Profile data persisted", { profileId, primaryType, state: obState, situations: obSituations.length })
    } catch (err) {
      // Persistence failed — surface it and leave onboarding UNmarked so the user
      // can retry rather than being told their profile was saved when it wasn't.
      // This single catch covers profile create/update, state persistence, and
      // the life-situation section patches so any failure is reported to the user.
      log.warn("[onboarding] Failed to persist profile data:", err.message)
      toast({
        variant: "destructive",
        title: "Couldn't fully save your profile",
        description: "Some of your details may not have been saved. Please review and finish from your profile page.",
      })
    }
  }, [profiles, effectiveProfileId, obProfileType, obState, obSituations, user, queryClient, log])

  // ---------------------------------------------------------------------------
  // Profile completeness nudge — show once per session for returning users
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (isFirstRun) return
    if (typeof window === "undefined") return
    if (sessionStorage.getItem(NUDGE_SS_KEY)) return

    // Preferred: the SAME next logical step the Workspace's pulsing step card
    // points at. Derived from the shared getNextIncompleteStep selector over the
    // same profile-detail object, so Anya's nudge and the pulsing card agree by
    // construction. Only fires when we actually have the profile detail loaded.
    if (workspaceProfile) {
      const nextStep = getNextIncompleteStep(workspaceProfile)
      if (nextStep) {
        setNudgeMessage(nextStep.anyaHint)
        sessionStorage.setItem(NUDGE_SS_KEY, "1")
      }
      // Every step complete → nothing to nudge; don't fall through to the
      // coarser section-% tip (it would contradict the "all done" state).
      return
    }

    // Fallback (no profile detail yet, e.g. Anya open on a non-profile page):
    // the coarse section-completeness tip from the profiles list.
    if (!profiles || profiles.length === 0) return
    const activeProfile =
      profiles.find((p) => String(p.id) === String(effectiveProfileId)) ?? profiles[0]
    if (!activeProfile) return

    const sectionsComplete = Number(activeProfile?.sections_complete ?? 0)
    // Clamp so the copy never goes nonsensical if the backend reports more
    // sections than TOTAL_PROFILE_SECTIONS (or the constant drifts).
    const rawPct = Math.round((sectionsComplete / TOTAL_PROFILE_SECTIONS) * 100)
    const pct = Math.max(0, Math.min(100, rawPct))
    if (pct < 50) {
      const missingSections = Math.max(0, TOTAL_PROFILE_SECTIONS - sectionsComplete)
      const nudge = `Quick tip: Your profile is ${pct}% complete. Adding ${missingSections} more section${missingSections === 1 ? "" : "s"} would unlock more matches. Want me to guide you there?`
      setNudgeMessage(nudge)
      sessionStorage.setItem(NUDGE_SS_KEY, "1")
    }
  }, [isFirstRun, profiles, effectiveProfileId, workspaceProfile])

  const hasMessages = messages.length > 0
  const hasTasks = tasks.length > 0
  const hasCodeSearchTool = useMemo(
    () => tools.some((tool) => tool.name === "code.search"),
    [tools],
  )
  const hasGrantTool = useMemo(
    () => tools.some((tool) => tool.name === "grants.summarizeMatches"),
    [tools],
  )
  const hasQuickActions = hasCodeSearchTool || hasGrantTool
  
  const adminTools = useMemo(() => {
    if (!isAdmin) return {}

    const adminToolsList = tools.filter((tool) => tool.requiresAdmin)
    const categorized = new Set()

    const grouped = {
      diagnostics: adminToolsList.filter((t) => {
        const match = t.name === "admin.diagnostics" || t.name.startsWith("admin.system.")
        if (match) categorized.add(t.name)
        return match
      }),
      health: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.health.")
        if (match) categorized.add(t.name)
        return match
      }),
      crawler: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.crawler.")
        if (match) categorized.add(t.name)
        return match
      }),
      autonomous: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.anya.") || t.name.startsWith("admin.items.")
        if (match) categorized.add(t.name)
        return match
      }),
      code: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.code.")
        if (match) categorized.add(t.name)
        return match
      }),
      functions: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.functions.")
        if (match) categorized.add(t.name)
        return match
      }),
      database: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.db.")
        if (match) categorized.add(t.name)
        return match
      }),
      brain: adminToolsList.filter((t) => {
        const match = t.name.startsWith("admin.brain.")
        if (match) categorized.add(t.name)
        return match
      }),
      other: adminToolsList.filter((t) => !categorized.has(t.name)),
    }

    return grouped
  }, [tools, isAdmin])
  
  const hasAdminTools = useMemo(() => {
    return isAdmin && Object.values(adminTools).some((group) => group.length > 0)
  }, [isAdmin, adminTools])
  
  const sortedTasks = useMemo(() => {
    if (tasks.length === 0) return []
    const statusWeight = {
      open: 0,
      in_progress: 1,
      completed: 2,
      cancelled: 3,
    }
    const safeTime = (value) => {
      const t = new Date(value).getTime()
      return Number.isNaN(t) ? 0 : t
    }
    return [...tasks].sort((a, b) => {
      const aWeight = statusWeight[a.status] ?? 99
      const bWeight = statusWeight[b.status] ?? 99
      if (aWeight !== bWeight) return aWeight - bWeight
      if (a.due_date && b.due_date) {
        if (a.due_date < b.due_date) return -1
        if (a.due_date > b.due_date) return 1
      } else if (a.due_date && !b.due_date) {
        return -1
      } else if (!a.due_date && b.due_date) {
        return 1
      }
      return safeTime(a.created_at) - safeTime(b.created_at)
    })
  }, [tasks])
  const openTaskCount = useMemo(
    () => tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled").length,
    [tasks],
  )

  const refreshMessages = useCallback(
    async (targetSessionId) => {
      const effectiveId = targetSessionId ?? sessionId
      if (!effectiveId) return
      try {
        const history = await getAnyaMessages(effectiveId)
        setMessages(Array.isArray(history) ? history : [])
      } catch (error) {
        console.error("[AnyaChat] refresh failed", error)
        // Non-fatal: keep existing messages visible; Anya header already shows status.
      }
    },
    [sessionId],
  )

  const refreshTasks = useCallback(
    async (targetSessionId, { withLoading = false } = {}) => {
      const effectiveId = targetSessionId ?? sessionId
      if (!effectiveId) return
      try {
        if (withLoading) setIsLoadingTasks(true)
        const sessionTasks = await getAnyaTasks(effectiveId)
        setTasks(Array.isArray(sessionTasks) ? sessionTasks : [])
      } catch (error) {
        console.error("[AnyaChat] refresh tasks failed", error)
      } finally {
        if (withLoading) setIsLoadingTasks(false)
      }
    },
    [sessionId],
  )

  useEffect(() => {
    let isMounted = true
    async function bootstrap() {
      setIsLoading(true)
      // Clear any prior thread synchronously on (re)bootstrap so a profile
      // switch never momentarily shows the previous profile's messages while
      // the new session is being created. Also drop any half-typed input and
      // transient nudge so the new profile's conversation starts truly fresh.
      setMessages([])
      setTasks([])
      setInput("")
      setNudgeMessage(null)
      setAwaitingRunId(null)
      try {
        // Resume a specific prior session — ONLY when the user explicitly asked
        // to (e.g. tapped "Open" on a background-reply ping, which sets
        // resumeSessionId). This is the single sanctioned exception to the
        // "fresh panel on every open" rule: the user wants to read that exact
        // answer, so we load that thread instead of minting a new one.
        const resumeSessionId = initialSessionOptions?.resumeSessionId ?? null
        if (resumeSessionId) {
          if (!isMounted) return
          setSessionId(resumeSessionId)
          await refreshMessages(resumeSessionId)
          await refreshTasks(resumeSessionId, { withLoading: true })
          return
        }
        // OWNER REQUIREMENT: "Each time Anya is opened, the past conversation
        // needs to be deleted so it doesn't bleed over. It also needs to stay
        // profile aware."
        //
        // The Anya panel lives inside a Radix Sheet/Dialog portal, so closing
        // it unmounts <AnyaChat> and re-opening remounts it fresh — local React
        // `messages` state already resets to []. The bleed-over came from THIS
        // bootstrap: it used to resume the most recent stored session for the
        // current profile (`findExisting`) and reload its prior messages via
        // `refreshMessages`, repopulating the just-cleared thread with the last
        // conversation.
        //
        // Fix: on every open we mint a BRAND-NEW session scoped to the current
        // profile and DO NOT load any prior messages. `createSession` always
        // inserts a fresh row (randomUUID), so past sessions stay stored on the
        // server (audit history is preserved — nothing is destructively purged);
        // they simply never resurface in the opened panel. Profile-awareness is
        // kept by threading `effectiveProfileId` into the new session and (when
        // `profileId` changes) re-running this effect to start a fresh,
        // profile-correct conversation. The create-fresh + profile-missing
        // fallback lives in the testable `bootstrapAnyaSession` helper
        // (./anyaSession.js).
        const { session: activeSession } = await bootstrapAnyaSession({
          profileId: effectiveProfileId ?? null,
          title: initialSessionOptions?.title ?? undefined,
          metadata: initialSessionOptions?.metadata ?? undefined,
          createSession: createAnyaSession,
        })
        if (!isMounted) return
        setSessionId(activeSession?.id ?? null)
        // Start empty every open: we intentionally do NOT call refreshMessages
        // here — a brand-new session has no history, so the thread is clean and
        // no prior conversation bleeds in. Tasks load for the new (empty)
        // session, which is also fresh.
        if (activeSession?.id) {
          await refreshTasks(activeSession.id, { withLoading: true })
        }
      } catch (error) {
        console.error("[AnyaChat] bootstrap failed", error)
        setIsUnavailable(true)
        toast({
          variant: "destructive",
          title: "Unable to reach Anya",
          description: error instanceof Error ? error.message : "Please try again shortly.",
        })
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    if (effectiveProfileId || isAdmin) {
      bootstrap()
    } else {
      // No profile bound — surface a synthetic guidance message so Anya
      // fulfils Goal 10 (profile improvement) and Goal 14 (strategist).
      setMessages([
        {
          id: 'no-profile-guidance',
          role: 'assistant',
          created_at: new Date().toISOString(),
          content:
            'Hi! To get personalised grant matches I need a profile. Head to My Profiles to create or select one, then come back here and I can analyse your matches, flag gaps, and suggest next steps.',
        },
      ])
    }

    return () => {
      isMounted = false
    }
    // NOTE: `refreshMessages` / `refreshTasks` are intentionally excluded from
    // the dependency list. Both are useCallbacks that depend on `sessionId`;
    // including them would cause a feedback loop — bootstrap creates a session
    // → `sessionId` changes → callbacks get new identity → bootstrap re-fires
    // → creates another session → `isLoading` stays true → the Admin Tools
    // button stays disabled forever (Anya goals 4, 6, 8). Bootstrap only needs
    // to run when the profile identity or admin-ness changes.
  }, [effectiveProfileId, isAdmin, initialSessionOptions?.metadata, initialSessionOptions?.title, initialSessionOptions?.resumeSessionId])

  // Apply the newest chat.setAppearance payload from history. Covers every
  // path with one channel: sync replies, background replies (refreshMessages),
  // reloads, and other devices reading the same session. appearance: null in
  // the payload means "restore the default look".
  useEffect(() => {
    const last = [...messages]
      .reverse()
      .find((m) => m.tool_name === "chat.setAppearance" && m.tool_payload?.applied === true)
    if (!last) return
    const next = last.tool_payload.appearance ?? null
    setChatAppearance((current) => {
      if (JSON.stringify(current) === JSON.stringify(next)) return current
      persistAppearance(user?.id, next)
      return next
    })
  }, [messages, user?.id])

  // Live-update an OPEN panel when a background reply for THIS session lands.
  // (The toast ping in anyaBackgroundQueue handles the closed-panel case.)
  useEffect(() => {
    const unsubscribe = subscribeAnyaBackground((event) => {
      if (event?.type !== "reply-ready") return
      if (!sessionId || event.sessionId !== sessionId) return
      setAwaitingRunId((current) => (current === event.runId ? null : current))
      refreshMessages(sessionId)
    })
    return unsubscribe
  }, [sessionId, refreshMessages])

  // Poll the in-flight run for its live step feed, so the user WATCHES what
  // Anya is doing as she does it (and sees a Stop take effect). Only runs
  // while a background reply is pending; clears itself when the run resolves.
  useEffect(() => {
    if (!sessionId || !awaitingRunId) {
      setRunProgress([])
      setIsStopping(false)
      return undefined
    }
    let alive = true
    const tick = async () => {
      try {
        const run = await getAnyaRun(sessionId, awaitingRunId)
        if (!alive || !run) return
        setRunProgress(Array.isArray(run.progress) ? run.progress : [])
      } catch {
        /* transient poll failure — keep the last feed */
      }
    }
    tick()
    const timer = setInterval(tick, 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId, awaitingRunId])

  // Stop button / Escape — the owner rule: the user can halt Anya mid-task at
  // any time. Cooperative cancel: she stops before her next step; anything
  // already saved stays saved (her stop message says so).
  const handleStopRun = useCallback(async () => {
    if (!sessionId || !awaitingRunId || isStopping) return
    setIsStopping(true)
    try {
      await cancelAnyaRun(sessionId, awaitingRunId)
    } catch {
      setIsStopping(false)
    }
  }, [sessionId, awaitingRunId, isStopping])

  useEffect(() => {
    if (!awaitingRunId) return undefined
    const onKey = (event) => {
      if (event.key === "Escape") handleStopRun()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [awaitingRunId, handleStopRun])

  useEffect(() => {
    let isMounted = true
    async function loadTools() {
      setIsLoadingTools(true)
      try {
        const available = await listAnyaTools({ includeAdmin: isAdmin })
        if (isMounted) {
          setTools(Array.isArray(available) ? available : [])
        }
      } catch (error) {
        console.error("[AnyaChat] load tools failed", error)
        setIsUnavailable(true)
      } finally {
        if (isMounted) {
          setIsLoadingTools(false)
        }
      }
    }
    loadTools()
    return () => {
      isMounted = false
    }
  }, [isAdmin])

  const { anyaCopilotEnabled: copilotEnabled, anyaScreenshotEnabled: screenshotEnabled } = useFeatureFlags()
  const anyaContext = useAnyaContext()
  const pageContextPayload = useMemo(() => {
    // Phase 8/9 mission rule: every Anya request must carry the live page
    // context so anya.nextBestAction and other tools can ground answers in
    // what the user is actually looking at — current page, selected
    // profile, selected opportunity, selected application/step. The keys
    // here MUST match what the backend tool registry reads
    // (selectedOpportunityId, selectedApplicationId).
    const adapter = anyaContext?.adapter
    const ctx = {
      currentPage: currentPage ?? null,
      currentPath: location?.pathname ?? null,
      profileId: effectiveProfileId ?? null,
    }
    if (adapter) {
      if (adapter.pageType) ctx.pageType = adapter.pageType
      // Skip nullish values without dropping valid numeric 0.
      if (adapter.completion?.resultCount !== null && adapter.completion?.resultCount !== undefined) ctx.resultCount = adapter.completion.resultCount
      if (adapter.completion?.pipelineCount !== null && adapter.completion?.pipelineCount !== undefined) ctx.pipelineCount = adapter.completion.pipelineCount
      const primary = adapter.primaryEntityId ?? null
      if (primary) {
        if (adapter.pageType === 'grant_detail' || adapter.pageType === 'grant') {
          // A grant id is NOT an application id — only set the grant id so
          // backend tools reading selectedApplicationId aren't grounded on the
          // wrong entity.
          ctx.selectedGrantId = String(primary)
        } else if (adapter.pageType === 'opportunity' || adapter.pageType === 'discover_grants') {
          ctx.selectedOpportunityId = String(primary)
        } else {
          ctx.selectedEntityId = String(primary)
        }
      }
    }
    return ctx
  }, [anyaContext?.adapter, currentPage, location?.pathname, effectiveProfileId])

  // Keep a ref of the latest page context / consume callback so the prefill
  // effect can read fresh values without re-subscribing on every navigation
  // (which would risk re-firing the send). The ref always holds current values.
  const prefillSendDepsRef = useRef({ currentPage, pageContextPayload, onPrefillConsumed, refreshMessages })
  useEffect(() => {
    prefillSendDepsRef.current = { currentPage, pageContextPayload, onPrefillConsumed, refreshMessages }
  }, [currentPage, pageContextPayload, onPrefillConsumed, refreshMessages])

  // Auto-send a pre-filled message when the panel is opened with one (e.g. from zero-result guidance).
  // We guard against re-sending the same prefill across sessionId changes using
  // `consumedPrefillRef` (a per-text consumed marker) rather than relying solely
  // on the parent clearing the prop or the transient isSendingRef.
  useEffect(() => {
    if (!prefillMessage || !sessionId || isSendingRef.current) return
    const trimmed = prefillMessage.trim()
    if (!trimmed) return
    if (consumedPrefillRef.current === trimmed) return
    consumedPrefillRef.current = trimmed
    const { currentPage: cp, pageContextPayload: ctx, onPrefillConsumed: consume, refreshMessages: refresh } = prefillSendDepsRef.current
    if (typeof consume === "function") consume()
    isSendingRef.current = true
    setIsSending(true)
    const optimisticId = uuid()
    // A hidden prefill is Anya's PRIVATE script (interview seed / question
    // queue) — never paint it into the transcript. The server stamps it with
    // the anya_private_seed marker, which the render filter also hides.
    if (!prefillHidden) {
      setMessages((prev) => [
        ...prev,
        { id: optimisticId, session_id: sessionId, created_at: new Date().toISOString(), role: "user", content: trimmed },
      ])
    }
    postAnyaMessage(sessionId, trimmed, { currentPage: cp, pageContext: ctx, hidden: prefillHidden })
      .then((response) => {
        if (Array.isArray(response?.messages) && response.messages.length > 0) {
          setMessages((prev) => {
            const without = prev.filter((m) => m.id !== optimisticId)
            return [...without, ...response.messages]
          })
        } else {
          // No structured messages came back — log the reason so a backend/send
          // anomaly isn't silently masked, then fall back to a full refresh.
          console.warn("[AnyaChat] prefill send returned no messages; falling back to refresh", response)
          refresh(sessionId)
        }
      })
      .catch((err) => {
        console.error("[AnyaChat] prefill send failed:", err)
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
      })
      .finally(() => {
        isSendingRef.current = false
        setIsSending(false)
      })
  }, [prefillMessage, prefillHidden, sessionId])

  const navigate = useNavigate()
  const onboardingActions = useMemo(() => [
    { type: "navigate", label: "Create or select a profile", payload: { path: createPageUrl("MyProfiles") } },
    { type: "navigate", label: "Open Discover Grants", payload: { path: createPageUrl("DiscoverGrants") } },
    { type: "navigate", label: "Open Pipeline", payload: { path: createPageUrl("Pipeline") } },
  ], [])
  const nextStepActions = useMemo(() => {
    if (!copilotEnabled) return []
    const fromAdapter = anyaContext?.adapter?.suggestedActions
    if (fromAdapter && fromAdapter.length > 0) return fromAdapter.slice(0, 5)
    return onboardingActions
  }, [copilotEnabled, anyaContext?.adapter?.suggestedActions, onboardingActions])
  const runNextStepAction = useCallback(async (action) => {
    if (!action?.type) return
    try {
      if (action.type === "navigate" && action.payload?.path) {
        navigate(action.payload.path)
        toast({ title: "Opened", description: action.label })
        return
      }
      if (action.type === "invokeTool" && action.payload?.toolName && sessionId) {
        const params = { ...(action.payload.parameters || {}), profile_id: effectiveProfileId }
        await invokeAnyaTool(action.payload.toolName, params, { sessionId, pageContext: pageContextPayload })
        toast({ title: "Done", description: action.label })
        await refreshMessages(sessionId)
        return
      }
      if (action.type === "openModal" && action.payload) {
        toast({ title: "Action", description: action.label })
        return
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Action failed",
        description: err instanceof Error ? err.message : "Please try again.",
      })
    }
  }, [navigate, sessionId, effectiveProfileId, refreshMessages, pageContextPayload])
  const [isSendingContext, setIsSendingContext] = useState(false)
  const handleUseCurrentScreen = useCallback(async () => {
    if (!sessionId) return
    setIsSendingContext(true)
    try {
      const ctx = serializeAnyaContext(anyaContext)
      const text = "Here's my current screen context: " + JSON.stringify(ctx)
      // Carry the same grounding metadata every other request guarantees.
      await postAnyaMessage(sessionId, text, { currentPage, pageContext: pageContextPayload })
      toast({ title: "Context sent", description: "Anya can use this to tailor answers." })
      await refreshMessages(sessionId)
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to send context",
        description: err instanceof Error ? err.message : "Please try again.",
      })
    } finally {
      setIsSendingContext(false)
    }
  }, [sessionId, anyaContext, refreshMessages, currentPage, pageContextPayload])

  const [isClearingConversation, setIsClearingConversation] = useState(false)

  /** Clear messages locally (keeps the same session). Synchronous: nothing awaited. */
  const handleClearConversation = useCallback(() => {
    setMessages([])
    setTasks([])
    // Intentionally a local-only clear: the session and its server-side
    // history are preserved so the user can scroll back if they remount.
    // The toast copy is updated to set accurate expectations.
    toast({ title: "Conversation cleared", description: "Messages hidden locally. History is preserved on the server — use \"New conversation\" to start fresh." })
  }, [])

  /** Delete current session and start a brand-new one */
  const handleStartNewConversation = useCallback(async () => {
    setIsClearingConversation(true)
    try {
      if (sessionId) {
        try {
          await deleteAnyaSession(sessionId)
        } catch (_e) {
          // Deleting the old session is best-effort: a new session is created
          // below regardless. Inform the user the previous session may persist
          // server-side, but don't block starting fresh.
          log.warn('[AnyaChat] deleteAnyaSession failed (non-blocking)', _e)
          toast({
            title: "Previous session not removed",
            description: "We couldn't delete the old conversation on the server, but a new one has been started.",
          })
        }
      }
      setMessages([])
      setTasks([])
      setSessionId(null)
      // Allow the (possibly identical) prefill text to be sent again into the
      // new session if the parent intends it; otherwise the parent should have
      // cleared the prop. Reset the consumed marker so a deliberate re-prefill
      // works, but the marker still prevents accidental double-sends within a
      // single session.
      consumedPrefillRef.current = null
      const newSession = await createAnyaSession({ profileId: effectiveProfileId ?? undefined })
      setSessionId(newSession?.id ?? null)
      toast({ title: "New conversation started" })
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to start new conversation",
        description: err instanceof Error ? err.message : "Please try again.",
      })
    } finally {
      setIsClearingConversation(false)
    }
  }, [sessionId, effectiveProfileId, log])

  if (isUnavailable) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-sm text-slate-700 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full overflow-hidden bg-gradient-to-br from-purple-600 to-blue-600">
            <img src="/images/anya-avatar.svg" alt="Anya" className="h-full w-full object-cover" />
          </div>
          <div className="font-semibold text-slate-800">Anya is temporarily unavailable</div>
        </div>
        <div className="mt-2 text-xs text-slate-600">
          The core app is still working; we’re restoring Anya’s services in the background. Refresh in a minute.
        </div>
      </div>
    )
  }

  // Enable input/button as soon as we have a sessionId, even if messages are still loading
  const isDisabled = !sessionId

  async function handleSend() {
    const trimmed = input.trim()
    if (!trimmed || isDisabled) {
      return
    }
    // Synchronous ref guard prevents rapid double-sends before React re-renders the disabled state
    if (isSendingRef.current) return
    isSendingRef.current = true
    setIsSending(true)
    let optimisticId = null
    try {
      optimisticId = uuid()
      const optimisticMessage = {
        id: optimisticId,
        session_id: sessionId,
        created_at: new Date().toISOString(),
        role: "user",
        content: trimmed,
      }
      setMessages((prev) => [...prev, optimisticMessage])
      setInput("")

      // Send in BACKGROUND mode: the server persists the question, returns a
      // run_id immediately (202), and finishes the reply out of band. This is
      // what lets the user fire-and-forget — and it also means the request never
      // holds open long enough to hit the 60s client/gateway timeout (no 504).
      const response = await postAnyaMessage(sessionId, trimmed, {
        currentPage,
        pageContext: pageContextPayload,
        background: true,
      })

      // Replace the optimistic bubble with the server-persisted user message.
      const persistedUser = Array.isArray(response?.messages) ? response.messages[0] : null
      if (persistedUser) {
        setMessages((prev) => {
          const withoutOptimistic = prev.filter((m) => m.id !== optimisticId)
          return [...withoutOptimistic, persistedUser]
        })
      }

      if (response?.pending && response?.run_id) {
        // Hand the run to the background queue (polls + pings even if the panel
        // is closed) and show a local "working…" line while the panel is open.
        setAwaitingRunId(response.run_id)
        enqueueAnyaBackgroundRun({
          runId: response.run_id,
          sessionId,
          profileId: effectiveProfileId ?? null,
          question: trimmed,
        })
      } else if (Array.isArray(response?.messages) && response.messages.length > 1) {
        // Server answered synchronously (e.g. background disabled) — render it.
        setMessages((prev) => {
          const withoutOptimistic = prev.filter((m) => m.id !== optimisticId && m.id !== persistedUser?.id)
          return [...withoutOptimistic, ...response.messages]
        })
        if (response?.degraded) {
          toast({
            variant: "destructive",
            title: "Anya had trouble reaching the AI service",
            description: "That last reply is a fallback — please try again in a moment.",
          })
        }
      } else {
        console.warn("[AnyaChat] send returned no actionable response; refreshing", response)
        await refreshMessages(sessionId)
      }
    } catch (error) {
      console.error("[AnyaChat] send failed:", error)
      if (optimisticId) {
        setMessages((prev) => prev.filter((message) => message.id !== optimisticId))
      }
      setInput(trimmed)
      toast({
        variant: "destructive",
        title: "Failed to send message",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    } finally {
      isSendingRef.current = false
      setIsSending(false)
    }
  }

  const handleCodeSearchSubmit = async (event) => {
    event.preventDefault()
    if (!sessionId) return
    const query = codeSearchForm.query.trim()
    if (!query) {
      toast({
        variant: "destructive",
        title: "Enter a search query",
        description: "Provide text to search for before running the tool.",
      })
      return
    }

    setIsInvokingTool(true)
    try {
      const response = await invokeAnyaTool(
        "code.search",
        {
          query,
          scope: codeSearchForm.scope.trim() || undefined,
          max_results: 25,
        },
        { sessionId },
      )
      const matchCount = response?.result?.output?.matches?.length ?? 0
      toast({
        title: "Code search complete",
        description: `${matchCount} match${matchCount === 1 ? "" : "es"} found.`,
      })
      await refreshMessages(sessionId)
      setCodeSearchForm({ query: "", scope: "" })
      setIsCodeSearchOpen(false)
    } catch (error) {
      console.error("[AnyaChat] code search failed", error)
      toast({
        variant: "destructive",
        title: "Code search failed",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    } finally {
      setIsInvokingTool(false)
    }
  }

  const handleTaskSubmit = async (event) => {
    event.preventDefault()
    if (!sessionId) return
    const title = taskForm.title.trim()
    if (!title) {
      toast({
        variant: "destructive",
        title: "Task title required",
        description: "Add a short description for the task before saving.",
      })
      return
    }

    setIsSavingTask(true)
    try {
      const payload = { title }
      if (taskForm.dueDate) {
        payload.due_date = taskForm.dueDate
      }
      await createAnyaTask(sessionId, payload)
      toast({
        title: "Task logged",
        description: "Anya recorded the follow-up in this session.",
      })
      setTaskForm({ title: "", dueDate: "" })
      await refreshTasks(sessionId)
    } catch (error) {
      console.error("[AnyaChat] create task failed", error)
      toast({
        variant: "destructive",
        title: "Unable to create task",
        description: error instanceof Error ? error.message : "Please try again soon.",
      })
    } finally {
      setIsSavingTask(false)
    }
  }

  const handleTaskStatusChange = async (task, checked) => {
    if (!sessionId || !task?.id) return
    const nextStatus = checked ? "completed" : "open"
    setUpdatingTaskId(task.id)
    try {
      const response = await updateAnyaTask(sessionId, task.id, { status: nextStatus })
      const updatedTask = response?.task ?? {
        ...task,
        status: nextStatus,
        completed_at: checked ? new Date().toISOString() : null,
      }
      setTasks((prev) => prev.map((entry) => (entry.id === task.id ? updatedTask : entry)))
    } catch (error) {
      console.error("[AnyaChat] update task failed", error)
      toast({
        variant: "destructive",
        title: "Could not update task",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    } finally {
      setUpdatingTaskId(null)
    }
  }

  // Lazily create/return a session id. The bootstrap effect normally pre-fills
  // `sessionId` on mount, but quick-action buttons (Admin Tools, Code search,
  // Grant insights) used to hard-bail when `sessionId` was null — even though
  // a session is cheap to create on demand. That produced a greyed-out
  // Admin Tools button for admins (Anya goals 4 & 8). `ensureSession` keeps
  // the UI responsive: the first click that actually needs a backend session
  // creates one and reuses it for the rest of the interaction.
  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId
    try {
      const session = await createAnyaSession({
        profileId: effectiveProfileId ?? undefined,
      })
      const newId = session?.id ?? null
      if (newId) setSessionId(newId)
      return newId
    } catch (error) {
      const status = error?.status ?? null
      const message = String(error?.message || "")
      const isProfileMissing = status === 404 || /profile not found/i.test(message)
      if (!isProfileMissing) throw error
      // Fall back to a profile-less session so admin-scoped tools always run.
      const fallback = await createAnyaSession({ profileId: undefined })
      const fallbackId = fallback?.id ?? null
      if (fallbackId) setSessionId(fallbackId)
      return fallbackId
    }
  }, [sessionId, effectiveProfileId])

  const handleGrantInsights = async () => {
    if (!effectiveProfileId) return
    setIsFetchingInsights(true)
    try {
      const activeId = await ensureSession()
      if (!activeId) throw new Error("Could not start Anya session")
      await invokeAnyaTool(
        "grants.summarizeMatches",
        {
          profile_id: effectiveProfileId,
          limit: 5,
        },
        { sessionId: activeId },
      )
      toast({
        title: "Grant insights ready",
        description: "Anya summarised the latest matches in the chat thread.",
      })
      await refreshMessages(activeId)
    } catch (error) {
      console.error("[AnyaChat] grant summary failed", error)
      toast({
        variant: "destructive",
        title: "Unable to fetch insights",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    } finally {
      setIsFetchingInsights(false)
    }
  }

  const getToolFieldValue = (toolName, fieldName) => {
    const value = adminToolForm?.[toolName]?.[fieldName]
    return value === undefined || value === null ? "" : value
  }

  const isProfileSchemaField = (fieldName) => {
    const normalized = String(fieldName || "").toLowerCase()
    return normalized === "profileid" || normalized === "profile_id"
  }

  const setToolFieldValue = (toolName, fieldName, value) => {
    setAdminToolForm((prev) => ({
      ...prev,
      [toolName]: {
        ...(prev[toolName] || {}),
        [fieldName]: value,
      },
    }))
  }

  const buildAdminToolParameters = (tool) => {
    const properties = tool?.schema?.properties || {}
    const form = adminToolForm?.[tool.name] || {}
    // Only inject profile_id when we actually have one — tools that validate
    // presence should not receive an explicit null vs an absent key.
    const parameters = effectiveProfileId ? { profile_id: effectiveProfileId } : {}
    for (const [name, schema] of Object.entries(properties)) {
      const raw = form[name] ?? (isProfileSchemaField(name) ? effectiveProfileId : undefined)
      if (raw === undefined || raw === null || raw === "") continue
      if (schema?.type === "boolean") {
        parameters[name] = raw === true || raw === "true"
      } else if (schema?.type === "integer" || schema?.type === "number") {
        parameters[name] = Number(raw)
      } else if (schema?.type === "object" || schema?.type === "array") {
        try {
          parameters[name] = typeof raw === "string" ? JSON.parse(raw) : raw
        } catch {
          parameters[name] = raw
        }
      } else {
        parameters[name] = raw
      }
    }
    return parameters
  }

  const missingRequiredFields = (tool) => {
    const required = Array.isArray(tool?.schema?.required) ? tool.schema.required : []
    return required.filter((name) => {
      const value = getToolFieldValue(tool.name, name) || (isProfileSchemaField(name) ? effectiveProfileId : "")
      return value === "" || value === null || value === undefined
    })
  }

  const handleRunAdminTool = async (tool) => {
    if (!tool?.name) return
    setInvokingAdminTool(tool.name)
    try {
      const activeId = await ensureSession()
      if (!activeId) throw new Error("Could not start Anya session")
      await invokeAnyaTool(
        tool.name,
        buildAdminToolParameters(tool),
        { sessionId: activeId },
      )
      toast({
        title: `${tool.name} completed`,
        description: "Results have been posted to the chat thread.",
      })
      await refreshMessages(activeId)
    } catch (error) {
      console.error(`[AnyaChat] admin tool ${tool.name} failed`, error)
      toast({
        variant: "destructive",
        title: `${tool.name} failed`,
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    } finally {
      setInvokingAdminTool(null)
    }
  }

  const renderAdminToolFields = (tool) => {
    const properties = tool?.schema?.properties || {}
    const entries = Object.entries(properties).filter(([name]) => name !== "profile_id")
    if (entries.length === 0) return null
    const required = new Set(Array.isArray(tool?.schema?.required) ? tool.schema.required : [])
    return (
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {entries.map(([name, schema]) => {
          const id = `admin-tool-${tool.name}-${name}`
          const value = getToolFieldValue(tool.name, name) || (isProfileSchemaField(name) ? effectiveProfileId : "")
          const label = `${name}${required.has(name) ? " *" : ""}`
          if (isProfileSchemaField(name)) {
            return (
              <label key={name} htmlFor={id} className="space-y-1 text-xs text-slate-600">
                <span>{label}</span>
                <select
                  id={id}
                  value={value}
                  onChange={(event) => setToolFieldValue(tool.name, name, event.target.value)}
                  className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800"
                >
                  <option value="">Select profile...</option>
                  {(profiles || []).map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.display_name || profile.name || profile.id}
                    </option>
                  ))}
                </select>
              </label>
            )
          }
          if (schema?.type === "boolean") {
            return (
              <label key={name} htmlFor={id} className="flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs">
                <Checkbox
                  id={id}
                  checked={value === true || value === "true"}
                  onCheckedChange={(checked) => setToolFieldValue(tool.name, name, checked === true)}
                />
                <span>{label}</span>
              </label>
            )
          }
          if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
            return (
              <label key={name} htmlFor={id} className="space-y-1 text-xs text-slate-600">
                <span>{label}</span>
                <select
                  id={id}
                  value={value}
                  onChange={(event) => setToolFieldValue(tool.name, name, event.target.value)}
                  className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800"
                >
                  <option value="">Select...</option>
                  {schema.enum.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
            )
          }
          if (
            name.toLowerCase().includes("sql") ||
            schema?.type === "object" ||
            schema?.type === "array"
          ) {
            return (
              <label key={name} htmlFor={id} className="space-y-1 text-xs text-slate-600 sm:col-span-2">
                <span>{label}</span>
                <Textarea
                  id={id}
                  value={value}
                  onChange={(event) => setToolFieldValue(tool.name, name, event.target.value)}
                  placeholder={name.toLowerCase().includes("sql") ? "SELECT ..." : "JSON value"}
                  className="min-h-20 text-xs"
                />
              </label>
            )
          }
          return (
            <label key={name} htmlFor={id} className="space-y-1 text-xs text-slate-600">
              <span>{label}</span>
              <Input
                id={id}
                type={schema?.type === "integer" || schema?.type === "number" ? "number" : "text"}
                value={value}
                onChange={(event) => setToolFieldValue(tool.name, name, event.target.value)}
                placeholder={schema?.type === "object" || schema?.type === "array" ? "JSON value" : schema?.description || name}
                className="h-8 text-xs"
              />
            </label>
          )
        })}
      </div>
    )
  }

  // Quick-action buttons deliberately do NOT require `sessionId` — the
  // session is created lazily on click via `ensureSession()`. Gating the
  // buttons on `sessionId` previously caused them to grey out for admins
  // during the brief window before bootstrap completed, and permanently if
  // bootstrap never fired (e.g. because isFirstRun was incorrectly true).
  const isCodeSearchDisabled =
    !hasCodeSearchTool || isLoading || isInvokingTool || isLoadingTools
  const isGrantInsightsDisabled =
    !hasGrantTool || !profileId || isLoading || isFetchingInsights || isLoadingTools
  const isTaskFormDisabled = !sessionId || isLoading || isSavingTask

  return (
    <div
      className="flex h-full min-w-0 flex-col overflow-x-hidden rounded-xl border border-slate-200 bg-white/80 shadow-sm"
      style={chatAppearance ? { background: chatAppearance.panelBg, borderColor: chatAppearance.border, color: chatAppearance.bodyText } : undefined}
    >
      <div
        className="border-b border-slate-200 px-4 py-3 max-h-[40%] overflow-y-auto shrink-0"
        style={chatAppearance ? { borderColor: chatAppearance.border } : undefined}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-full overflow-hidden bg-gradient-to-br from-purple-600 to-blue-600">
                  <img 
                    src="/images/anya-avatar.svg" 
                    alt="Anya" 
                    className="h-full w-full object-cover"
                  />
                </div>
                <h2 className="text-sm font-semibold text-slate-800" style={chatAppearance ? { color: chatAppearance.bodyText } : undefined}>Anya, your GrantFlow copilot</h2>
                {isAdmin && (
                  <Badge variant="default" className="gap-1 text-[11px] bg-purple-600">
                    <Shield className="h-3 w-3" />
                    ADMIN
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-slate-500 hover:text-red-600 hover:bg-red-50"
                    onClick={handleClearConversation}
                    disabled={isClearingConversation || messages.length === 0}
                    title="Clear conversation (keeps same session)"
                  >
                    {isClearingConversation ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-slate-500 hover:text-purple-600 hover:bg-purple-50"
                    onClick={handleStartNewConversation}
                    disabled={isClearingConversation}
                    title="Start new conversation"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-slate-600" style={chatAppearance ? { color: chatAppearance.mutedText } : undefined}>
                GrantFlow helps you find, track, and apply for grants. Ask Anya to find grants that match
                your profile, explain next steps, summarise deadlines, or navigate any part of the app.
              </p>
            </div>
            {copilotEnabled ? (
              <>
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Next steps</h3>
                  <div className="flex flex-wrap gap-2">
                    {nextStepActions.map((action, idx) => (
                      <Button
                        key={idx}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-xs h-8"
                        onClick={() => runNextStepAction(action)}
                      >
                        {action.label?.includes("Pipeline") || action.label?.includes("pipeline") ? (
                          <Kanban className="h-3.5 w-3.5 shrink-0" />
                        ) : action.label?.includes("Discover") || action.label?.includes("discover") ? (
                          <Compass className="h-3.5 w-3.5 shrink-0" />
                        ) : action.label?.includes("Document") || action.label?.includes("document") ? (
                          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                        ) : action.label?.includes("profile") ? (
                          <User className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <Sparkles className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="truncate max-w-[140px]">{action.label}</span>
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-xs text-slate-600"
                    onClick={handleUseCurrentScreen}
                    disabled={!sessionId || isSendingContext}
                    title="Send current page context to Anya"
                  >
                    {isSendingContext ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Monitor className="h-3.5 w-3.5" />
                    )}
                    Use current screen
                  </Button>
                </div>
              </>
            ) : null}
            {(hasQuickActions || hasAdminTools || isLoadingTools) ? (
              <div className="flex items-center gap-2 flex-wrap">
                {hasGrantTool ? (
                  <Button
                    size="sm"
                    className="gap-2"
                    onClick={handleGrantInsights}
                    disabled={isGrantInsightsDisabled}
                  >
                    {isFetchingInsights ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    Grant insights
                  </Button>
                ) : null}
                {hasCodeSearchTool ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    disabled={isCodeSearchDisabled}
                    onClick={() => setIsCodeSearchOpen(true)}
                  >
                    {isInvokingTool ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                    Code search
                  </Button>
                ) : null}
                {hasAdminTools ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 border-purple-300 bg-purple-50 hover:bg-purple-100"
                    onClick={() => setIsAdminToolsOpen(true)}
                    // Button only opens a local dialog; session gets created
                    // lazily when a tool inside the dialog is actually run.
                    disabled={isLoading || isLoadingTools}
                  >
                    <Wrench className="h-4 w-4" />
                    Admin Tools
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          {!hasQuickActions && !isLoadingTools ? (
            <p className="text-xs text-slate-600">
              Tool registry still loading. Quick actions will appear here shortly.
            </p>
          ) : null}
          {sessionId ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  className="flex items-center gap-2 text-left"
                  onClick={() => setIsTasksExpanded((prev) => !prev)}
                >
                  {isTasksExpanded ? (
                    <ChevronDown className="h-3 w-3 text-slate-500 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-slate-500 shrink-0" />
                  )}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      Session tasks
                    </h3>
                    <p className="text-xs text-slate-600">
                      {isTasksExpanded ? "Capture action items so nothing falls through." : "Click to expand"}
                    </p>
                  </div>
                </button>
                <Badge variant={openTaskCount > 0 ? "secondary" : "outline"} className="text-[11px]">
                  {openTaskCount} open
                </Badge>
              </div>
              {isTasksExpanded && (
                <>
                  <div className="mt-3 space-y-2">
                {isLoadingTasks ? (
                  <div className="flex items-center gap-2 text-xs text-slate-600">
                    <Loader2 className="h-3 w-3 animate-spin text-blue-600" />
                    Fetching tasks…
                  </div>
                ) : hasTasks ? (
                  sortedTasks.map((task) => {
                    const isCompleted = task.status === "completed"
                    const taskIsUpdating = updatingTaskId === task.id
                    let dueLabel = null
                    if (task.due_date) {
                      const dueDate = new Date(`${task.due_date}T00:00:00`)
                      if (!Number.isNaN(dueDate.getTime())) {
                        dueLabel = `Due ${formatDistanceToNow(dueDate, { addSuffix: true })}`
                      } else {
                        dueLabel = `Due ${task.due_date}`
                      }
                    }
                    return (
                      <div
                        key={task.id}
                        className="flex items-start gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm"
                      >
                        <Checkbox
                          id={`anya-task-${task.id}`}
                          checked={isCompleted}
                          onCheckedChange={(checked) =>
                            handleTaskStatusChange(task, checked === true)
                          }
                          disabled={taskIsUpdating || !sessionId}
                          className="mt-1"
                        />
                        <div className="flex flex-1 flex-col gap-1">
                          <span
                            className={cn(
                              "text-sm font-medium text-slate-700",
                              isCompleted && "line-through text-slate-400",
                            )}
                          >
                            {task.title}
                          </span>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                            {dueLabel ? <span>{dueLabel}</span> : null}
                            {task.priority && task.priority !== "normal" ? (
                              <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 font-medium uppercase tracking-wide text-[11px] text-slate-600">
                                {task.priority}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )
                  })
                ) : (
                  <p className="text-xs text-slate-600">
                    No tasks yet. Log a follow-up below to keep momentum.
                  </p>
                )}
                  </div>
                  <form onSubmit={handleTaskSubmit} className="mt-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
                  <div className="space-y-1">
                    <Label htmlFor="anya-task-title" className="text-xs text-slate-600">
                      Task title
                    </Label>
                    <Input
                      id="anya-task-title"
                      value={taskForm.title}
                      onChange={(event) =>
                        setTaskForm((prev) => ({ ...prev, title: event.target.value }))
                      }
                      placeholder="e.g. Draft budget narrative"
                      disabled={isTaskFormDisabled}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="anya-task-due" className="text-xs text-slate-600">
                      Due date (optional)
                    </Label>
                    <Input
                      id="anya-task-due"
                      type="date"
                      value={taskForm.dueDate}
                      onChange={(event) =>
                        setTaskForm((prev) => ({ ...prev, dueDate: event.target.value }))
                      }
                      disabled={isTaskFormDisabled}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end">
                  <Button type="submit" size="sm" className="gap-2" disabled={isTaskFormDisabled}>
                    {isSavingTask ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    Add task
                  </Button>
                </div>
              </form>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-[200px] px-4 py-4">
        {/* Onboarding flow — shown in-panel instead of normal chat */}
        {onboardingStep !== null ? (
          <OnboardingFlow
            step={onboardingStep}
            onAdvance={handleOnboardingAdvance}
            t={t}
            languages={languages}
            onPickLanguage={handlePickLanguage}
            onboarding={{
              profileType: obProfileType,
              setProfileType: setObProfileType,
              situations: obSituations,
              setSituations: setObSituations,
              state: obState,
              setState: setObState,
            }}
          />
        ) : !isLoading && !hasMessages ? (
          <div className="flex h-full flex-col items-center justify-center gap-6 px-4 py-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full overflow-hidden bg-gradient-to-br from-purple-600 to-blue-600 shadow-md">
              <img src="/images/anya-avatar.svg" alt="Anya" className="h-full w-full object-cover" />
            </div>
            <div className="space-y-2">
              <p className="text-base font-semibold text-slate-800" style={chatAppearance ? { color: chatAppearance.bodyText } : undefined}>Hi! I'm Anya, your GrantFlow guide.</p>
              <p className="text-sm text-slate-500 max-w-xs mx-auto" style={chatAppearance ? { color: chatAppearance.mutedText } : undefined}>
                I can help you find grants that match your profile, explain what you're seeing, walk you through your pipeline, and answer questions about the application process.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {[
                "Find grants for my profile",
                "Explain my match scores",
                "What should I do next?",
                "Help me fill out my profile",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => {
                    setInput(suggestion)
                    // Auto-submit after state updates
                    setTimeout(() => {
                      const trimmed = suggestion.trim()
                      if (!trimmed || !sessionId || isSendingRef.current) return
                      isSendingRef.current = true
                      setIsSending(true)
                      const optimisticId = uuid()
                      setMessages([{ id: optimisticId, session_id: sessionId, created_at: new Date().toISOString(), role: "user", content: trimmed }])
                      setInput("")
                      postAnyaMessage(sessionId, trimmed, { currentPage, pageContext: pageContextPayload })
                        .then((response) => {
                          if (Array.isArray(response?.messages) && response.messages.length > 0) {
                            setMessages((prev) => {
                              const without = prev.filter((m) => m.id !== optimisticId)
                              return [...without, ...response.messages]
                            })
                          } else {
                            console.warn("[AnyaChat] suggestion send returned no messages; falling back to refresh", response)
                            refreshMessages(sessionId)
                          }
                        })
                        .catch((err) => {
                          console.error("[AnyaChat] suggestion send failed:", err)
                          setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
                          setInput(trimmed)
                          toast({ variant: "destructive", title: "Failed to send message", description: err instanceof Error ? err.message : "Please try again shortly." })
                        })
                        .finally(() => {
                          isSendingRef.current = false
                          setIsSending(false)
                        })
                    }, 0)
                  }}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Profile completeness nudge — shown once per session */}
            {nudgeMessage ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-sm text-slate-800 shadow-sm">
                <div className="flex items-center justify-between gap-2 pb-1 text-xs text-slate-600">
                  <Badge variant="secondary" className="text-[11px] uppercase tracking-wide">Anya</Badge>
                  <button
                    type="button"
                    className="text-slate-400 hover:text-slate-600 text-xs"
                    onClick={() => setNudgeMessage(null)}
                    aria-label="Dismiss"
                  >
                    ✕
                  </button>
                </div>
                <p className="whitespace-pre-wrap break-words leading-relaxed">{nudgeMessage}</p>
              </div>
            ) : null}
            {/* Rows marked anya_private_seed are Anya's private interview
                scripts — model context + audit trail only, never painted into
                the visible chat. */}
            {messages.filter((message) => message.tool_name !== "anya_private_seed").map((message) => (
              <MessageBubble key={message.id} message={message} appearance={chatAppearance} />
            ))}
            {isSending && !awaitingRunId ? (
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <Loader2 className="h-3 w-3 animate-spin text-blue-600" />
                Working…
              </div>
            ) : null}
            {awaitingRunId ? (
              <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-2 text-xs text-blue-800">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-3 w-3 animate-spin text-blue-600" />
                    {isStopping
                      ? "Stopping — Anya halts before her next step…"
                      : "Anya is working on this. Watch her steps below, keep using GrantFlow, or stop her any time."}
                  </span>
                  <button
                    type="button"
                    onClick={handleStopRun}
                    disabled={isStopping}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-[11px] font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-60"
                    title="Stop Anya (Esc)"
                  >
                    <Square className="h-3 w-3" /> Stop (Esc)
                  </button>
                </div>
                {runProgress.length > 0 ? (
                  <ul className="space-y-1 border-t border-blue-200/70 pt-2">
                    {runProgress.map((step, idx) => (
                      <li key={idx} className="flex items-center gap-1.5">
                        {step.status === "done" ? (
                          <span className="text-emerald-600">✓</span>
                        ) : step.status === "error" ? (
                          <span className="text-red-600">✗</span>
                        ) : step.status === "cancelled" ? (
                          <span className="text-slate-500">⏹</span>
                        ) : (
                          <Loader2 className="h-2.5 w-2.5 animate-spin text-blue-500" />
                        )}
                        <span className={step.status === "error" ? "text-red-700" : undefined}>{step.label}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </ScrollArea>

      <form
        className="border-t border-slate-200 bg-slate-50/80 px-4 py-3"
        style={chatAppearance ? { background: chatAppearance.composerBg, borderColor: chatAppearance.border } : undefined}
        onSubmit={(event) => {
          event.preventDefault()
          handleSend()
        }}
      >
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              handleSend()
            }
          }}
          placeholder="Ask Anya for help…"
          rows={3}
          className="resize-none text-sm bg-white border-slate-200 text-slate-900 placeholder:text-slate-500 focus-visible:ring-slate-400"
          disabled={isDisabled}
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-slate-600" style={chatAppearance ? { color: chatAppearance.mutedText } : undefined}>
            Anya keeps all actions scoped to this profile.
          </span>
          <Button
            type="submit"
            disabled={isDisabled || isSending || !input.trim()}
            size="sm"
            className="gap-2"
          >
            {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </Button>
        </div>
      </form>

      <Dialog
        open={isCodeSearchOpen}
        onOpenChange={(open) => {
          setIsCodeSearchOpen(open)
          if (!open) {
            setCodeSearchForm({ query: "", scope: "" })
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Code search</DialogTitle>
            <DialogDescription>
              Search the repository for a case-insensitive match across allowed directories. Provide an
              optional scope to narrow results.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCodeSearchSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="anya-code-search-query">Search query</Label>
              <Input
                id="anya-code-search-query"
                value={codeSearchForm.query}
                onChange={(event) =>
                  setCodeSearchForm((prev) => ({ ...prev, query: event.target.value }))
                }
                placeholder="e.g. retry_count"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="anya-code-search-scope">Scope (optional)</Label>
              <Input
                id="anya-code-search-scope"
                value={codeSearchForm.scope}
                onChange={(event) =>
                  setCodeSearchForm((prev) => ({ ...prev, scope: event.target.value }))
                }
                placeholder="backend/routes"
              />
              <p className="text-xs text-slate-600">
                Path should be relative to the repository root and within backend/, src/, or scripts/.
              </p>
            </div>
            <DialogFooter className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsCodeSearchOpen(false)
                  setCodeSearchForm({ query: "", scope: "" })
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isInvokingTool || !codeSearchForm.query.trim()}>
                {isInvokingTool ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                Run search
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={isAdminToolsOpen} onOpenChange={setIsAdminToolsOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-purple-600" />
              Admin Tools
            </DialogTitle>
            <DialogDescription>
              Advanced diagnostic and management tools for administrators. Use with caution.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {adminTools.diagnostics && adminTools.diagnostics.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-purple-700" />
                  <h3 className="font-semibold text-sm text-slate-900">System Diagnostics</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.diagnostics.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                        {renderAdminToolFields(tool)}
                        {missingRequiredFields(tool).length > 0 ? (
                          <div className="mt-2 text-xs font-medium text-amber-700">
                            Missing required parameter: {missingRequiredFields(tool).join(", ")}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5 border-purple-300 text-purple-700 hover:bg-purple-50"
                        disabled={invokingAdminTool === tool.name || missingRequiredFields(tool).length > 0}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Activity className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.health && adminTools.health.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Health & Monitoring</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.health.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                        {renderAdminToolFields(tool)}
                        {missingRequiredFields(tool).length > 0 ? (
                          <div className="mt-2 text-xs font-medium text-amber-700">
                            Missing required parameter: {missingRequiredFields(tool).join(", ")}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={invokingAdminTool === tool.name || missingRequiredFields(tool).length > 0}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.crawler && adminTools.crawler.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Crawler Management</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.crawler.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                        {renderAdminToolFields(tool)}
                        {missingRequiredFields(tool).length > 0 ? (
                          <div className="mt-2 text-xs font-medium text-amber-700">
                            Missing required parameter: {missingRequiredFields(tool).join(", ")}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={invokingAdminTool === tool.name || missingRequiredFields(tool).length > 0}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.autonomous && adminTools.autonomous.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Autonomous Operations</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.autonomous.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                        {renderAdminToolFields(tool)}
                        {missingRequiredFields(tool).length > 0 ? (
                          <div className="mt-2 text-xs font-medium text-amber-700">
                            Missing required parameter: {missingRequiredFields(tool).join(", ")}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={invokingAdminTool === tool.name || missingRequiredFields(tool).length > 0}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.code && adminTools.code.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Code className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Code Analysis</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.code.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                        {renderAdminToolFields(tool)}
                        {missingRequiredFields(tool).length > 0 ? (
                          <div className="mt-2 text-xs font-medium text-amber-700">
                            Missing required parameter: {missingRequiredFields(tool).join(", ")}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={invokingAdminTool === tool.name || missingRequiredFields(tool).length > 0}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.database && adminTools.database.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Database & Queries</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.database.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                        {renderAdminToolFields(tool)}
                        {missingRequiredFields(tool).length > 0 ? (
                          <div className="mt-2 text-xs font-medium text-amber-700">
                            Missing required parameter: {missingRequiredFields(tool).join(", ")}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={invokingAdminTool === tool.name || missingRequiredFields(tool).length > 0}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.functions && adminTools.functions.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Function Testing</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.functions.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                        {renderAdminToolFields(tool)}
                        {missingRequiredFields(tool).length > 0 ? (
                          <div className="mt-2 text-xs font-medium text-amber-700">
                            Missing required parameter: {missingRequiredFields(tool).join(", ")}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={invokingAdminTool === tool.name || missingRequiredFields(tool).length > 0}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.brain && adminTools.brain.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Brain Management</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.brain.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                        {renderAdminToolFields(tool)}
                        {missingRequiredFields(tool).length > 0 ? (
                          <div className="mt-2 text-xs font-medium text-amber-700">
                            Missing required parameter: {missingRequiredFields(tool).join(", ")}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={invokingAdminTool === tool.name || missingRequiredFields(tool).length > 0}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {adminTools.other && adminTools.other.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-slate-700" />
                  <h3 className="font-semibold text-sm text-slate-900">Other Tools</h3>
                </div>
                <div className="grid gap-2">
                  {adminTools.other.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="font-mono text-xs text-purple-700 font-medium">{tool.name}</div>
                        <div className="text-xs text-slate-700 mt-1">{tool.description}</div>
                        {renderAdminToolFields(tool)}
                        {missingRequiredFields(tool).length > 0 ? (
                          <div className="mt-2 text-xs font-medium text-amber-700">
                            Missing required parameter: {missingRequiredFields(tool).join(", ")}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        disabled={invokingAdminTool === tool.name || missingRequiredFields(tool).length > 0}
                        onClick={() => handleRunAdminTool(tool)}
                      >
                        {invokingAdminTool === tool.name ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        Run
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <p className="text-xs text-slate-600 text-left flex-1">
              You can also ask Anya to use any tool by referencing its name in your message.
            </p>
            <Button variant="outline" onClick={() => setIsAdminToolsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
