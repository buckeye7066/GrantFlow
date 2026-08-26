import { describe, expect, it, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard'

function fallbackDocument({ copied = true } = {}) {
  const textarea = {
    style: {},
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
    value: '',
  }
  const activeElement = { focus: vi.fn() }
  return {
    activeElement,
    body: { appendChild: vi.fn() },
    createElement: vi.fn(() => textarea),
    execCommand: vi.fn(() => copied),
    textarea,
  }
}

describe('copyTextToClipboard', () => {
  it('uses the async Clipboard API when the browser allows it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const documentRef = fallbackDocument()

    await expect(copyTextToClipboard('GrantFlow', {
      navigatorRef: { clipboard: { writeText } },
      documentRef,
    })).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledWith('GrantFlow')
    expect(documentRef.createElement).not.toHaveBeenCalled()
  })

  it('falls back to a temporary selection when Safari rejects writeText', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    const documentRef = fallbackDocument()

    await expect(copyTextToClipboard('portable copy', {
      navigatorRef: { clipboard: { writeText } },
      documentRef,
    })).resolves.toBe(true)

    expect(documentRef.textarea.value).toBe('portable copy')
    expect(documentRef.textarea.select).toHaveBeenCalledOnce()
    expect(documentRef.execCommand).toHaveBeenCalledWith('copy')
    expect(documentRef.textarea.remove).toHaveBeenCalledOnce()
    expect(documentRef.activeElement.focus).toHaveBeenCalledOnce()
  })

  it('returns false when neither browser copy mechanism exists', async () => {
    await expect(copyTextToClipboard('no copy', {
      navigatorRef: {},
      documentRef: { body: {}, createElement: () => ({}) },
    })).resolves.toBe(false)
  })
})
