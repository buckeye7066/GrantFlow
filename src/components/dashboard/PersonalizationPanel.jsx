import React, { useMemo } from "react"
import { Palette, Layout, Type, SlidersHorizontal } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useDashboardPreferences } from "@/contexts/DashboardPreferencesContext.jsx"
import { cn } from "@/lib/utils"

export default function PersonalizationPanel() {
  const { state, dispatch } = useDashboardPreferences()

  const fields = useMemo(
    () =>
      Object.entries(state.visibleFields).map(([key, visible]) => ({
        key,
        visible,
        label: key
          .replace(/_/g, " ")
          .replace(/\b\w/g, (char) => char.toUpperCase()),
      })),
    [state.visibleFields],
  )

  return (
    <Card className="border-none shadow-lg shadow-blue-100/50 bg-gradient-to-br from-blue-50/80 via-white to-white/90 backdrop-blur">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-slate-900 flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-blue-600" />
              Personalize Dashboard
            </CardTitle>
            <p className="text-sm text-slate-500 mt-1">
              Tailor widgets and presentation. Preferences persist for your device.
            </p>
          </div>
          <button
            className="text-xs font-medium text-blue-600 hover:text-blue-700 transition"
            type="button"
            onClick={() => dispatch({ type: "RESET" })}
          >
            Reset
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4">
          <SettingRow
            icon={Palette}
            title="Dark Mode"
            description="Reduce eye strain with a softer contrast palette."
          >
            <Switch
              checked={state.darkMode}
              onCheckedChange={(checked) =>
                dispatch({ type: "SET_DARK_MODE", enabled: checked })
              }
            />
          </SettingRow>
          <SettingRow
            icon={Layout}
            title="Layout Density"
            description="Choose the visual density for cards and tables."
          >
            <Select
              value={state.layoutStyle}
              onValueChange={(value) => dispatch({ type: "SET_LAYOUT", layout: value })}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Select layout" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="expanded">Expanded</SelectItem>
                <SelectItem value="compact">Compact</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow
            icon={Type}
            title="Font Size"
            description="Adjust the base font size for dashboards."
          >
            <Select
              value={state.fontSize}
              onValueChange={(value) => dispatch({ type: "SET_FONT", font: value })}
            >
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Select size" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="small">Small</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="large">Large</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Visible Columns</h3>
          <div className="grid sm:grid-cols-2 gap-2">
            {fields.map((field) => (
              <button
                key={field.key}
                type="button"
                onClick={() =>
                  dispatch({
                    type: "SET_FIELD_VISIBILITY",
                    field: field.key,
                    visible: !field.visible,
                  })
                }
                className={cn(
                  "flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition",
                  field.visible
                    ? "border-blue-200 bg-blue-50 text-blue-700"
                    : "border-slate-200 hover:border-blue-200 hover:bg-blue-50/40 hover:text-blue-600",
                )}
              >
                <span className="capitalize">{field.label}</span>
                <span
                  className={cn(
                    "h-2.5 w-2.5 rounded-full",
                    field.visible ? "bg-blue-500" : "bg-slate-300",
                  )}
                />
              </button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function SettingRow({ icon: Icon, title, description, children }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white/80 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100 text-blue-600">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <p className="text-sm font-semibold text-slate-800">{title}</p>
          <p className="text-xs text-slate-500">{description}</p>
        </div>
      </div>
      <div>{children}</div>
    </div>
  )
}
