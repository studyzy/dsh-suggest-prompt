// @vitest-environment jsdom
/**
 * Accept-shortcut parser: turns a configured spec (`Tab`, `Alt+Slash`,
 * `Ctrl+Enter`, ...) into an exact KeyboardEvent matcher. Covers key names,
 * modifiers, aliases, single letters/digits, and malformed specs.
 */
import { describe, expect, it } from 'vitest'
import { parseAcceptKey, encodeKey } from '../src/browser/accept-key.ts'

function press(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
}

describe('parseAcceptKey', () => {
  it('matches the default Tab with no modifiers', () => {
    const matcher = parseAcceptKey('Tab')
    expect(matcher).toBeDefined()
    expect(matcher?.(press({ code: 'Tab' }))).toBe(true)
    expect(matcher?.(press({ code: 'Tab', shiftKey: true }))).toBe(false)
    expect(matcher?.(press({ code: 'Tab', altKey: true }))).toBe(false)
    expect(matcher?.(press({ code: 'Tab', ctrlKey: true }))).toBe(false)
    expect(matcher?.(press({ code: 'Tab', metaKey: true }))).toBe(false)
    expect(matcher?.(press({ code: 'Enter' }))).toBe(false)
  })

  it('requires every configured modifier and no others', () => {
    const matcher = parseAcceptKey('Alt+Slash')
    expect(matcher?.(press({ code: 'Slash', altKey: true }))).toBe(true)
    expect(matcher?.(press({ code: 'Slash' }))).toBe(false)
    expect(matcher?.(press({ code: 'Slash', altKey: true, ctrlKey: true }))).toBe(false)
    expect(matcher?.(press({ code: 'Enter', altKey: true }))).toBe(false)
  })

  it('accepts the slash symbol token and modifier aliases', () => {
    expect(parseAcceptKey('Alt+/')?.(press({ code: 'Slash', altKey: true }))).toBe(true)
    expect(parseAcceptKey('option+slash')?.(press({ code: 'Slash', altKey: true }))).toBe(true)
    expect(parseAcceptKey('Ctrl+Enter')?.(press({ code: 'Enter', ctrlKey: true }))).toBe(true)
    expect(parseAcceptKey('Meta+T')?.(press({ code: 'KeyT', metaKey: true }))).toBe(true)
    expect(parseAcceptKey('Shift+F5')?.(press({ code: 'F5', shiftKey: true }))).toBe(true)
  })

  it('maps single letters, digits, and space to their codes', () => {
    expect(parseAcceptKey('t')?.(press({ code: 'KeyT' }))).toBe(true)
    expect(parseAcceptKey('5')?.(press({ code: 'Digit5' }))).toBe(true)
    expect(parseAcceptKey('Space')?.(press({ code: 'Space' }))).toBe(true)
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseAcceptKey(' Alt + Slash ')?.(press({ code: 'Slash', altKey: true }))).toBe(true)
  })

  it('rejects specs without a key, with two keys, or with unknown tokens', () => {
    expect(parseAcceptKey('')).toBeUndefined()
    expect(parseAcceptKey('   ')).toBeUndefined()
    expect(parseAcceptKey('Alt+')).toBeUndefined()
    expect(parseAcceptKey('Alt')).toBeUndefined()
    expect(parseAcceptKey('Tab+Enter')).toBeUndefined()
    expect(parseAcceptKey('Bogus')).toBeUndefined()
    expect(parseAcceptKey('Alt+Bogus')).toBeUndefined()
  })
})

describe('encodeKey', () => {
  it('encodes a bare key with no modifiers', () => {
    expect(encodeKey('Tab')).toBe('Tab')
    expect(encodeKey('Enter')).toBe('Enter')
    expect(encodeKey('Slash')).toBe('Slash')
  })

  it('encodes a single letter, digit, or function key', () => {
    expect(encodeKey('KeyT')).toBe('T')
    expect(encodeKey('Digit5')).toBe('5')
    expect(encodeKey('F5')).toBe('F5')
  })

  it('encodes modifier combos of two and three keys', () => {
    expect(encodeKey('Slash', { alt: true })).toBe('Alt+Slash')
    expect(encodeKey('Enter', { ctrl: true })).toBe('Ctrl+Enter')
    expect(encodeKey('KeyX', { ctrl: true, alt: true })).toBe('Alt+Ctrl+X')
  })

  it('returns undefined for a pure modifier key', () => {
    expect(encodeKey('AltLeft')).toBeUndefined()
    expect(encodeKey('ControlLeft')).toBeUndefined()
    expect(encodeKey('ShiftLeft')).toBeUndefined()
    expect(encodeKey('MetaRight')).toBeUndefined()
  })

  it('round-trips through parseAcceptKey', () => {
    const specs = ['Tab', 'Alt+Slash', 'Ctrl+Enter', 'Ctrl+Alt+X', 'Shift+F5', 'Meta+T', '5', 'Space']
    for (const spec of specs) {
      expect(parseAcceptKey(spec)).toBeDefined()
    }
    expect(parseAcceptKey(encodeKey('KeyT', { meta: true }))).toBeDefined()
  })
})
