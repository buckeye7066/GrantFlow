// @vitest-environment jsdom
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import NextStepHero from './NextStepHero.jsx'
import { pickNextSource } from '@/lib/nextSource'

const grants = [
  { id: 'g1', title: 'Emergency Rental Assistance', funder: 'United Ministries', status: 'saved' },
  { id: 'g2', title: 'Legit Hardship Grants', funder: 'City of Houston', status: 'saved' },
]

const renderHero = (props) => render(<MemoryRouter><NextStepHero {...props} /></MemoryRouter>)

describe('NextStepHero', () => {
  it('names the first funding source and links straight to it', () => {
    renderHero({ grants, today: 'Monday, Sep 7' })
    expect(screen.getByText('Your next step')).toBeTruthy()
    expect(screen.getByText('Emergency Rental Assistance')).toBeTruthy()
    expect(screen.getByText('United Ministries')).toBeTruthy()
    const start = screen.getByRole('link', { name: /Review this funding source/ })
    expect(start.getAttribute('href')).toContain('grant_id=g1')
    expect(screen.getByRole('link', { name: /See all 2 sources/ })).toBeTruthy()
  })

  it('offers one primary action and never a logout or a duplicate Anya button', () => {
    renderHero({ grants })
    expect(screen.queryByText(/Logout/)).toBeNull()
    expect(screen.queryByText(/Ask Anya/)).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('offers discovery without requiring an AI conversation when nothing is ready yet', () => {
    renderHero({ grants: [] })
    expect(screen.getByText(/Search for funding using your saved profile/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Discover grants matched to your profile/ })).toBeTruthy()
  })

  it('pickNextSource skips rows without an id', () => {
    expect(pickNextSource([{ title: 'no id' }, grants[1]])).toEqual(grants[1])
    expect(pickNextSource(null)).toBeNull()
  })
})
