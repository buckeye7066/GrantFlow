// @vitest-environment jsdom
import React from 'react'
import { expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getGeoSummary, getGeoScored } from '@/api/opportunities'
import GeoFundingView from './GeoFundingView.jsx'
vi.mock('@/api/opportunities',()=>({getGeoSummary:vi.fn(),getGeoScored:vi.fn()}))

it.each([false,true])('geographic result links use the selected target and refuse software logins (refused=%s)',async refused=>{
  const good='https://www.tn.gov/collegepays/apply', bad='https://alpha.grantable.co/login', source='https://www.tn.gov/collegepays'
  vi.mocked(getGeoSummary).mockResolvedValue({states:[{state:'TN',opportunity_count:1,zips:[{zip:'37312',county:'Bradley',opportunity_count:1}]}],total_states:1,total_zips:1,total_opportunities:1})
  vi.mocked(getGeoScored).mockResolvedValue({data:[{id:'geo',title:'Student assistance',apply_url:refused?bad:good,application_url:refused?good:bad,source_url:source}]})
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  try{
    render(<QueryClientProvider client={client}><GeoFundingView /></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button',{name:/Tennessee/}))
    const link=await screen.findByRole('link')
    expect(link.getAttribute('href')).toBe(refused?source:good)
    expect(link.getAttribute('title')).toBe(refused?'View source (application link unavailable)':'Open application')
  }finally{client.clear()}
})
