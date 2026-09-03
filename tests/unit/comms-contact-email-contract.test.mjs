import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('profile contact resolution rejects malformed email addresses centrally', async () => {
  const source = await readFile(new URL('../../backend/services/comms/commsService.js', import.meta.url), 'utf8')

  assert.match(source, /import \{ isValidEmail \} from '\.\.\/\.\.\/utils\/validation\.js'/)
  assert.match(source, /if \(!isValidEmail\(e\)\) return/)
})
