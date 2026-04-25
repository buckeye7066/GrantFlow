/**
 * Regression tests for backend/services/anyaButtonScanner.js.
 *
 * These guard the real admin.anya.testButtons implementation so it does
 * not silently regress back to the "recommendations" stub. The scanner is
 * regex-based — these tests pin the minimum behavior we rely on.
 */

import { describe, it, expect } from 'vitest'
import {
  extractButtons,
  extractEndpoints,
  resolveHandlerBody,
} from '../services/anyaButtonScanner.js'

describe('anyaButtonScanner — extractButtons', () => {
  it('finds <button> elements with onClick handlers', () => {
    const src = `
      function Foo() {
        return <button onClick={handleSave}>Save</button>
      }
    `
    const buttons = extractButtons(src)
    expect(buttons).toHaveLength(1)
    expect(buttons[0].tag).toBe('button')
    expect(buttons[0].handlerRef.attr).toBe('onClick')
    expect(buttons[0].handlerRef.expr).toBe('handleSave')
    expect(buttons[0].label).toBe('Save')
  })

  it('finds <Button> wrapper components with inline arrow handlers', () => {
    const src = `
      <Button onClick={() => onSubmit(formData)}>Submit</Button>
    `
    const buttons = extractButtons(src)
    expect(buttons).toHaveLength(1)
    expect(buttons[0].tag).toBe('Button')
    expect(buttons[0].handlerRef.expr).toContain('onSubmit(formData)')
  })

  it('finds non-button elements with click handlers', () => {
    const src = `
      <div onClick={handleClick}>not a button</div>
      <span>plain text</span>
    `
    const buttons = extractButtons(src)
    expect(buttons).toHaveLength(1)
    expect(buttons[0].tag).toBe('div')
    expect(buttons[0].handlerRef.expr).toBe('handleClick')
  })
})

describe('anyaButtonScanner — resolveHandlerBody', () => {
  it('returns inline bodies as-is', () => {
    const res = resolveHandlerBody('() => fetch("/api/foo")', 'unused')
    expect(res.kind).toBe('inline')
    expect(res.body).toContain('/api/foo')
  })

  it('resolves named handler declared as const arrow function', () => {
    const src = `
      const saveProfile = async () => {
        await fetch('/api/profiles/save', { method: 'POST' })
      }
      <Button onClick={saveProfile}>Save</Button>
    `
    const res = resolveHandlerBody('saveProfile', src)
    expect(res.kind).toBe('identifier')
    expect(res.name).toBe('saveProfile')
    expect(res.body).toContain('/api/profiles/save')
  })
})

describe('anyaButtonScanner — extractEndpoints', () => {
  it('pulls fetch calls including method option', () => {
    const body = `
      await fetch('/api/profiles/save', { method: 'POST', body: JSON.stringify(data) })
      await fetch("/api/profiles/list")
    `
    const eps = extractEndpoints(body)
    expect(eps).toEqual(
      expect.arrayContaining([
        { method: 'POST', url: '/api/profiles/save' },
        { method: 'GET', url: '/api/profiles/list' },
      ]),
    )
  })

  it('pulls axios/api/apiClient dotted calls', () => {
    const body = `
      await api.post('/api/grants', payload)
      await axios.get('/api/opportunities')
      await apiClient.delete('/api/profiles/42')
    `
    const eps = extractEndpoints(body)
    const urls = eps.map((e) => `${e.method} ${e.url}`)
    expect(urls).toContain('POST /api/grants')
    expect(urls).toContain('GET /api/opportunities')
    expect(urls).toContain('DELETE /api/profiles/42')
  })

  it('returns empty array for local-only handlers', () => {
    const body = `
      setOpen(false)
      console.log('click')
    `
    expect(extractEndpoints(body)).toEqual([])
  })

  it('deduplicates repeated endpoints', () => {
    const body = `
      fetch('/api/foo'); fetch('/api/foo');
    `
    expect(extractEndpoints(body)).toHaveLength(1)
  })
})
