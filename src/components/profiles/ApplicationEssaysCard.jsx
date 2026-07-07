import React, { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, PenLine } from "lucide-react"
import { SECTION_METADATA } from "@/config/sectionMetadata"

const ESSAY_FIELDS = SECTION_METADATA.essays?.fields ?? []

/**
 * Application essays — the long-form prose Hamilton drafts applications from.
 *
 * The owner asked to "see and edit what Hamilton writes from": each essay is an
 * inline, editable textarea that saves on blur. These fields are drafting-only
 * (format: 'prose', scored: false) — they are NOT used for match scoring, which
 * is why they stay free text. The card makes that explicit so users understand
 * the difference from the structured, matcher-facing fields.
 */
export default function ApplicationEssaysCard({ essays, onSaveField, isSaving }) {
  const data = essays && typeof essays === "object" ? essays : {}
  const [drafts, setDrafts] = useState({})

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
        {ESSAY_FIELDS.map((field) => (
          <div key={field.name} className="space-y-1.5">
            <Label htmlFor={`essay-${field.name}`}>{field.label}</Label>
            <Textarea
              id={`essay-${field.name}`}
              rows={4}
              disabled={isSaving}
              value={drafts[field.name] ?? ""}
              placeholder={field.help}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [field.name]: e.target.value }))}
              onBlur={() => handleBlur(field.name)}
            />
          </div>
        ))}
        <p className="text-xs italic text-slate-500">
          Changes save automatically when you click out of a box.
        </p>
      </CardContent>
    </Card>
  )
}
