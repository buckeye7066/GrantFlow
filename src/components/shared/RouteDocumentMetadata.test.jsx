// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import RouteDocumentMetadata from './RouteDocumentMetadata.jsx'

function canonical() {
  return document.head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null
}

function meta(selector) {
  return document.head.querySelector(selector)?.getAttribute('content') ?? null
}

function Journey() {
  return (
    <>
      <RouteDocumentMetadata />
      <Routes>
        <Route path="/welcome" element={<Link to="/privacy">Privacy</Link>} />
        <Route path="/privacy" element={<Link to="/start">Start profile</Link>} />
        <Route path="/start" element={<p>Profile setup</p>} />
      </Routes>
    </>
  )
}

beforeEach(() => {
  document.head.innerHTML = '<title>Initial shell</title>'
})

describe('RouteDocumentMetadata', () => {
  it('updates canonical and social metadata during public SPA navigation', () => {
    render(
      <MemoryRouter initialEntries={['/welcome']}>
        <Journey />
      </MemoryRouter>,
    )

    expect(canonical()).toBe('https://app.axiombiolabs.org/welcome')
    expect(meta('meta[property="og:url"]')).toBe('https://app.axiombiolabs.org/welcome')

    fireEvent.click(screen.getByRole('link', { name: 'Privacy' }))

    expect(document.title).toBe('GrantFlow Privacy Policy')
    expect(canonical()).toBe('https://app.axiombiolabs.org/privacy')
    expect(meta('meta[property="og:url"]')).toBe('https://app.axiombiolabs.org/privacy')
    expect(meta('meta[name="robots"]')).toBe('index,follow,max-image-preview:large')
  })

  it('removes public canonicals and applies noindex on protected SPA navigation', () => {
    render(
      <MemoryRouter initialEntries={['/privacy']}>
        <Journey />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('link', { name: 'Start profile' }))

    expect(screen.getByText('Profile setup')).toBeTruthy()
    expect(document.title).toBe('GrantFlow | Secure Funding Workspace')
    expect(meta('meta[name="robots"]')).toBe('noindex,nofollow,noarchive')
    expect(canonical()).toBeNull()
    expect(meta('meta[property="og:url"]')).toBeNull()
  })
})

