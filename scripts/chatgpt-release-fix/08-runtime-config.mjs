import fs from 'node:fs'

const decode = (value) => Buffer.from(value, 'base64').toString('utf8')
const REPLACEMENTS = [
  {
    "path": "Dockerfile",
    "before": "Q09QWSAtLWZyb209YnVpbGRlciAvYXBwL2RvY3MvUGF5bWVudF9zaGVldF9HcmFudGZsb3dfMjAyNi0wNi0xNV9FWFRSQUNULm1kIC4vZG9jcy9QYXltZW50X3NoZWV0X0dyYW50Zmxvd18yMDI2LTA2LTE1X0VYVFJBQ1QubWQKQ09QWSAtLWZyb209YnVpbGRlciAvYXBwL2Rpc3QgLi9kaXN0",
    "after": "Q09QWSAtLWZyb209YnVpbGRlciAvYXBwL2RvY3MvUGF5bWVudF9zaGVldF9HcmFudGZsb3dfMjAyNi0wNi0xNV9FWFRSQUNULm1kIC4vZG9jcy9QYXltZW50X3NoZWV0X0dyYW50Zmxvd18yMDI2LTA2LTE1X0VYVFJBQ1QubWQKQ09QWSAtLWZyb209YnVpbGRlciAvYXBwL2RvY3MvcHJvZHVjdGlvbi1yZWFkaW5lc3MvZ3JhbnRmbG93Lm1kIC4vZG9jcy9wcm9kdWN0aW9uLXJlYWRpbmVzcy9ncmFudGZsb3cubWQKQ09QWSAtLWZyb209YnVpbGRlciAvYXBwL2Rpc3QgLi9kaXN0",
    "label": "Docker evidence artifact copy"
  }
]

function replaceOnce(path, beforeEncoded, afterEncoded, label) {
  const before = decode(beforeEncoded)
  const after = decode(afterEncoded)
  const source = fs.readFileSync(path, 'utf8')
  const first = source.indexOf(before)
  if (first < 0) throw new Error(path + ': missing expected source for ' + label)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(path + ': expected exactly one source block for ' + label)
  }
  fs.writeFileSync(path, source.slice(0, first) + after + source.slice(first + before.length))
}

for (const replacement of REPLACEMENTS) {
  replaceOnce(replacement.path, replacement.before, replacement.after, replacement.label)
}

const file = 'vercel.json'
const config = JSON.parse(fs.readFileSync(file, 'utf8'))
if (!config.rewrites.some((rule) => rule.source === '/release-identity.json')) {
  const index = config.rewrites.findIndex((rule) => rule.source === '/deployment-version.json')
  if (index < 0) throw new Error('deployment-version rewrite missing')
  config.rewrites.splice(index + 1, 0, { source: '/release-identity.json', destination: '/assets/release-identity.json' })
}
if (!config.headers.some((rule) => rule.source === '/release-identity.json')) {
  const index = config.headers.findIndex((rule) => rule.source === '/deployment-version.json')
  if (index < 0) throw new Error('deployment-version header missing')
  config.headers.splice(index + 1, 0, {
    source: '/release-identity.json',
    headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
  })
}
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n')

console.log('Applied runtime-config.')
