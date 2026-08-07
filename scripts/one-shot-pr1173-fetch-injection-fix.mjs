import fs from 'node:fs'

function replaceOnce(path, before, after) {
  const source = fs.readFileSync(path, 'utf8')
  if (source.split(before).length !== 2) throw new Error(`${path}: expected one match`)
  fs.writeFileSync(path, source.replace(before, after))
}

function replaceAllRequired(path, before, after) {
  const source = fs.readFileSync(path, 'utf8')
  const count = source.split(before).length - 1
  if (count < 1) throw new Error(`${path}: expected at least one match`)
  fs.writeFileSync(path, source.split(before).join(after))
}

replaceOnce(
  'backend/services/linkVerificationService.js',
  `      }, { timeoutMs })`,
  `      }, { timeoutMs, fetchImpl: opts.fetchImpl })`,
)
replaceOnce(
  'backend/services/linkVerificationService.js',
  `  { limit = 100, verifiedBy = 'recurring-verifier' } = {},`,
  `  { limit = 100, verifiedBy = 'recurring-verifier', fetchImpl } = {},`,
)
replaceOnce(
  'backend/services/linkVerificationService.js',
  `        const result = await checkUrl(url)`,
  `        const result = await checkUrl(url, { fetchImpl })`,
)

replaceOnce(
  'backend/services/linkBacklogRepairService.js',
  `async function probeRow(row, timeoutMs) {`,
  `async function probeRow(row, timeoutMs, fetchImpl) {`,
)
replaceOnce(
  'backend/services/linkBacklogRepairService.js',
  `      const result = await checkUrl(entry.url, { timeoutMs })`,
  `      const result = await checkUrl(entry.url, { timeoutMs, fetchImpl })`,
)
replaceOnce(
  'backend/services/linkBacklogRepairService.js',
  `  const findOfficialUrlImpl = options.findOfficialUrlImpl || findOfficialUrlForOpportunity`,
  `  const findOfficialUrlImpl = options.findOfficialUrlImpl || findOfficialUrlForOpportunity
  const fetchImpl = options.fetchImpl`,
)
replaceOnce(
  'backend/services/linkBacklogRepairService.js',
  `      let result = await probeRow(row, timeoutMs)`,
  `      let result = await probeRow(row, timeoutMs, fetchImpl)`,
)

for (const path of [
  'backend/tests/linkBacklogSafetyRegression.test.js',
  'backend/tests/linkBacklogRepairService.test.js',
]) {
  replaceAllRequired(
    path,
    `repairBrokenDirectBatch(db, {\n`,
    `repairBrokenDirectBatch(db, {\n      fetchImpl: globalThis.fetch,\n`,
  )
}
replaceAllRequired(
  'backend/tests/linkVerificationQuarantine.test.js',
  `runLinkVerification(db, {\n`,
  `runLinkVerification(db, {\n        fetchImpl: globalThis.fetch,\n`,
)
replaceOnce(
  'backend/tests/linkVerificationQuarantine.test.js',
  `runLinkVerification(db, { limit: 10, verifiedBy: 'deadline-race-test' })`,
  `runLinkVerification(db, { limit: 10, verifiedBy: 'deadline-race-test', fetchImpl: globalThis.fetch })`,
)

console.log('Applied explicit test probe transport injection')
