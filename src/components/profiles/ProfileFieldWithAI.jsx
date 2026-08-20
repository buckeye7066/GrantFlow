/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useMemo, useState } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sparkles, Loader2, X } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { requestProfileFieldAI, getProfileVocabulary } from "@/api/profiles"
import { useToast } from "@/components/ui/use-toast"

function safeStringifyValue(value) {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

// Normalize a stored tags value (which may arrive as an array, or as a
// comma/newline-joined string after the section editor flattens objects) into a
// clean array of trimmed, de-duplicated strings.
function toTagArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))]
  }
  if (typeof value === "string") {
    return [
      ...new Set(
        value
          .split(/[,\n]+/)
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    ]
  }
  return []
}

/**
 * Multi-select tag picker driven by the controlled vocabulary endpoint.
 *
 * Users pick from the funder-facing controlled list (the matcher can only use
 * values it recognizes). A custom entry is allowed ONLY when the field opts in
 * via `allowCustom`. If the vocabulary endpoint is unavailable (e.g. a pre-deploy
 * 404), we degrade gracefully to a free-text input so the form never breaks.
 */
function TagPickerField({ field, value, onChange, disabled }) {
  const selected = useMemo(() => toTagArray(value), [value])
  const [options, setOptions] = useState(null) // null = loading, [] = loaded-empty
  const [failed, setFailed] = useState(false)
  const [customDraft, setCustomDraft] = useState("")

  const vocabularyName = field?.vocabulary || null
  const allowCustom = Boolean(field?.allow_custom)

  useEffect(() => {
    let cancelled = false
    if (!vocabularyName) {
      setOptions([])
      return undefined
    }
    getProfileVocabulary()
      .then((vocab) => {
        if (cancelled) return
        const list = Array.isArray(vocab?.[vocabularyName]) ? vocab[vocabularyName] : []
        setOptions(list.map((entry) => String(entry).trim()).filter(Boolean))
      })
      .catch(() => {
        if (cancelled) return
        // Endpoint missing/erroring (pre-deploy): fall back to free text.
        setFailed(true)
        setOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [vocabularyName])

  const commit = (next) => {
    onChange([...new Set(next.map((v) => String(v).trim()).filter(Boolean))])
  }

  const toggle = (tag) => {
    if (selected.includes(tag)) {
      commit(selected.filter((t) => t !== tag))
    } else {
      commit([...selected, tag])
    }
  }

  const addCustom = () => {
    const val = customDraft.trim()
    if (!val) return
    if (!selected.includes(val)) commit([...selected, val])
    setCustomDraft("")
  }

  // Graceful degradation: no controlled list available → free-text entry.
  if (failed) {
    return (
      <div className="space-y-1">
        <Textarea
          id={field?.name}
          data-testid={`tags-fallback-${field?.name}`}
          rows={2}
          disabled={disabled}
          value={selected.join(", ")}
          placeholder="Enter items separated by commas"
          onChange={(e) => onChange(toTagArray(e.target.value))}
        />
        <p className="text-xs text-slate-400">
          Suggested tag list unavailable — enter values separated by commas.
        </p>
      </div>
    )
  }

  const availableOptions = (options ?? []).filter((opt) => !selected.includes(opt))

  return (
    <div className="space-y-2" data-testid={`tag-picker-${field?.name}`}>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="flex items-center gap-1 pr-1"
            >
              <span>{tag}</span>
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                disabled={disabled}
                onClick={() => toggle(tag)}
                className="rounded-full p-0.5 hover:bg-slate-300/60"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {options === null ? (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading options…
        </div>
      ) : availableOptions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {availableOptions.map((opt) => (
            <button
              key={opt}
              type="button"
              disabled={disabled}
              onClick={() => toggle(opt)}
              className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:hover:border-blue-800 dark:hover:bg-blue-950/50 disabled:opacity-50"
            >
              + {opt}
            </button>
          ))}
        </div>
      ) : (
        selected.length === 0 && (
          <p className="text-xs text-slate-400">No suggested options for this field.</p>
        )
      )}

      {allowCustom && (
        <div className="flex items-center gap-2">
          <Input
            value={customDraft}
            disabled={disabled}
            placeholder="Add a custom value"
            onChange={(e) => setCustomDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addCustom()
              }
            }}
            className="h-8 text-sm"
          />
          <Button type="button" variant="outline" size="sm" disabled={disabled || !customDraft.trim()} onClick={addCustom}>
            Add
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Build the option list for an enum field, preserving a stored value that is
 * not in the declared list by surfacing it as a one-off leading option — so a
 * user's existing answer is never silently blanked. Exported for testing.
 */
export function buildEnumOptions(field, value) {
  const stored = value === undefined || value === null ? "" : String(value)
  const baseOptions = Array.isArray(field?.options) ? field.options.map((o) => String(o)) : []
  if (stored && !baseOptions.includes(stored)) return [stored, ...baseOptions]
  return baseOptions
}

/**
 * Single-choice dropdown for `format: 'enum'` fields.
 */
function EnumSelectField({ field, value, onChange, disabled }) {
  const stored = value === undefined || value === null ? "" : String(value)
  const baseOptions = Array.isArray(field?.options) ? field.options.map((o) => String(o)) : []
  const options = buildEnumOptions(field, value)

  const humanize = (opt) =>
    opt === stored && !baseOptions.includes(opt)
      ? `${opt} (current)`
      : opt.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())

  return (
    <Select value={stored} onValueChange={(next) => onChange(next)} disabled={disabled}>
      <SelectTrigger id={field?.name} data-testid={`enum-select-${field?.name}`}>
        <SelectValue placeholder="Select an option" />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt} value={opt}>
            {humanize(opt)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Profile field with AI assistance button.
 * Renders the correct control for the field's `format`:
 *   - enum  → single-choice <Select>
 *   - tags  → controlled-vocabulary tag picker
 *   - prose → drafting-only <textarea> (labeled "not used for match scoring")
 *   - deprecated fields are not rendered at all
 *   - everything else → existing text/number/date input + AI assist
 */
export default function ProfileFieldWithAI({
  field,
  value,
  onChange,
  inputRef,
  disabled,
  profileId,
  sectionKey,
  formContext,
  ...props
}) {
  const [isLoadingAI, setIsLoadingAI] = useState(false)
  const { toast } = useToast()

  const safeField = field ?? {
    name: props?.name ?? "field",
    label: props?.name ?? "Field",
    description: "",
    component: Input,
    props: {},
  }

  // Deprecated fields are hidden from intake/edit entirely; a stored value is
  // preserved by the section editor's hidden-field registration, not shown here.
  if (safeField.deprecated) return null

  const format = safeField.format
  const isEnum = format === "enum" && Array.isArray(safeField.options) && safeField.options.length > 0
  const isTags = format === "tags"
  const isProse = format === "prose"

  const FieldComponent = safeField.component || Input
  const displayValue = safeStringifyValue(value)

  const handleAIAssist = async () => {
    if (!safeField?.name) {
      toast({
        title: "AI assist unavailable",
        description: "This field is missing metadata (name).",
        variant: "destructive",
      })
      return
    }

    setIsLoadingAI(true)

    try {
      // Prepare context for AI
      const safeFormContext = formContext && typeof formContext === 'object' && !Array.isArray(formContext)
        ? formContext
        : {}
      // formContext is merged FIRST so that explicit keys always win
      // System-supplied keys are the baseline; caller-supplied formContext keys
      // take precedence so richer context from the parent is never discarded.
      const context = {
        fieldName: safeField.name,
        fieldLabel: safeField.label,
        currentValue: displayValue || '',
        fieldDescription: safeField.description || '',
        sectionKey,
        profileId,
        ...safeFormContext,
      }

      // Request AI suggestion, but don't let the shimmer hang toward the 60s
      // network ceiling — surface a recoverable error at 30s so the user gets
      // feedback (the recurring backend AI-timeout pattern otherwise looks frozen).
      const AI_ASSIST_TIMEOUT_MS = 30000
      const response = await Promise.race([
        requestProfileFieldAI(context),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('AI is taking longer than expected. Please try again in a moment.')),
            AI_ASSIST_TIMEOUT_MS,
          ),
        ),
      ])

      if (response?.suggestion !== undefined && response.suggestion !== null) {
        const suggestionValue = typeof response.suggestion === 'string'
          ? response.suggestion
          : safeStringifyValue(response.suggestion)
        onChange(suggestionValue)
        toast({
          title: "AI suggestion applied",
          description: `Updated ${safeField.label} with AI-generated content`,
        })
      } else {
        // No suggestion returned — inform the user so they can improve their profile
        const hint = response?.hint || "Try filling in more profile fields to get better suggestions."
        toast({
          title: "No suggestion available",
          description: hint,
          variant: "default",
        })
      }
    } catch (error) {
      console.error('AI assist error:', error)
      toast({
        title: "AI assist failed",
        description: error.message || "Could not generate suggestion",
        variant: "destructive",
      })
    } finally {
      setIsLoadingAI(false)
    }
  }

  // AI assist only makes sense for free-text (text/prose) fields. Controlled
  // pickers (enum/tags) are constrained to a known list, so we omit the button.
  const showAIAssist = !isEnum && !isTags

  const aiButton = (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleAIAssist}
            disabled={disabled || isLoadingAI}
            className="h-7 px-2 text-xs bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100 text-blue-700"
          >
            {isLoadingAI ? (
              <>
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-3 h-3 mr-1" />
                Assist with AI
              </>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Click to get AI suggestions for this field</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={safeField.name}>{safeField.label}</Label>
        {showAIAssist && aiButton}
      </div>

      {isEnum ? (
        <EnumSelectField field={safeField} value={value} onChange={onChange} disabled={disabled || isLoadingAI} />
      ) : isTags ? (
        <TagPickerField field={safeField} value={value} onChange={onChange} disabled={disabled || isLoadingAI} />
      ) : isProse ? (
        <Textarea
          id={safeField.name}
          ref={inputRef}
          disabled={disabled || isLoadingAI}
          rows={safeField.props?.rows ?? 4}
          {...props}
          value={displayValue}
          onChange={(e) => onChange(e?.target ? e.target.value : e)}
        />
      ) : (
        <FieldComponent
          id={safeField.name}
          ref={inputRef}
          disabled={disabled || isLoadingAI}
          {...safeField.props}
          {...props}
          value={displayValue}
          onChange={(e) => {
            const rawVal = e?.target ? e.target.value : e
            onChange(rawVal)
          }}
        />
      )}

      {isProse && (
        <p className="text-xs italic text-slate-500">
          Used to draft applications — not used for match scoring.
        </p>
      )}

      {safeField.description && (
        <p className="text-xs text-slate-500">{safeField.description}</p>
      )}
    </div>
  )
}
