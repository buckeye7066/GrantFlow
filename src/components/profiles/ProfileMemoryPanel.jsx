import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createProfileMemory,
  deleteProfileMemory,
  listProfileMemory,
  updateProfileMemory,
} from '@/api/profileMemory'

function textValue(item) {
  if (typeof item?.value === 'string') return item.value
  if (item?.value && typeof item.value.text === 'string') return item.value.text
  return item?.value ? JSON.stringify(item.value, null, 2) : ''
}

function makeKey(title) {
  const stem = String(title || 'memory')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'memory'
  const suffix = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Date.now().toString(36)
  return `${stem}-${suffix}`
}

function MemoryItem({ item, profileId, onChanged }) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(() => textValue(item))
  const updateMutation = useMutation({
    mutationFn: () => updateProfileMemory(profileId, item.id, {
      title: item.title,
      kind: item.kind,
      value: { text: draft },
      source_kind: 'user',
      provenance: { edited_from: 'profile_memory_panel' },
    }),
    onSuccess: () => {
      setEditing(false)
      onChanged()
    },
  })
  const deleteMutation = useMutation({
    mutationFn: () => deleteProfileMemory(profileId, item.id),
    onSuccess: onChanged,
  })

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold text-slate-900">{item.title}</h4>
          <p className="mt-1 text-xs text-slate-500">
            {item.kind} · revision {item.current_revision} · {String(item.retention_policy).replace(/_/g, ' ')}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? 'Cancel' : 'Edit'}
          </button>
          <button
            type="button"
            className="rounded border border-red-200 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            disabled={deleteMutation.isPending}
            onClick={() => {
              if (window.confirm('Delete this memory? Stored values and revision payloads will be permanently redacted.')) {
                deleteMutation.mutate()
              }
            }}
          >
            {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
      {editing ? (
        <div className="mt-3 space-y-2">
          <textarea
            className="min-h-24 w-full rounded border border-slate-300 p-2 text-sm"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            disabled={updateMutation.isPending || !draft.trim()}
            onClick={() => updateMutation.mutate()}
          >
            {updateMutation.isPending ? 'Saving…' : 'Save new revision'}
          </button>
        </div>
      ) : (
        <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{textValue(item)}</p>
      )}
      {(updateMutation.error || deleteMutation.error) && (
        <p className="mt-2 text-xs text-red-700">
          {updateMutation.error?.message || deleteMutation.error?.message || 'Memory change failed.'}
        </p>
      )}
    </article>
  )
}

export default function ProfileMemoryPanel({ profileId }) {
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [kind, setKind] = React.useState('fact')
  const [text, setText] = React.useState('')
  const queryKey = ['profile-memory', profileId]
  const memoryQuery = useQuery({
    queryKey,
    queryFn: () => listProfileMemory(profileId),
    enabled: Boolean(profileId),
  })
  const payload = memoryQuery.data?.data ?? memoryQuery.data ?? {}
  const items = Array.isArray(payload.items) ? payload.items : []
  const refresh = () => queryClient.invalidateQueries({ queryKey })
  const createMutation = useMutation({
    mutationFn: () => createProfileMemory(profileId, {
      memory_key: makeKey(title),
      title,
      kind,
      value: { text },
      source_kind: 'user',
      provenance: { captured_from: 'profile_memory_panel' },
      retention_policy: 'profile_lifetime',
    }),
    onSuccess: () => {
      setTitle('')
      setText('')
      setKind('fact')
      setShowForm(false)
      refresh()
    },
  })

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/50 p-5" aria-labelledby="profile-memory-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="profile-memory-title" className="text-lg font-semibold text-slate-900">Organization memory</h3>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Keep reusable facts and preferences here. Every edit creates a revision; deletion permanently redacts stored content.
          </p>
        </div>
        <button
          type="button"
          className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          onClick={() => setShowForm((value) => !value)}
        >
          {showForm ? 'Cancel' : 'Add memory'}
        </button>
      </div>

      {showForm && (
        <div className="mt-4 grid gap-3 rounded-lg border border-blue-100 bg-white p-4">
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Title
            <input
              className="rounded border border-slate-300 px-3 py-2 font-normal"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Example: Preferred contact process"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Type
            <select
              className="rounded border border-slate-300 px-3 py-2 font-normal"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="fact">Fact</option>
              <option value="preference">Preference</option>
              <option value="relationship">Relationship</option>
              <option value="outcome">Outcome</option>
              <option value="narrative">Narrative</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Memory
            <textarea
              className="min-h-28 rounded border border-slate-300 p-3 font-normal"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Write a sourced, reusable fact—never a guess."
            />
          </label>
          <button
            type="button"
            className="w-fit rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            disabled={createMutation.isPending || !title.trim() || !text.trim()}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? 'Saving…' : 'Save memory'}
          </button>
          {createMutation.error && <p className="text-xs text-red-700">{createMutation.error.message}</p>}
        </div>
      )}

      <div className="mt-4 space-y-3">
        {memoryQuery.isLoading && <p className="text-sm text-slate-500">Loading organization memory…</p>}
        {memoryQuery.error && <p className="text-sm text-red-700">Could not load organization memory.</p>}
        {!memoryQuery.isLoading && !memoryQuery.error && items.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
            No reusable memory has been saved yet. Add a verified fact or preference when it will help future applications.
          </p>
        )}
        {items.map((item) => (
          <MemoryItem key={item.id} item={item} profileId={profileId} onChanged={refresh} />
        ))}
      </div>
    </section>
  )
}

