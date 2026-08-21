/**
 * Accept-shortcut parsing for the ghost suggestion bridge: the host plugin
 * configures the key that adopts a displayed suggestion into the draft (for
 * example `Tab` or `Alt+Slash`), and this module turns that spec into an exact
 * KeyboardEvent matcher. Pure and side-effect free, so the browser half can
 * unit-test it directly.
 * @module @studyzy/dsh-client-ui-suggest-prompt/accept-key
 */

/** One keyboard-event predicate matching the configured accept shortcut. */
export type AcceptKeyMatcher = (event: KeyboardEvent) => boolean

/** Key tokens that map to a `KeyboardEvent.code` that is not a letter or digit. */
const KEY_CODES: Readonly<Record<string, string>> = {
  tab: 'Tab',
  enter: 'Enter',
  space: 'Space',
  ' ': 'Space',
  slash: 'Slash',
  '/': 'Slash',
  backspace: 'Backspace',
  delete: 'Delete',
  escape: 'Escape',
  esc: 'Escape',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
  period: 'Period',
  '.': 'Period',
  comma: 'Comma',
  ',': 'Comma',
  semicolon: 'Semicolon',
  ';': 'Semicolon',
  quote: 'Quote',
  "'": 'Quote',
  bracketleft: 'BracketLeft',
  '[': 'BracketLeft',
  bracketright: 'BracketRight',
  ']': 'BracketRight',
  backslash: 'Backslash',
  '\\': 'Backslash',
  minus: 'Minus',
  '-': 'Minus',
  equal: 'Equal',
  '=': 'Equal',
  backquote: 'Backquote',
  '`': 'Backquote',
}

/** One key token to a `KeyboardEvent.code`; unknown tokens map to nothing. */
function keyCode(token: string): string | undefined {
  const lower = token.toLowerCase()
  const named = KEY_CODES[lower]
  if (named !== undefined) return named
  if (/^[a-z]$/.test(lower)) return `Key${lower.toUpperCase()}`
  if (/^[0-9]$/.test(lower)) return `Digit${lower}`
  if (/^f(?:[1-9]|1[0-2])$/.test(lower)) return `F${lower.slice(1)}`
  return undefined
}

/**
 * Encode a `KeyboardEvent`'s code and modifier state as a canonical accept
 * shortcut spec such as `Tab`, `Alt+Slash`, or `Ctrl+Alt+X` — the inverse of
 * {@link parseAcceptKey}, so the emitted spec always round-trips through it.
 * @param code - the event's `code` (e.g. `KeyT`, `Slash`, `Tab`).
 * @param modifiers - the event's modifier flags.
 * @returns the canonical spec, or `undefined` when `code` names a pure modifier
 * key (an event with no main key cannot encode a shortcut).
 */
export function encodeKey(
  code: string,
  modifiers: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
): string | undefined {
  const parts: string[] = []
  if (modifiers.alt) parts.push('Alt')
  if (modifiers.ctrl) parts.push('Ctrl')
  if (modifiers.meta) parts.push('Meta')
  if (modifiers.shift) parts.push('Shift')
  // A pure modifier key carries no main key, so it cannot form a shortcut.
  if (KEY_MODIFIER_CODES.has(code)) return undefined
  const main = encodeMainKey(code)
  if (main === undefined) return undefined
  parts.push(main)
  return parts.join('+')
}

/** Codes of the pure modifier keys (no shortcut can name one as its main key). */
const KEY_MODIFIER_CODES: ReadonlySet<string> = new Set([
  'AltLeft', 'AltRight',
  'ControlLeft', 'ControlRight',
  'MetaLeft', 'MetaRight',
  'ShiftLeft', 'ShiftRight',
])

/** Map a main key `code` to its canonical accept-spec token. */
function encodeMainKey(code: string): string | undefined {
  // Inverse of keyCode: KeyX -> single letter, DigitN -> single digit.
  const keyMatch = /^Key([A-Z])$/.exec(code)
  if (keyMatch !== null) return keyMatch[1]
  const digitMatch = /^Digit([0-9])$/.exec(code)
  if (digitMatch !== null) return digitMatch[1]
  // The named codes (Tab, Slash, Enter, F5, ...) round-trip by their own name.
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code
  return code
}

/**
 * Parse a shortcut spec such as `Tab`, `Alt+Slash`, `Alt+/`, or `Ctrl+Enter`
 * into an exact event matcher. Modifiers (`alt`, `ctrl`, `meta`, `shift`, with
 * aliases `option`, `control`, `cmd`, `command`) are case-insensitive and may
 * appear in any order before the single key token.
 * @param spec - the configured shortcut.
 * @returns an exact matcher, or `undefined` when the spec cannot be parsed
 * (an unknown key token, a missing key, or more than one key token).
 */
export function parseAcceptKey(spec: string): AcceptKeyMatcher | undefined {
  // split always yields at least one element; empty specs surface as an empty part.
  const parts = spec.trim().split(/\s*\+\s*/).map(part => part.toLowerCase())
  if (parts.some(part => part === '')) return undefined
  let code: string | undefined
  let alt = false
  let ctrl = false
  let meta = false
  let shift = false
  for (const part of parts) {
    if (part === 'alt' || part === 'option') { alt = true; continue }
    if (part === 'ctrl' || part === 'control') { ctrl = true; continue }
    if (part === 'meta' || part === 'cmd' || part === 'command') { meta = true; continue }
    if (part === 'shift') { shift = true; continue }
    if (code !== undefined) return undefined
    code = keyCode(part)
    if (code === undefined) return undefined
  }
  if (code === undefined) return undefined
  return event => event.code === code
    && event.altKey === alt
    && event.ctrlKey === ctrl
    && event.metaKey === meta
    && event.shiftKey === shift
}
