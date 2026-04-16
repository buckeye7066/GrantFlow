import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '@/api/apiClient'

export default function AdminExclusionRules() {
    const [rules, setRules] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [newPattern, setNewPattern] = useState('')
    const [newAction, setNewAction] = useState('hide')
    const [saving, setSaving] = useState(false)

  const fetchRules = useCallback(() => {
        setLoading(true)
        apiFetch('/api/admin/exclusion-rules')
          .then(r => {
                    setRules(Array.isArray(r?.rules) ? r.rules : [])
                    setError(null)
          })
          .catch(err => {
                    console.error('[AdminExclusionRules] Failed to load rules:', err)
                    setError('Failed to load exclusion rules.')
          })
          .finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchRules() }, [fetchRules])

  const handleAdd = async () => {
        const trimmed = newPattern.trim()
        if (!trimmed) return
        setSaving(true)
        try {
                await apiFetch('/api/admin/exclusion-rules', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ pattern: trimmed, action: newAction }),
                })
                setNewPattern('')
                fetchRules()
        } catch (err) {
                console.error('[AdminExclusionRules] Failed to add rule:', err)
                setError('Failed to add rule.')
        } finally {
                setSaving(false)
        }
  }

  const handleDelete = async (ruleId) => {
        if (!confirm('Delete this exclusion rule?')) return
        try {
                await apiFetch(`/api/admin/exclusion-rules/${ruleId}`, { method: 'DELETE' })
                fetchRules()
        } catch (err) {
                console.error('[AdminExclusionRules] Failed to delete rule:', err)
                setError('Failed to delete rule.')
        }
  }

  return (
        <div className="space-y-4">
              <h2 className="text-xl font-bold">Exclusion Rules</h2>h2>
              <p className="text-sm text-gray-600">
                      Define patterns to automatically hide or flag opportunities that should not appear in results.
                      Patterns are matched against opportunity titles and descriptions (case-insensitive).
              </p>p>
        
          {/* Add new rule form */}
              <div className="flex gap-2 items-end border p-3 rounded bg-gray-50">
                      <div className="flex-1">
                                <label className="block text-xs font-medium mb-1">Pattern (text or regex)</label>label>
                                <input
                                              type="text"
                                              className="w-full border rounded px-2 py-1 text-sm"
                                              placeholder='e.g. "loan" or "payday|cash advance"'
                                              value={newPattern}
                                              onChange={e => setNewPattern(e.target.value)}
                                              onKeyDown={e => e.key === 'Enter' && handleAdd()}
                                            />
                      </div>div>
                      <div>
                                <label className="block text-xs font-medium mb-1">Action</label>label>
                                <select
                                              className="border rounded px-2 py-1 text-sm"
                                              value={newAction}
                                              onChange={e => setNewAction(e.target.value)}
                                            >
                                            <option value="hide">Hide</option>option>
                                            <option value="flag">Flag</option>option>
                                            <option value="watch">Watch</option>option>
                                </select>select>
                      </div>div>
                      <button
                                  className="bg-blue-600 text-white px-3 py-1 rounded text-sm disabled:opacity-50"
                                  onClick={handleAdd}
                                  disabled={saving || !newPattern.trim()}
                                >
                        {saving ? 'Adding...' : 'Add Rule'}
                      </button>button>
              </div>div>
        
          {error && <div className="text-red-600 text-sm">{error}</div>div>}
        
          {loading ? (
                  <div className="text-sm text-gray-500">Loading exclusion rules...</div>div>
                ) : rules.length === 0 ? (
                  <div className="border border-dashed rounded p-6 text-center text-gray-500">
                            <p className="font-medium">No exclusion rules configured yet.</p>p>
                            <p className="text-sm mt-1">
                                        Add patterns above to filter out loan offers, expired programs, or irrelevant results
                                        from opportunity matching.
                            </p>p>
                  </div>div>
                ) : (
                  <div className="space-y-2">
                    {rules.map(rule => (
                                <div key={rule.rule_id} className="border p-3 rounded flex items-center justify-between">
                                              <div>
                                                              <div className="font-mono text-sm">{rule.pattern}</div>div>
                                                              <div className="text-xs text-gray-500">Action: <span className="font-medium">{rule.action}</span>span></div>div>
                                              </div>div>
                                              <button
                                                                className="text-red-600 text-xs hover:underline"
                                                                onClick={() => handleDelete(rule.rule_id)}
                                                              >
                                                              Delete
                                              </button>button>
                                </div>div>
                              ))}
                  </div>div>
              )}
        </div>div>
      )
}</div>
