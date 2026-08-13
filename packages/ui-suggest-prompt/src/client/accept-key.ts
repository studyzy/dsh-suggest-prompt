/**
 * Accept-shortcut parsing for the ghost suggestion bridge: the host plugin
 * configures the key that adopts a displayed suggestion into the draft (for
 * example `Tab` or `Alt+Slash`), and this module turns that spec into an exact
 * KeyboardEvent matcher. Pure and side-effect free, so the browser half can
 * unit-test it directly.
 * @module @deepseek-ai/dsh-client-ui-suggest-prompt/accept-key
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

/** Map one key token to its `KeyboardEvent.code`; unknown tokens map to nothing. */
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
