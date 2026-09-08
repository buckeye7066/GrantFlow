import React, { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, PenLine, Sparkles } from "lucide-react"
import { SECTION_METADATA } from "@/config/sectionMetadata"
import { requestProfileFieldAI } from "@/api/profiles"
import { useToast } from "@/components/ui/use-toast"

// Deprecated essay questions are duplicates of a canonical field elsewhere
// (essays.personal_statement / essays.goals are mirrored from Story & goals),
// so they are not asked again here — the same rule ProfileFieldWithAI applies.
const ESSAY_FIELDS = (SECTION_METADATA.essays?.fields ?? []).filter((field) => !field.deprecated)

// Match ProfileFieldWithAI: surface a recoverable error rather than letting the
// shimmer hang toward the 60s network ceiling.
const AI_ASSIST_TIMEOUT_MS = 30000

/**
 * Application essays — the long-form prose Hamilton drafts applications from.
 *
 * The owner asked to "see and edit what Hamilton writes from": each essay is an
 * inline, editable textarea that saves on blur. These fields are drafting-only
 * (format: 'prose', scored: false) — they are NOT used for match scoring, which
 * is why they stay free text. The card makes that explicit so users understand
 * the difference from the structured, matcher-facing fields.
 *
 * Every essay also carries its own "Assist with AI" button (owner order
 * 2026-09-08). The essays were the one profile surface without it: they render
 * here as bare textareas instead of through ProfileFieldWithAI, so the button
 * every other free-text field gets never reached them. A generated draft is
 * written straight through onSaveField — the blur handler does not fire for a
 * programmatic change, and an unsaved essay is lost on the next tab switch.
 */
export default function ApplicationEssaysCard({ essays, onSaveField, isSaving, profileId }) {
  const data = essays && typeof essays === "object" ? essays : {}
  const [drafts, setDrafts] = useState({})
  const [aiFieldName, setAiFieldName] = useState(null)
  const { toast } = useToast()

  // Keep local drafts in sync when the saved section data changes (e.g. after a
  // save round-trips, or when switching profiles).
  useEffect(() => {
    const source = essays && typeof essays === "object" ? essays : {}
    const next = {}
    for (const field of ESSAY_FIELDS) {
      next[field.name] = typeof source[field.name] === "string" ? source[field.name] : ""
    }
    setDrafts(next)
  }, [essays])

  const handleBlur = (fieldName) => {
    if (typeof onSaveField !== "function") return
    const nextValue = drafts[fieldName] ?? ""
    const savedValue = typeof data[fieldName] === "string" ? data[fieldName] : ""
    if (nextValue === savedValue) return // no change — skip the write
    onSaveField("essays", fieldName, nextValue)
  }

  const handleAIAssist = async (field) => {
    if (!profileId) {
      toast({
        title: "AI assist unavailable",
        description: "This essay is not attached to a saved profile yet.",
        variant: "destructive",
      })
      return
    }

    setAiFieldName(field.name)
    try {
      const response = await Promise.race([
        requestProfileFieldAI({
          profileId,
          sectionKey: "essays",
          fieldName: field.name,
          fieldLabel: field.label,
          fieldDescription: field.help || "",
          currentValue: drafts[field.name] ?? "",
          ...drafts,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("AI is taking longer than expected. Please try again in a moment.")),
            AI_ASSIST_TIMEOUT_MS,
          ),
        ),
      ])

      const suggestion = response?.suggestion
      if (suggestion === undefined || suggestion === null || String(suggestion).trim() === "") {
        toast({
          title: "No suggestion available",
          description: response?.hint || "Fill in more of the profile to give the draft something to work from.",
        })
        return
      }

      const nextValue = typeof suggestion === "string" ? suggestion : String(suggestion)
      setDrafts((prev) => ({ ...prev, [field.name]: nextValue }))
      if (typeof onSaveField === "function") onSaveField("essays", field.name, nextValue)
      toast({
        title: "AI draft applied",
        description: `Drafted ${field.label}. Edit it — your changes save when you click out.`,
      })
    } catch (error) {
      console.error("Essay AI assist error:", error)
      toast({
        title: "AI assist failed",
        description: error?.message || "Could not generate a draft",
        variant: "destructive",
      })
    } finally {
      setAiFieldName(null)
    }
  }

  return (
    <Card data-testid="application-essays-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-blue-50 p-2 text-blue-600">
            <PenLine className="h-4 w-4" />
          </span>
          <div>
            <CardTitle className="text-base">
              Application essays
              {isSaving ? (
                <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin text-slate-400" />
              ) : null}
            </CardTitle>
            <CardDescription>
              Used by Hamilton to draft your applications. Edit these to control exactly
              what Hamilton writes from. Free-text on purpose — these are used for drafting only,
              not for match scoring.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {ESSAY_FIELDS.map((field) => {
          const isGenerating = aiFieldName === field.name
          return (
            <div key={field.name} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`essay-${field.name}`}>{field.label}</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid={`essay-ai-assist-${field.name}`}
                  onClick={() => handleAIAssist(field)}
                  disabled={isSaving || aiFieldName !== null}
                  className="h-7 px-2 text-xs bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100 text-blue-700"
                >
                  {isGenerating ? (
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
              </div>
              <Textarea
                id={`essay-${field.name}`}
                rows={4}
                disabled={isSaving || isGenerating}
                value={drafts[field.name] ?? ""}
                placeholder={field.help}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [field.name]: e.target.value }))}
                onBlur={() => handleBlur(field.name)}
              />
            </div>
          )
        })}
        <p className="text-xs italic text-slate-500">
          Changes save automatically when you click out of a box. &ldquo;Assist with AI&rdquo; drafts
          an answer from the rest of your profile — review it before you apply.
        </p>
      </CardContent>
    </Card>
  )
}
