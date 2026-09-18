import { expect, it } from 'vitest'
import { resolveFunderApplicationLink } from './funderApplicationLink.js'

it.each(['not a url', '://broken', 'javascript:alert(1)'])('an invalid selected target preserves a safe information link: %s', apply_url => {
  expect(resolveFunderApplicationLink({ apply_url, source_url:'https://www.tn.gov/collegepays' }))
    .toBe('https://www.tn.gov/collegepays')
})
it('does not turn a refused target into its own informational fallback', () => {
  expect(resolveFunderApplicationLink({ apply_url:'https://alpha.grantable.co/login',
    url:'https://alpha.grantable.co/login' })).toBeNull()
})
