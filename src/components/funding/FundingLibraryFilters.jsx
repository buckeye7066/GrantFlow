import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Search, RotateCw } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const STATES = [
  '', 'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
  'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
  'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
]

const DEADLINE_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'open', label: 'Open / rolling' },
  { value: 'soon', label: 'Closing soon (30d)' },
  { value: 'expired_excluded', label: 'Hide expired' },
]

const TRUST_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'official_api', label: 'Official API' },
  { value: 'official_portal', label: 'Official portal' },
  { value: 'verified_directory', label: 'Verified directory' },
  { value: 'community_directory', label: 'Community directory' },
  { value: 'open_web', label: 'Open web' },
  { value: 'manual_curated', label: 'Manual / curated' },
]

const APPLICANT_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'individual', label: 'Individual' },
  { value: 'family', label: 'Family' },
  { value: 'student', label: 'Student' },
  { value: 'church', label: 'Church' },
  { value: 'ministry', label: 'Ministry' },
  { value: 'nonprofit', label: 'Nonprofit' },
  { value: 'school', label: 'School' },
  { value: 'volunteer_fire_department', label: 'Volunteer Fire Dept.' },
  { value: 'small_business', label: 'Small business' },
  { value: 'business', label: 'Business' },
]

export default function FundingLibraryFilters({ filters, onChange, onReset, onRefresh, loading }) {
  const set = (k, v) => onChange({ ...filters, [k]: v })

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Filter the library</CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onReset}>Reset</Button>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
              <RotateCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label htmlFor="fl-q" className="text-xs">Search</Label>
          <div className="relative mt-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <Input
              id="fl-q"
              className="pl-7"
              placeholder="title, sponsor, description"
              value={filters.q || ''}
              onChange={(e) => set('q', e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">State</Label>
            <Select value={filters.state || ''} onValueChange={(v) => set('state', v)}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Any" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">Any</SelectItem>
                {STATES.filter(Boolean).map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Applicant type</Label>
            <Select value={filters.applicant_type || ''} onValueChange={(v) => set('applicant_type', v)}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Any" /></SelectTrigger>
              <SelectContent>
                {APPLICANT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Deadline</Label>
            <Select value={filters.deadline || ''} onValueChange={(v) => set('deadline', v)}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Any" /></SelectTrigger>
              <SelectContent>
                {DEADLINE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Source trust</Label>
            <Select value={filters.source_trust || ''} onValueChange={(v) => set('source_trust', v)}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Any" /></SelectTrigger>
              <SelectContent>
                {TRUST_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5 pt-1">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={Boolean(filters.include_unverified)}
              onChange={(e) => set('include_unverified', e.target.checked)}
            />
            Include unverified
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={Boolean(filters.include_loans)}
              onChange={(e) => set('include_loans', e.target.checked)}
            />
            Include loans / matching funds
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={filters.kind === 'direct_only'}
              onChange={(e) => set('kind', e.target.checked ? 'direct_only' : '')}
            />
            Direct grants only (hide directories)
          </label>
        </div>
      </CardContent>
    </Card>
  )
}
