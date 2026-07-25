// Generates qa/FEATURE_COVERAGE_MATRIX.md from the portfolio registry + manifests.
// Run: node qa/build-coverage-matrix.mjs
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const __dirname = dirname(fileURLToPath(import.meta.url))
const registry = JSON.parse(readFileSync(join(__dirname,'portfolio-registry.json'),'utf8'))
const rows = []
let totFeatures=0, totCovered=0, totJourneys=0
for (const app of registry.apps) {
  const mp = join(__dirname,'manifests',`${app.app_id}.json`)
  if (!existsSync(mp)) { rows.push(`| ${app.display_name} | ${app.runtime_type} | ${app.runtime_status} | — | — | no manifest |`); continue }
  const m = JSON.parse(readFileSync(mp,'utf8'))
  const cov = m.coverage||[]
  const automated = cov.filter(c=>Array.isArray(c.journeys)&&c.journeys.length).length
  const unaut = cov.filter(c=>!(Array.isArray(c.journeys)&&c.journeys.length)).length
  const nJourneys = (m.journeys||[]).length
  totFeatures += cov.length; totCovered += automated; totJourneys += nJourneys
  rows.push(`| ${app.display_name} | ${app.runtime_type} | ${app.runtime_status} | ${automated}/${cov.length} | ${nJourneys} | ${unaut} unautomated |`)
}
const md = `# EVA Feature Coverage Matrix

Auto-generated from \`qa/portfolio-registry.json\` + \`qa/manifests/*.json\` by
\`qa/build-coverage-matrix.mjs\`. Every portfolio app maps each advertised feature
to at least one automated journey **or** an explicit unautomated reason (enforced
by \`validateManifest\` + the totality test).

**Totals:** ${registry.apps.length} apps · ${totFeatures} features catalogued · ${totCovered} feature-groups with an automated journey · ${totJourneys} journeys defined.

| Program | Runtime | Status | Features automated | Journeys | Notes |
|---|---|---|---|---|---|
${rows.join('\n')}

## Reading this table

- **Status** is the truthful runtime availability from the registry
  (\`available\`, \`blocked_by_external_service\`, etc.). A blocked app still ships a
  manifest and a launch-smoke journey; its journeys report \`blocked\`, never a
  fabricated pass.
- **Features automated** = coverage entries backed by a journey ÷ total catalogued
  features. The remainder each carry an \`unautomated_reason\` in the manifest
  (e.g. "needs seeded DB fixture", "would submit real data — prohibited").
- **Journeys** = concrete end-user journeys defined in the manifest. Nightly runs
  execute each app's \`nightly_critical_journeys\`; the weekly run executes the full
  set.

Per-app prohibited-action policies and allowlists live in each
\`qa/manifests/<app_id>.json\`.
`
writeFileSync(join(__dirname,'FEATURE_COVERAGE_MATRIX.md'), md)
console.log('wrote FEATURE_COVERAGE_MATRIX.md ·', registry.apps.length,'apps ·',totFeatures,'features ·',totJourneys,'journeys')
