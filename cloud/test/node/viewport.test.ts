import { describe, expect, it } from 'vitest'
import { appHeight, isTyping } from '../../web/viewport'

// 2026-11-09: chek ulashish oynasidan keyin Telegram `viewportStableHeight` ~60px da qotib qoldi →
// ilova sarlavha balandligida kesildi (Sotuvlar qora). Haqiqiy WebView balandligi ustun.
describe('app height', () => {
  it('uses the real WebView height when nothing is focused, even if Telegram reports a stuck tiny height', () => {
    expect(appHeight(812, 62, false)).toBe(812)
    expect(appHeight(812, 812, false)).toBe(812)
    expect(appHeight(812, undefined, false)).toBe(812)
  })

  it('follows the keyboard: Telegram height while typing when the WebView itself does not shrink (iOS)', () => {
    expect(appHeight(812, 470, true)).toBe(470)
  })

  it('keeps the shrunk WebView height on Android (both agree) and never grows past it', () => {
    expect(appHeight(470, 470, true)).toBe(470)
    expect(appHeight(470, 812, true)).toBe(470)
  })

  it('rejects a stuck tiny Telegram height even while typing', () => {
    expect(appHeight(812, 62, true)).toBe(812)
  })

  it('falls back to Telegram height only when the WebView reports none', () => {
    expect(appHeight(0, 700, false)).toBe(700)
    expect(appHeight(0, undefined, false)).toBe(0)
  })
})

describe('typing detection', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra })
  it('treats text inputs, textareas and contenteditable as typing', () => {
    expect(isTyping(el('INPUT', { type: 'text' }))).toBe(true)
    expect(isTyping(el('INPUT', { type: 'search' }))).toBe(true)
    expect(isTyping(el('INPUT', { type: 'number' }))).toBe(true)
    expect(isTyping(el('TEXTAREA'))).toBe(true)
    expect(isTyping(el('DIV', { isContentEditable: true }))).toBe(true)
  })
  it('ignores buttons, checkboxes and nothing focused', () => {
    expect(isTyping(el('BUTTON'))).toBe(false)
    expect(isTyping(el('INPUT', { type: 'checkbox' }))).toBe(false)
    expect(isTyping(el('BODY'))).toBe(false)
    expect(isTyping(null)).toBe(false)
  })
})
