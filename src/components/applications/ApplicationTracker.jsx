import React, { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useToast } from '@/components/ui/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Plus, Trash2, CheckCircle, XCircle, Send, Filter } from 'lucide-react'
import { listProfiles } from '@/api/profiles'
import {
  listApplications,
  createApplication,
  updateApplication,
  deleteApplication,
  submitApplication,
  recordOutcome,
} from '@/api/grantApplications'
import { differenceInDays, parseISO, isValid } from 'date-fns'

// Status configuration
const STATUSES = [
  { key: 'draft', label: 'Draft', color: 'bg-slate-100 text-slate-700' },
  { key: 'in_progress', label: 'In Progress', color: 'bg-blue-100 text-blue-700' },
  { key: 'submitted', label: 'Submitted', color: 'bg-indigo-100 text-indigo-700' },
  { key: 'under_review', label: 'Under Review', color: 'bg-yellow-100 text-yellow-700' },
  { key: 'awarded', label: 'Awarded', color: 'bg-green-100 text-green-700' },
  { key: 'denied', label: 'Denied', color: 'bg-red-100 text-red-700' },
]

const STATUS_COLUMNS = [
  { key: 'draft', label: 'Draft' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'under_review', label: 'Under Review' },
  { key: 'awarded', label: 'Awarded' },
  { key: 'denied', label: 'Denied' },
]

// Status progression — next logical status for "Move Forward" button
const NEXT_STATUS = {
  draft: 'in_progress',
  in_progress: null, // uses submit action
  submitted: 'under_review',
  under_review: null, // uses outcome action
  awarded: null,
  denied: null,
}
const NEXT_STATUS_LABEL = {
  draft: 'Start Application',
  submitted: 'Mark Under Review',
}

function daysUntilDeadline(deadlineDateStr) {
  if (!deadlineDateStr) return null
  try {
    const d = parseISO(deadlineDateStr)
    if (!isValid(d)) return null
    return differenceInDays(d, new Date())
  } catch {
    return null
  }
}

function formatCurrency(amount) {
  if (amount === null) return null
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount)
}

