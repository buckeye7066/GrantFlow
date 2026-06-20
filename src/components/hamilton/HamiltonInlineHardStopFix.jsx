/**
 * HamiltonInlineHardStopFix
 *
 * Brings the fix TO the hard-stop banner. When a stop is a missing/ambiguous
 * scalar profile field (first name, email, ZIP, household income, …), this
 * renders the actual input right in the row: type the value, press Enter (or
 * click Save), and it's written back into the profile section it was missing
 * from, cached for Hamilton's reuse, the stop is cleared, and Hamilton resumes.
 *
 * Returns null for stops that aren't inline-fixable (documents, logins,
 * payments, signatures) so the caller can fall back to its navigate-to-fix link.
 *
 * Shared by HamiltonHardStopChecklist (the user "Process with Hamilton" window)
 * and AdminHamiltonHardStops (the operator dashboard) so the behavior is
 * identical everywhere.
 *
 * Endpoint: POST /api/hamilton/automation/admin/hard-stops/:id/resolve-field
 */

import React, { useState } from "react"
import client from "@/api/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CheckCircle2, Loader2, Save } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { showErrorToast, showSuccessToast } from "@/components/shared/toastHelpers"
import { resolveInlineField } from "@/config/hamiltonHardStopTargets"

export default function HamiltonInlineHardStopFix({ blocker, onResolved }) {
  const { toast } = useToast()
  const inline = resolveInlineField(blocker)
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)

  // Not an inline-fixable field — caller renders its own fallback link.
  if (!inline) return null

  async function save() {
    const trimmed = value.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      const res = await client.post(
        `/api/hamilton/automation/admin/hard-stops/${blocker.id}/resolve-field`,
        { value: trimmed },
      )
      showSuccessToast(
        toast,
        `${inline.label} saved`,
        res?.rerun?.status
          ? `Saved to the profile — Hamilton is running again (${String(res.rerun.status).replace(/_/g, " ")}).`
          : "Saved to the profile and Hamilton will reuse it.",
      )
      onResolved?.(blocker, res)
    } catch (err) {
      showErrorToast(toast, `Could not save ${inline.label}`, err?.message || "See logs.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50/60 p-2">
      <label
        htmlFor={`inline-fix-${blocker.id}`}
        className="block text-[11px] font-medium uppercase tracking-wide text-indigo-900"
      >
        {inline.label}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <Input
          id={`inline-fix-${blocker.id}`}
          value={value}
          autoComplete="off"
          disabled={saving}
          placeholder={`Type ${inline.label.toLowerCase()} and press Enter`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              save()
            }
          }}
          className="h-8 text-sm"
        />
        <Button
          size="sm"
          className="h-8 shrink-0 bg-indigo-600 text-white hover:bg-indigo-700"
          onClick={save}
          disabled={saving || !value.trim()}
          title="Save to the profile and resume Hamilton"
        >
          {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
          Save
        </Button>
      </div>
      <div className="mt-1 flex items-center gap-1 text-[11px] text-indigo-800">
        <CheckCircle2 className="h-3 w-3" />
        Saves to the profile where it was missing · Hamilton reuses it everywhere &amp; resumes.
      </div>
    </div>
  )
}
