import fs from 'node:fs'

const file = 'backend/server.js'
let source = fs.readFileSync(file, 'utf8')
const signature = "app.use('/api/admin/web-parity'"
if (source.includes(signature)) {
  console.log('[source-materialization] web-parity admin route already mounted')
} else {
  const marker = "app.use('/api/admin/link-repair', lazyRouter('./routes/linkBacklogRepair.js'))"
  const first = source.indexOf(marker)
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error('[web-parity-admin] link-repair route marker missing or ambiguous')
  }
  const addition = "\napp.use('/api/admin/web-parity', lazyRouter('./routes/webParityAdmin.js'))"
  source = source.slice(0, first + marker.length) + addition + source.slice(first + marker.length)
  fs.writeFileSync(file, source)
  console.log('[source-materialization] web-parity background admin route mounted')
}
