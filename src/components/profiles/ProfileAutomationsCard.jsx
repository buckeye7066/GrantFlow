import React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot } from "lucide-react"
import { apiFetch } from "@/api/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/use-toast"
import {
  AUTOMATION_TOGGLES,
  normalizeAutomationToggles,
} from "../../../shared/automationPreferences.js"

/**
 * ProfileAutomationsCard
 *
 * Per-profile automation toggles. Lets the owner choose which automations are
 * allowed to run for THIS profile (Hamilton auto-apply, auto-submit, pipeline
 * auto-processing, discovery auto-add). Each toggle maps to a real backend gate
 * (see shared/automationPreferences.js). Toggling is optimistic with a toast and
 * rolls back on error. Defaults are all-on, preserving prior behaviour.
 */
export default function ProfileAutomationsCard({ profileId }) {
  const { toast } = useToast()
  const qc = useQueryClient()
  const queryKey = ["automation-preferences", profileId]

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => apiFetch(`/api/profiles/${profileId}/automation-preferences`),
    enabled: Boolean(profileId),
  })

  // Server-provided definitions take priority (so labels stay in sync if the
  // backend evolves); fall back to the bundled canonical list.
  const definitions = Array.isArray(data?.definitions) && data.definitions.length
    ? data.definitions
    : AUTOMATION_TOGGLES
  const visibleDefinitions = definitions.filter((def) => def.enforced !== false)
  const automations = normalizeAutomationToggles(data?.automations)

  const save = useMutation({
    mutationFn: (next) =>
      apiFetch(`/api/profiles/${profileId}/automation-preferences`, {
        method: "PUT",
        body: JSON.stringify({ automations: next }),
      }),
    // Optimistic update: flip immediately, roll back on failure.
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey })
      const previous = qc.getQueryData(queryKey)
      qc.setQueryData(queryKey, (old) => ({ ...(old || {}), automations: next }))
      return { previous }
    },
    onError: (err, _next, ctx) => {
      if (ctx?.previous) qc.setQueryData(queryKey, ctx.previous)
      toast({
        title: "Could not update automation",
        description: err?.message || "Please try again.",
        variant: "destructive",
      })
    },
    onSuccess: (res) => {
      if (res?.automations) qc.setQueryData(queryKey, res)
    },
    onSettled: () => qc.invalidateQueries({ queryKey }),
  })

  const onToggle = (key, value, label) => {
    const next = { ...automations, [key]: value }
    save.mutate(next)
    toast({
      title: value ? `${label} on` : `${label} off`,
      description: value
        ? "This automation may run for this profile."
        : "This automation will be skipped for this profile.",
    })
  }

  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="p-2 rounded-lg bg-indigo-50 text-indigo-600">
            <Bot className="w-4 h-4" />
          </span>
          Automations
        </CardTitle>
        <p className="text-sm text-slate-500">
          Choose which automations are allowed to run for this profile. Turning one
          off only affects this profile; you can still run it by hand.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading automation settings…</p>
        ) : (
          visibleDefinitions.length === 0 ? (
            <p className="text-sm text-slate-500">No profile automations are available right now.</p>
          ) : visibleDefinitions.map((def) => (
            <div
              key={def.key}
              className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white/70 p-3"
            >
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{def.label}</span>
                </div>
                <p className="text-xs text-slate-500 leading-snug">{def.description}</p>
              </div>
              <Switch
                checked={automations[def.key] !== false}
                disabled={save.isPending}
                onCheckedChange={(checked) => onToggle(def.key, checked, def.label)}
                aria-label={`${def.label} ${automations[def.key] !== false ? "enabled" : "disabled"}`}
              />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
