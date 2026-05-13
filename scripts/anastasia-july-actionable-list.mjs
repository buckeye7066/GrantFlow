#!/usr/bin/env node
/**
 * scripts/anastasia-july-actionable-list.mjs
 * List Anastasia's pipeline grants that can put cash in her hands by/around July 2026,
 * grouped by deadline urgency.
 */
const API = process.env.GF_API
const TOKEN = process.env.GF_TOKEN
if (!API || !TOKEN) { console.error('Missing GF_API or GF_TOKEN'); process.exit(2) }
const PROFILE_ID = 'c4a92724-9cee-416f-ba30-e91b9b5cd885'

const NEEDLES = [
  'emergency','rent','rental','liheap','salvation','greenhouse','catholic','modest','211',
  'dean of students','one stop','cash advance','book voucher','thda','home-arp','home arp','rapid rehousing',
  'dhs','family promise','united way','section 8','rural development',
  'pell','fseog','subsidized','hope','aspire','gams','tsaa','fafsa','true blue',
]

const r = await fetch(`${API}/grants?profile_id=${PROFILE_ID}&limit=2000`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
})
const grants = await r.json()
const norm = (s) => String(s || '').toLowerCase()
const matched = grants.filter((g) => NEEDLES.some((n) => norm(g.title).includes(n)))

const by = (key) => matched.filter(key).sort((a, b) => {
  const ad = a.deadline ? new Date(a.deadline).getTime() : Infinity
  const bd = b.deadline ? new Date(b.deadline).getTime() : Infinity
  return ad - bd
})

const fmt = (g) => `  [${(g.deadline || 'rolling').padEnd(10).slice(0, 10)}]  ${(g.status || '').padEnd(15).slice(0, 15)}  ${g.title}`

const today = new Date('2026-05-13')
const julyEnd = new Date('2026-07-31')
const augEnd = new Date('2026-08-31')

const rolling = matched.filter((g) => !g.deadline)
const dueByJuly = matched.filter((g) => g.deadline && new Date(g.deadline) <= julyEnd)
const dueByAug = matched.filter((g) => g.deadline && new Date(g.deadline) > julyEnd && new Date(g.deadline) <= augEnd)
const laterCycle = matched.filter((g) => g.deadline && new Date(g.deadline) > augEnd)

console.log(`\n=== ANASTASIA — JULY 2026 ACTIONABLE FUNDING (out of ${grants.length} total grants) ===`)

console.log(`\n--- ROLLING (apply NOW, fast turnaround) [${rolling.length}] ---`)
rolling.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0)).forEach(g => console.log(fmt(g)))

console.log(`\n--- DEADLINE BY END OF JULY 2026 [${dueByJuly.length}] ---`)
dueByJuly.forEach(g => console.log(fmt(g)))

console.log(`\n--- DEADLINE AUGUST 2026 (still in 2026-27 cycle) [${dueByAug.length}] ---`)
dueByAug.forEach(g => console.log(fmt(g)))

console.log(`\n--- LATER 2026-27/2027-28 CYCLE (renewal / sophomore year) [${laterCycle.length}] ---`)
laterCycle.forEach(g => console.log(fmt(g)))

const totalCash = rolling.length + dueByJuly.length + dueByAug.length
console.log(`\n>>> ${totalCash} programs are actionable for Fall-2026 / July-bridge purposes.`)
