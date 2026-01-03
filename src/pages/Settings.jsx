import { useEffect, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, RotateCcw, Save, CheckCircle2 } from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'

export default function Settings() {
  const { preferences, isLoading, error, fetchPreferences, updatePreference, updatePreferences, resetPreferences } = useSettingsStore()
  const [saveStatus, setSaveStatus] = useState(null)
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    fetchPreferences()
  }, [fetchPreferences])

  const handleSave = async () => {
    setSaveStatus('saving')
    // The store already saves on every change, so we just show feedback
    setTimeout(() => {
      setSaveStatus('saved')
      setHasChanges(false)
      setTimeout(() => setSaveStatus(null), 2000)
    }, 500)
  }

  const handleReset = async () => {
    if (confirm('Are you sure you want to reset all settings to defaults?')) {
      await resetPreferences()
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus(null), 2000)
    }
  }

  const updateWithChange = (key, value) => {
    updatePreference(key, value)
    setHasChanges(true)
  }

  if (isLoading && !preferences) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="container max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Settings</h1>
          <p className="text-slate-600 mt-2">Manage your application preferences and personalization</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReset} disabled={isLoading}>
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset to Defaults
          </Button>
          <Button onClick={handleSave} disabled={!hasChanges || saveStatus === 'saving'}>
            {saveStatus === 'saving' && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {saveStatus === 'saved' && <CheckCircle2 className="h-4 w-4 mr-2" />}
            {!saveStatus && <Save className="h-4 w-4 mr-2" />}
            {saveStatus === 'saved' ? 'Saved' : 'Save Changes'}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="layout" className="space-y-6">
        <TabsList className="grid w-full grid-cols-5 lg:w-auto">
          <TabsTrigger value="layout">Layout</TabsTrigger>
          <TabsTrigger value="theme">Theme</TabsTrigger>
          <TabsTrigger value="display">Display</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="accessibility">Accessibility</TabsTrigger>
        </TabsList>

        {/* Layout Tab */}
        <TabsContent value="layout" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Layout Options</CardTitle>
              <CardDescription>Customize the layout and structure of your interface</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>Sidebar Position</Label>
                <Select 
                  value={preferences.sidebar_position} 
                  onValueChange={(value) => updateWithChange('sidebar_position', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="left">Left</SelectItem>
                    <SelectItem value="right">Right</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Sidebar Collapsed by Default</Label>
                  <p className="text-sm text-slate-500">Start with sidebar minimized</p>
                </div>
                <Switch
                  checked={preferences.sidebar_collapsed}
                  onCheckedChange={(checked) => updateWithChange('sidebar_collapsed', checked)}
                />
              </div>

              <Separator />

              <div className="space-y-2">
                <Label>Dashboard Layout</Label>
                <Select 
                  value={preferences.dashboard_layout} 
                  onValueChange={(value) => updateWithChange('dashboard_layout', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="grid">Grid View</SelectItem>
                    <SelectItem value="list">List View</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Card Density</Label>
                <Select 
                  value={preferences.card_density} 
                  onValueChange={(value) => updateWithChange('card_density', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="compact">Compact</SelectItem>
                    <SelectItem value="comfortable">Comfortable</SelectItem>
                    <SelectItem value="spacious">Spacious</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Table Row Density</Label>
                <Select 
                  value={preferences.table_row_density} 
                  onValueChange={(value) => updateWithChange('table_row_density', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="compact">Compact</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="spacious">Spacious</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Theme Tab */}
        <TabsContent value="theme" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Theme & Colors</CardTitle>
              <CardDescription>Customize the visual appearance of the application</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>Theme Mode</Label>
                <Select 
                  value={preferences.theme} 
                  onValueChange={(value) => updateWithChange('theme', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="system">System</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Accent Color</Label>
                <div className="grid grid-cols-4 gap-3">
                  {['blue', 'purple', 'green', 'orange', 'rose', 'cyan', 'amber', 'pink'].map((color) => (
                    <button
                      key={color}
                      onClick={() => updateWithChange('accent_color', color)}
                      className={`h-12 rounded-lg border-2 ${
                        preferences.accent_color === color ? 'border-slate-900 ring-2 ring-slate-900' : 'border-slate-200'
                      } bg-${color}-500 hover:scale-105 transition-transform`}
                      aria-label={`Select ${color} accent color`}
                    />
                  ))}
                </div>
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>High Contrast Mode</Label>
                  <p className="text-sm text-slate-500">Increase contrast for better visibility</p>
                </div>
                <Switch
                  checked={preferences.high_contrast}
                  onCheckedChange={(checked) => updateWithChange('high_contrast', checked)}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Display Tab */}
        <TabsContent value="display" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Display Preferences</CardTitle>
              <CardDescription>Configure how information is displayed</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>Default Landing Page</Label>
                <Select 
                  value={preferences.default_landing_page} 
                  onValueChange={(value) => updateWithChange('default_landing_page', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="/Dashboard">Dashboard</SelectItem>
                    <SelectItem value="/Pipeline">Pipeline</SelectItem>
                    <SelectItem value="/DiscoverGrants">Discover Grants</SelectItem>
                    <SelectItem value="/Organizations">Organizations</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Items Per Page</Label>
                <Select 
                  value={preferences.items_per_page.toString()} 
                  onValueChange={(value) => updateWithChange('items_per_page', parseInt(value))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="25">25</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Date Format</Label>
                <Select 
                  value={preferences.date_format} 
                  onValueChange={(value) => updateWithChange('date_format', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MM/DD/YYYY">MM/DD/YYYY (US)</SelectItem>
                    <SelectItem value="DD/MM/YYYY">DD/MM/YYYY (International)</SelectItem>
                    <SelectItem value="YYYY-MM-DD">YYYY-MM-DD (ISO)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Currency Display</Label>
                <Select 
                  value={preferences.currency_display} 
                  onValueChange={(value) => updateWithChange('currency_display', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD ($)</SelectItem>
                    <SelectItem value="EUR">EUR (€)</SelectItem>
                    <SelectItem value="GBP">GBP (£)</SelectItem>
                    <SelectItem value="CAD">CAD ($)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Timezone</Label>
                <Select 
                  value={preferences.timezone} 
                  onValueChange={(value) => updateWithChange('timezone', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="America/New_York">Eastern Time</SelectItem>
                    <SelectItem value="America/Chicago">Central Time</SelectItem>
                    <SelectItem value="America/Denver">Mountain Time</SelectItem>
                    <SelectItem value="America/Los_Angeles">Pacific Time</SelectItem>
                    <SelectItem value="UTC">UTC</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notifications Tab */}
        <TabsContent value="notifications" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Notification Preferences</CardTitle>
              <CardDescription>Manage how and when you receive notifications</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Email Notifications</Label>
                  <p className="text-sm text-slate-500">Receive updates via email</p>
                </div>
                <Switch
                  checked={preferences.email_notifications}
                  onCheckedChange={(checked) => updateWithChange('email_notifications', checked)}
                />
              </div>

              <div className="space-y-2">
                <Label>Grant Deadline Reminders</Label>
                <p className="text-sm text-slate-500 mb-2">Days before deadline to receive reminder</p>
                <Select 
                  value={preferences.grant_deadline_reminder_days.toString()} 
                  onValueChange={(value) => updateWithChange('grant_deadline_reminder_days', parseInt(value))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 day</SelectItem>
                    <SelectItem value="3">3 days</SelectItem>
                    <SelectItem value="7">7 days</SelectItem>
                    <SelectItem value="14">14 days</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Weekly Digest</Label>
                  <p className="text-sm text-slate-500">Receive weekly summary email</p>
                </div>
                <Switch
                  checked={preferences.weekly_digest}
                  onCheckedChange={(checked) => updateWithChange('weekly_digest', checked)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Browser Notifications</Label>
                  <p className="text-sm text-slate-500">Show desktop notifications</p>
                </div>
                <Switch
                  checked={preferences.browser_notifications}
                  onCheckedChange={(checked) => updateWithChange('browser_notifications', checked)}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Accessibility Tab */}
        <TabsContent value="accessibility" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Accessibility Options</CardTitle>
              <CardDescription>Customize the application for better accessibility</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>Font Size</Label>
                <Select 
                  value={preferences.font_size} 
                  onValueChange={(value) => updateWithChange('font_size', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="small">Small</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="large">Large</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Reduce Motion</Label>
                  <p className="text-sm text-slate-500">Minimize animations and transitions</p>
                </div>
                <Switch
                  checked={preferences.reduce_motion}
                  onCheckedChange={(checked) => updateWithChange('reduce_motion', checked)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Screen Reader Optimizations</Label>
                  <p className="text-sm text-slate-500">Enhanced support for screen readers</p>
                </div>
                <Switch
                  checked={preferences.screen_reader_optimized}
                  onCheckedChange={(checked) => updateWithChange('screen_reader_optimized', checked)}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
