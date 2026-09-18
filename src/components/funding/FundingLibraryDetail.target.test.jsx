// @vitest-environment jsdom
import React from 'react'
import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import FundingLibraryDetail from './FundingLibraryDetail.jsx'

it.each(['https://alpha.grantable.co/login','https://www.facebook.com/foundation'])('the library labels a refused target as source navigation, never an application: %s', apply_url => {
  render(<FundingLibraryDetail open item={{id:'lib',title:'Community grant',apply_url,
    application_url:'https://www.tn.gov/collegepays/apply',source_url:'https://www.tn.gov/collegepays'}} />)
  expect(screen.queryByRole('link',{name:/Open application/i})).toBeNull()
  expect(screen.getByRole('link',{name:/Open source page/i}).getAttribute('href')).toBe('https://www.tn.gov/collegepays')
})
it('a legitimate selected library application stays directly actionable', () => {
  render(<FundingLibraryDetail open item={{id:'lib',title:'Community grant',
    apply_url:'https://www.tn.gov/collegepays/apply',application_url:'https://alpha.grantable.co/login'}} />)
  expect(screen.getByRole('link',{name:/Open application/i}).getAttribute('href')).toBe('https://www.tn.gov/collegepays/apply')
})