function StatusBadge({ status }) {
  const cfg = STATUSES.find((s) => s.key === status) || STATUSES[0]
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cfg.color}`}>
      {cfg.label}
    </span>
  )
}

// ── Application Card ─────────────────────────────────────────────────────────
function ApplicationCard({ app, onEdit, onDelete, onSubmit, onOutcome, onMoveForward }) {
  const days = daysUntilDeadline(app.deadline_date)
  const deadlineUrgent = days !== null && days >= 0 && days < 7
  const deadlinePast = days !== null && days < 0

  return (
    <Card className="mb-3 shadow-sm hover:shadow-md transition-shadow">
      <CardContent className="pt-4 pb-3 px-4">
        <div className="flex items-start justify-between gap-2 mb-1">
          <p className="text-sm font-semibold text-slate-900 leading-tight line-clamp-2">{app.grant_name || app.grant_title || "Untitled application"}</p>
        </div>
        {app.funder_name && (
          <p className="text-xs text-slate-500 mb-1">{app.funder_name}</p>
        )}
        {app.amount_requested !== null && (
          <p className="text-xs text-slate-600 mb-1">Requested: <span className="font-medium">{formatCurrency(app.amount_requested)}</span></p>
        )}
        {app.status === 'awarded' && app.amount_awarded !== null && (
          <p className="text-xs text-green-700 mb-1">Awarded: <span className="font-medium">{formatCurrency(app.amount_awarded)}</span></p>
        )}
        {app.deadline_date && (
          <p className={`text-xs mb-2 ${deadlinePast ? 'text-slate-400 line-through' : deadlineUrgent ? 'text-red-600 font-semibold' : 'text-slate-500'}`}>
            Deadline: {app.deadline_date}
            {days !== null && !deadlinePast && (
              <span className={`ml-1 ${deadlineUrgent ? 'text-red-600' : 'text-slate-400'}`}>
                ({days === 0 ? 'today' : `${days}d`})
              </span>
            )}
            {deadlinePast && <span className="ml-1 text-slate-400">(past)</span>}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          <Button size="sm" variant="outline" className="text-xs h-7 px-2" onClick={() => onEdit(app)}>
            Edit
          </Button>

          {NEXT_STATUS[app.status] && (
            <Button
              size="sm"
              variant="outline"
              className="text-xs h-7 px-2 text-blue-700 border-blue-200 hover:bg-blue-50"
              onClick={() => onMoveForward(app, NEXT_STATUS[app.status])}
            >
              {NEXT_STATUS_LABEL[app.status] || `→ ${STATUSES.find(s => s.key === NEXT_STATUS[app.status])?.label}`}
            </Button>
          )}

          {app.status === 'in_progress' && (
            <Button
              size="sm"
              variant="outline"
              className="text-xs h-7 px-2 text-indigo-700 border-indigo-200 hover:bg-indigo-50"
              onClick={() => onSubmit(app)}
            >
              <Send className="w-3 h-3 mr-1" />
              Mark Submitted
            </Button>
          )}

          {app.status === 'under_review' && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="text-xs h-7 px-2 text-green-700 border-green-200 hover:bg-green-50"
                onClick={() => onOutcome(app, 'awarded')}
              >
                <CheckCircle className="w-3 h-3 mr-1" />
                Awarded
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-xs h-7 px-2 text-red-700 border-red-200 hover:bg-red-50"
                onClick={() => onOutcome(app, 'denied')}
              >
                <XCircle className="w-3 h-3 mr-1" />
                Denied
              </Button>
            </>
          )}

          {app.status !== 'submitted' && (
            <Button
              size="sm"
              variant="ghost"
              className="text-xs h-7 px-2 text-red-500 hover:text-red-700 hover:bg-red-50 ml-auto"
              onClick={() => onDelete(app)}
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ── New / Edit Application Form ───────────────────────────────────────────────
const EMPTY_FORM = {
  grant_name: '',
  funder_name: '',
  amount_requested: '',
  deadline_date: '',
  notes: '',
  contact_name: '',
  contact_email: '',
  profile_id: '',
  status: 'draft',
}

function ApplicationForm({ initialValues, profiles, onSave, onCancel, isSaving }) {
  const [form, setForm] = useState(() => ({
    ...EMPTY_FORM,
    ...(initialValues || {}),
    // initialValues is undefined on the "New Application" path — guard the whole
    // chain (optional chaining + nullish default) so we never read a property off
    // undefined. `?? ''` also covers null (DB default) and keeps 0 as "0".
    amount_requested: String(initialValues?.amount_requested ?? ''),
    // Ensure Select-bound fields are always strings (DB may return null)
    profile_id: initialValues?.profile_id ?? '',
    status: initialValues?.status ?? 'draft',
  }))

  const [errors, setErrors] = useState({})

  function set(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
    // Clear a field's error as soon as the user edits it.
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev))
  }

  function handleSubmit(e) {
    e.preventDefault()
    // Validate with visible, field-level feedback instead of a silent no-op.
    const nextErrors = {}
    if (!form.grant_name.trim()) nextErrors.grant_name = 'Grant name is required.'
    if (!form.profile_id) nextErrors.profile_id = 'Select a profile for this application.'
    if (form.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contact_email.trim())) {
      nextErrors.contact_email = 'Enter a valid email address (e.g. name@example.org).'
    }
    if (form.amount_requested !== '') {
      const amt = Number(form.amount_requested)
      if (!Number.isFinite(amt) || amt < 0) {
        nextErrors.amount_requested = 'Amount must be zero or a positive number.'
      } else if (amt > 1000000000) {
        nextErrors.amount_requested = 'Amount looks too large — enter an amount up to $1,000,000,000.'
      }
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      return
    }

    setErrors({})
    const payload = {
      ...form,
      amount_requested: form.amount_requested !== '' ? Number(form.amount_requested) : null,
    }
    onSave(payload)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Grant Name <span className="text-red-500">*</span></label>
        <input
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          value={form.grant_name}
          onChange={(e) => set('grant_name', e.target.value)}
          required
          placeholder="e.g. Community Development Block Grant"
        />
        {errors.grant_name && <p className="mt-1 text-xs text-red-600">{errors.grant_name}</p>}
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Profile <span className="text-red-500">*</span></label>
        <Select value={form.profile_id} onValueChange={(v) => set('profile_id', v)} required>
          <SelectTrigger>
            <SelectValue placeholder="Select profile…" />
          </SelectTrigger>
          <SelectContent>
            {profiles.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.display_name || p.organization_name || p.name || p.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.profile_id && <p className="mt-1 text-xs text-red-600">{errors.profile_id}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Funder Name</label>
          <input
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            value={form.funder_name}
            onChange={(e) => set('funder_name', e.target.value)}
            placeholder="e.g. HUD"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Amount Requested ($)</label>
          <input
            type="number"
            min="0"
            max="1000000000"
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            value={form.amount_requested}
            onChange={(e) => set('amount_requested', e.target.value)}
            placeholder="0"
          />
          {errors.amount_requested && <p className="mt-1 text-xs text-red-600">{errors.amount_requested}</p>}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Deadline Date</label>
        <input
          type="date"
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          value={form.deadline_date}
          onChange={(e) => set('deadline_date', e.target.value)}
        />
      </div>

      {initialValues && (
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
          <Select value={form.status} onValueChange={(v) => set('status', v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
        <textarea
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          rows={3}
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          placeholder="Optional notes…"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Contact Name</label>
          <input
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            value={form.contact_name}
            onChange={(e) => set('contact_name', e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Contact Email</label>
          <input
            type="email"
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            value={form.contact_email}
            onChange={(e) => set('contact_email', e.target.value)}
          />
          {errors.contact_email && <p className="mt-1 text-xs text-red-600">{errors.contact_email}</p>}
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSaving}>
          {isSaving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ── Outcome Dialog ────────────────────────────────────────────────────────────
function OutcomeDialog({ app, outcome, onConfirm, onCancel, isSaving }) {
  const [amountAwarded, setAmountAwarded] = useState('')
  const [notes, setNotes] = useState(app?.notes || '')

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Record <strong>{outcome === 'awarded' ? 'awarded' : 'denied'}</strong> outcome for <strong>{app?.grant_name}</strong>.
      </p>

      {outcome === 'awarded' && (
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Amount Awarded ($)</label>
          <input
            type="number"
            min="0"
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            value={amountAwarded}
            onChange={(e) => setAmountAwarded(e.target.value)}
            placeholder="0"
          />
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
        <textarea
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={isSaving}>Cancel</Button>
        <Button
          onClick={() => onConfirm({ outcome, amount_awarded: amountAwarded !== '' ? Number(amountAwarded) : null, notes })}
          disabled={isSaving}
          className={outcome === 'awarded' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}
        >
          {isSaving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : `Confirm ${outcome === 'awarded' ? 'Awarded' : 'Denied'}`}
        </Button>
      </DialogFooter>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function ApplicationTracker() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [filterProfileId, setFilterProfileId] = useState('all')
  const [showNewForm, setShowNewForm] = useState(false)
  const [editingApp, setEditingApp] = useState(null)
  const [deletingApp, setDeletingApp] = useState(null)
  const [outcomeApp, setOutcomeApp] = useState(null) // { app, outcome }

  // Load profiles for filter & form
  const profilesQuery = useQuery({
    queryKey: ['profiles', 'app-tracker'],
    queryFn: () => listProfiles({ summary: true }),
    staleTime: 60_000,
  })
  const profiles = Array.isArray(profilesQuery.data) ? profilesQuery.data : []

  // Load applications
  const appsQuery = useQuery({
    queryKey: ['grant-applications', filterProfileId],
    queryFn: () => listApplications(filterProfileId !== 'all' ? { profile_id: filterProfileId } : {}),
    staleTime: 30_000,
  })
  const apps = Array.isArray(appsQuery.data) ? appsQuery.data : []

  // Group by status
  const byStatus = useMemo(() => {
    const map = {}
    for (const col of STATUS_COLUMNS) map[col.key] = []
    for (const app of apps) {
      if (map[app.status]) map[app.status].push(app)
      else map['draft'].push(app) // fallback
    }
    return map
  }, [apps])

  // ── Mutations ─────────────────────────────────────────────────────────────
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['grant-applications'] })

  const createMutation = useMutation({
    mutationFn: createApplication,
    onSuccess: () => { invalidate(); setShowNewForm(false); toast({ title: 'Application created' }) },
    onError: (err) => toast({ variant: 'destructive', title: 'Error', description: err?.message }),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateApplication(id, data),
    onSuccess: () => { invalidate(); setEditingApp(null); toast({ title: 'Application updated' }) },
    onError: (err) => toast({ variant: 'destructive', title: 'Error', description: err?.message }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteApplication(id),
    onSuccess: () => { invalidate(); setDeletingApp(null); toast({ title: 'Application deleted' }) },
    onError: (err) => toast({ variant: 'destructive', title: 'Error', description: err?.message }),
  })

  const submitMutation = useMutation({
    mutationFn: (id) => submitApplication(id),
    onSuccess: () => { invalidate(); toast({ title: 'Marked as submitted' }) },
    onError: (err) => toast({ variant: 'destructive', title: 'Error', description: err?.message }),
  })

  const outcomeMutation = useMutation({
    mutationFn: ({ id, data }) => recordOutcome(id, data),
    onSuccess: () => { invalidate(); setOutcomeApp(null); toast({ title: 'Outcome recorded' }) },
    onError: (err) => toast({ variant: 'destructive', title: 'Error', description: err?.message }),
  })

  const moveForwardMutation = useMutation({
    mutationFn: ({ id, status }) => updateApplication(id, { status }),
    onSuccess: () => { invalidate() },
    onError: (err) => toast({ variant: 'destructive', title: 'Error', description: err?.message }),
  })

  // ── Handlers ──────────────────────────────────────────────────────────────
  function handleSaveNew(data) { createMutation.mutate(data) }
  function handleSaveEdit(data) { updateMutation.mutate({ id: editingApp.id, data }) }
  function handleDelete() { deleteMutation.mutate(deletingApp.id) }
  function handleSubmit(app) { submitMutation.mutate(app.id) }
  function handleOutcomeIntent(app, outcome) { setOutcomeApp({ app, outcome }) }
  function handleOutcomeConfirm(data) { outcomeMutation.mutate({ id: outcomeApp.app.id, data }) }
  function handleMoveForward(app, status) { moveForwardMutation.mutate({ id: app.id, status }) }

  const isLoading = appsQuery.isLoading || profilesQuery.isLoading

  return (
    <div className="p-6 md:p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-bold text-foreground">Application Tracker</h1>
          <p className="text-slate-600 mt-1">
            Track every application from draft to outcome — {apps.length} total
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:justify-end md:shrink-0">
          {profiles.length > 1 && (
            <>
              <Filter className="w-4 h-4 text-slate-500" />
              <Select value={filterProfileId} onValueChange={setFilterProfileId}>
                <SelectTrigger className="w-52">
                  <SelectValue placeholder="Filter by profile…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All profiles</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.display_name || p.organization_name || p.name || p.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
          <Button onClick={() => setShowNewForm(true)}>
            <Plus className="w-4 h-4 mr-2" />
            New Application
          </Button>
        </div>
      </div>

      {/* Kanban Board */}
      {isLoading ? (
        <div className="flex justify-center items-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 overflow-x-auto">
          {STATUS_COLUMNS.map((col) => (
            <div key={col.key} className="min-w-[200px]">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-slate-700">{col.label}</h2>
                <span className="text-xs text-slate-400 bg-slate-100 rounded-full px-2 py-0.5">
                  {byStatus[col.key].length}
                </span>
              </div>
              <div className="space-y-0">
                {byStatus[col.key].length === 0 ? (
                  <div className="border-2 border-dashed border-slate-200 rounded-lg p-4 text-center text-xs text-slate-400">
                    None
                  </div>
                ) : (
                  byStatus[col.key].map((app) => (
                    <ApplicationCard
                      key={app.id}
                      app={app}
                      onEdit={setEditingApp}
                      onDelete={setDeletingApp}
                      onSubmit={handleSubmit}
                      onOutcome={handleOutcomeIntent}
                      onMoveForward={handleMoveForward}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New Application Dialog */}
      <Dialog open={showNewForm} onOpenChange={setShowNewForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Application</DialogTitle>
          </DialogHeader>
          <ApplicationForm
            profiles={profiles}
            onSave={handleSaveNew}
            onCancel={() => setShowNewForm(false)}
            isSaving={createMutation.isPending}
          />
        </DialogContent>
      </Dialog>

      {/* Edit Application Dialog */}
      <Dialog open={Boolean(editingApp)} onOpenChange={(open) => { if (!open) setEditingApp(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Application</DialogTitle>
          </DialogHeader>
          {editingApp && (
            <ApplicationForm
              initialValues={editingApp}
              profiles={profiles}
              onSave={handleSaveEdit}
              onCancel={() => setEditingApp(null)}
              isSaving={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Outcome Dialog */}
      <Dialog open={Boolean(outcomeApp)} onOpenChange={(open) => { if (!open) setOutcomeApp(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Outcome</DialogTitle>
          </DialogHeader>
          {outcomeApp && (
            <OutcomeDialog
              app={outcomeApp.app}
              outcome={outcomeApp.outcome}
              onConfirm={handleOutcomeConfirm}
              onCancel={() => setOutcomeApp(null)}
              isSaving={outcomeMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={Boolean(deletingApp)} onOpenChange={(open) => { if (!open) setDeletingApp(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Application?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{deletingApp?.grant_name}</strong>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deleting…</>
              ) : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
