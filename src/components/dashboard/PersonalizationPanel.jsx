import React, { useMemo } from "react"
import { Palette, Layout, Type, SlidersHorizontal, Eye, Bell, Grid3x3 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useDashboardPreferences } from "@/contexts/DashboardPreferencesContext.jsx"
import { cn } from "@/lib/utils"
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'

const COLOR_THEMES = [
  { value: 'blue', label: 'Ocean Blue', color: 'bg-blue-500' },
  { value: 'purple', label: 'Royal Purple', color: 'bg-purple-500' },
  { value: 'green', label: 'Forest Green', color: 'bg-green-500' },
  { value: 'orange', label: 'Sunset Orange', color: 'bg-orange-500' },
  { value: 'rose', label: 'Rose Pink', color: 'bg-rose-500' },
]

const WIDGET_LABELS = {
  pipelineStatus: 'Pipeline Status',
  recentGrants: 'Recent Grants',
  milestones: 'Milestones',
  analytics: 'Analytics',
  quickActions: 'Quick Actions',
  recentDocuments: 'Recent Documents',
}

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

  const widgets = useMemo(
    () =>
      state.widgetOrder.map((key) => ({
        key,
        visible: state.widgetVisibility[key],
        label: WIDGET_LABELS[key] || key,
      })),
    [state.widgetOrder, state.widgetVisibility],
  )

  const handleDragEnd = (result) => {
    if (!result.destination) return

    const items = Array.from(state.widgetOrder)
    const [reorderedItem] = items.splice(result.source.index, 1)
    items.splice(result.destination.index, 0, reorderedItem)

    dispatch({ type: "SET_WIDGET_ORDER", order: items })
  }

  return (
    <Card className="relative border border-border/70 shadow-lg bg-card/80 dark:bg-slate-900 text-card-foreground backdrop-blur">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-foreground flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-primary" />
              Personalize Dashboard
            </CardTitle>
            <p className="text-sm text-foreground mt-1">
              Customize your workspace with 10+ personalization options
            </p>
          </div>
          <button
            className="text-xs font-medium text-primary hover:opacity-90 transition"
            type="button"
            onClick={() => dispatch({ type: "RESET" })}
          >
            Reset All
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="appearance" className="w-full">
          <TabsList className="grid w-full grid-cols-3 gap-1">
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            <TabsTrigger value="widgets">Widgets</TabsTrigger>
            <TabsTrigger value="preferences">Preferences</TabsTrigger>
          </TabsList>

          {/* Appearance Tab */}
          <TabsContent value="appearance" className="space-y-4 mt-4">
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
              icon={Palette}
              title="Color Theme"
              description="Choose your primary accent color."
            >
              <div className="flex gap-2">
                {COLOR_THEMES.map((theme) => (
                  <button
                    key={theme.value}
                    type="button"
                    onClick={() => dispatch({ type: "SET_COLOR_THEME", theme: theme.value })}
                    className={cn(
                      "w-8 h-8 rounded-full transition-all",
                      theme.color,
                      state.colorTheme === theme.value
                        ? "ring-2 ring-ring ring-offset-2 ring-offset-background scale-110"
                        : "opacity-60 hover:opacity-100"
                    )}
                    title={theme.label}
                  />
                ))}
              </div>
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
              icon={Grid3x3}
              title="Dashboard Columns"
              description="Number of columns in dashboard layout."
            >
              <Select
                value={state.layoutColumns.toString()}
                onValueChange={(value) => dispatch({ type: "SET_LAYOUT_COLUMNS", columns: parseInt(value) })}
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Select columns" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Column</SelectItem>
                  <SelectItem value="2">2 Columns</SelectItem>
                  <SelectItem value="3">3 Columns</SelectItem>
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
          </TabsContent>

          {/* Widgets Tab */}
          <TabsContent value="widgets" className="space-y-4 mt-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                <Eye className="h-4 w-4" />
                Widget Visibility
              </h3>
              <div className="grid gap-2">
                {widgets.map((widget) => (
                  <div
                    key={widget.key}
                    className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2"
                  >
                    <Label htmlFor={`widget-${widget.key}`} className="text-sm font-medium cursor-pointer">
                      {widget.label}
                    </Label>
                    <Switch
                      id={`widget-${widget.key}`}
                      checked={widget.visible}
                      onCheckedChange={(checked) =>
                        dispatch({
                          type: "SET_WIDGET_VISIBILITY",
                          widget: widget.key,
                          visible: checked,
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-foreground mb-3">
                Widget Order (Drag to Reorder)
              </h3>
              <DragDropContext onDragEnd={handleDragEnd}>
                <Droppable droppableId="widgets">
                  {(provided) => (
                    <div
                      {...provided.droppableProps}
                      ref={provided.innerRef}
                      className="space-y-2"
                    >
                      {widgets.map((widget, index) => (
                        <Draggable
                          key={widget.key}
                          draggableId={widget.key}
                          index={index}
                        >
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              {...provided.dragHandleProps}
                              className={cn(
                                "flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 cursor-move transition-shadow",
                                snapshot.isDragging && "shadow-lg ring-2 ring-ring"
                              )}
                            >
                              <div className="flex flex-col gap-0.5">
                                <div className="w-4 h-0.5 bg-muted-foreground/40 rounded" />
                                <div className="w-4 h-0.5 bg-muted-foreground/40 rounded" />
                                <div className="w-4 h-0.5 bg-muted-foreground/40 rounded" />
                              </div>
                              <span className="text-sm font-medium flex-1">
                                {index + 1}. {widget.label}
                              </span>
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </DragDropContext>
            </div>
          </TabsContent>

          {/* Preferences Tab */}
          <TabsContent value="preferences" className="space-y-4 mt-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                <Bell className="h-4 w-4" />
                Notification Preferences
              </h3>
              <div className="grid gap-2">
                <div className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2">
                  <Label htmlFor="notif-email" className="text-sm font-medium cursor-pointer">
                    Email Notifications
                  </Label>
                  <Switch
                    id="notif-email"
                    checked={state.notificationPreferences.email}
                    onCheckedChange={(checked) =>
                      dispatch({
                        type: "SET_NOTIFICATION_PREFERENCE",
                        key: "email",
                        enabled: checked,
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2">
                  <Label htmlFor="notif-inapp" className="text-sm font-medium cursor-pointer">
                    In-App Notifications
                  </Label>
                  <Switch
                    id="notif-inapp"
                    checked={state.notificationPreferences.inApp}
                    onCheckedChange={(checked) =>
                      dispatch({
                        type: "SET_NOTIFICATION_PREFERENCE",
                        key: "inApp",
                        enabled: checked,
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2">
                  <Label htmlFor="notif-deadlines" className="text-sm font-medium cursor-pointer">
                    Deadline Reminders
                  </Label>
                  <Switch
                    id="notif-deadlines"
                    checked={state.notificationPreferences.deadlines}
                    onCheckedChange={(checked) =>
                      dispatch({
                        type: "SET_NOTIFICATION_PREFERENCE",
                        key: "deadlines",
                        enabled: checked,
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2">
                  <Label htmlFor="notif-opportunities" className="text-sm font-medium cursor-pointer">
                    New Opportunities
                  </Label>
                  <Switch
                    id="notif-opportunities"
                    checked={state.notificationPreferences.newOpportunities}
                    onCheckedChange={(checked) =>
                      dispatch({
                        type: "SET_NOTIFICATION_PREFERENCE",
                        key: "newOpportunities",
                        enabled: checked,
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border bg-background/60 px-3 py-2">
                  <Label htmlFor="notif-status" className="text-sm font-medium cursor-pointer">
                    Status Changes
                  </Label>
                  <Switch
                    id="notif-status"
                    checked={state.notificationPreferences.statusChanges}
                    onCheckedChange={(checked) =>
                      dispatch({
                        type: "SET_NOTIFICATION_PREFERENCE",
                        key: "statusChanges",
                        enabled: checked,
                      })
                    }
                  />
                </div>
              </div>
            </div>

            <SettingRow
              icon={Grid3x3}
              title="Data Density"
              description="Rows per page in tables and lists."
            >
              <Select
                value={state.dataDensity.toString()}
                onValueChange={(value) => dispatch({ type: "SET_DATA_DENSITY", density: parseInt(value) })}
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="Select density" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10 rows</SelectItem>
                  <SelectItem value="25">25 rows</SelectItem>
                  <SelectItem value="50">50 rows</SelectItem>
                  <SelectItem value="100">100 rows</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <div>
              <h3 className="text-sm font-semibold text-foreground mb-3">Visible Table Columns</h3>
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
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : "border-border hover:border-primary/30 hover:bg-primary/5 hover:text-primary",
                    )}
                  >
                    <span className="capitalize">{field.label}</span>
                    <span
                      className={cn(
                        "h-2.5 w-2.5 rounded-full",
                        field.visible ? "bg-primary" : "bg-muted-foreground/40",
                      )}
                    />
                  </button>
                ))}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function SettingRow({ icon: Icon, title, description, children }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background/60 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="text-xs text-foreground">{description}</p>
        </div>
      </div>
      <div>{children}</div>
    </div>
  )
}
