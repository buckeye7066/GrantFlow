import fs from 'node:fs'
import path from 'node:path'

const outDir = path.resolve('public', '_materialized-link-safety')
fs.mkdirSync(outDir, { recursive: true })

const files = [
  'backend/services/linkBacklogRepairService.js',
  'backend/routes/linkBacklogRepair.js',
  'backend/tests/linkBacklogRepairService.test.js',
  'backend/tests/linkBacklogSafetyRegression.test.js',
]

for (const file of files) {
  fs.copyFileSync(path.resolve(file), path.join(outDir, path.basename(file)))
}

console.log(`[materialized-link-safety-export] exported ${files.length} generated product files`)
