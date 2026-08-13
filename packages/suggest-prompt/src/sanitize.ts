/**
 * Transcript redaction and suggestion sanitization for the suggest-prompt
 * auxiliary call: nothing that reaches the model carries secret-shaped text,
 * and nothing the model returns can inject terminal control into the web
 * composer. Pure functions, exported for direct unit coverage.
 * @module @deepseek-ai/dsh-suggest-prompt/sanitize
 */

/** One secret-shaped pattern and its replacement label. */
interface SecretPattern {
  readonly pattern: RegExp
  readonly label: string
}

/** Common credential shapes masked before the transcript reaches the model. */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // AWS access key ids.
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: '<aws-access-key-id>' },
  // OpenAI-style sk- tokens.
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, label: '<secret-token>' },
  // GitHub fine-grained and classic tokens.
  { pattern: /\bgh[opsu]_[A-Za-z0-9]{36,}\b/g, label: '<github-token>' },
  // Slack xox- tokens.
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: '<slack-token>' },
  // Compact JWTs (three dot-separated base64url segments).
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: '<jwt>' },
  // Stripe restricted keys.
  { pattern: /\brk_(live|test)_[A-Za-z0-9]{16,}\b/g, label: '<stripe-key>' },
]

/**
 * Mask secret-shaped substrings so the auxiliary model never receives them.
 * @param text - transcript text.
 * @returns the same text with every matched secret replaced by a label.
 */
export function redactSecrets(text: string): string {
  let out = text
  for (const { pattern, label } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, label)
  }
  return out
}

/**
 * ANSI/OSC/CSI/DCS escape sequences: CSI `ESC[ ...`, OSC `ESC] ... (BEL|ESC\)`,
 * and the two-byte `ESC ( X` / `ESC # X` families.
 */
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-9;:]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[()][0-9A-Za-z]|#[0-9A-Za-z])/g

/** C0 controls (except tab/newline/CR), C1 controls, bidi overrides, and the chip placeholder. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFFFC]/g

/** Fence delimiters the model may wrap the suggestion in. */
const FENCE_DELIMITER = /^(?:`{3,}|~{3,})[^\n]*\n?|\n?(?:`{3,}|~{3,})$/g

/** One matched pair of surrounding quotes (optionally after a colon/label), stripped by replace. */
const QUOTED_OUTER = /^(?:.*?:\s*)?(["'“”‘’])([\s\S]*?)\1$/u

/** Strip unpaired surrogate code units (an emoji's broken half cannot render). */
function stripLoneSurrogates(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code >= 0xd800 && code <= 0xdfff) continue
    out += char
  }
  return out
}

/**
 * Sanitize one raw suggestion into composer-safe single-line text.
 * @param text - raw model output.
 * @param maxChars - hard visible-character cap (code points).
 * @returns the sanitized text and whether it was truncated.
 */
export function sanitizeSuggestion(text: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  let value = stripLoneSurrogates(text
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CONTROL_CHARS, ''))
  value = value.trim()
  value = value.replace(FENCE_DELIMITER, '').trim()
  value = value.replace(QUOTED_OUTER, '$2').trim()
  // Collapse every whitespace run — including newlines — to one space.
  value = value.replace(/\s+/g, ' ').trim()
  const truncated = Array.from(value).length > maxChars
  if (truncated) value = Array.from(value).slice(0, maxChars).join('')
  return { text: value, truncated }
}
