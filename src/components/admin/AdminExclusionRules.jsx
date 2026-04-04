import { useEffect, useState } from 'react'
import { apiFetch } from '@/api/apiClient'

export default function AdminExclusionRules() {
  const [rules, setRules] = useState([])

  useEffect(() => {
    apiFetch('/api/admin/exclusion-rules')
      .then(r => setRules(r.rules))
      .catch(err => console.error('[AdminExclusionRules] Failed to load rules:', err))
  }, [])

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Exclusion Rules</h2>

      {rules.map(rule => (
        <div key={rule.rule_id} className="border p-3 rounded">
          <div className="font-mono text-sm">{rule.pattern}</div>
          <div className="text-xs">{rule.action}</div>
        </div>
      ))}
    </div>
  )
}
