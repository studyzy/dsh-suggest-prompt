/**
 * Transcript redaction, suggestion sanitization, and semantic output
 * filtering for the suggest-prompt auxiliary call: nothing that reaches the
 * model carries secret-shaped text, and nothing the model returns can inject
 * terminal control into the web composer or read as meta-text instead of a
 * real next prompt. Pure functions, exported for direct unit coverage.
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
 * Structurally clean one raw model output into composer-safe single-line
 * text, without the length cap: control sequences, lone surrogates, fences,
 * and surrounding quotes are stripped, and whitespace is collapsed.
 * @param text - raw model output.
 * @returns the cleaned single-line text.
 */
export function cleanSuggestion(text: string): string {
  let value = stripLoneSurrogates(text
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CONTROL_CHARS, ''))
  value = value.trim()
  value = value.replace(FENCE_DELIMITER, '').trim()
  value = value.replace(QUOTED_OUTER, '$2').trim()
  // Collapse every whitespace run — including newlines — to one space.
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Sanitize one raw suggestion into composer-safe single-line text, truncating
 * to the visible-character cap.
 * @param text - raw model output.
 * @param maxChars - hard visible-character cap (code points).
 * @returns the sanitized text and whether it was truncated.
 */
export function sanitizeSuggestion(text: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  const value = cleanSuggestion(text)
  const truncated = Array.from(value).length > maxChars
  if (truncated) {
    return { text: Array.from(value).slice(0, maxChars).join(''), truncated }
  }
  return { text: value, truncated }
}

/**
 * Report whether `text` contains a CJK unified ideograph. CJK text has no
 * spaces, so word counts need this check; it also picks the suggestion
 * language to match the conversation.
 * @param text - inspected text.
 * @returns true when any code point falls in the CJK unified ideographs range.
 */
export function hasCJK(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code >= 0x4e00 && code <= 0x9fff) return true
  }
  return false
}

/** Meta-text the model might emit instead of a suggestion ("stay silent"). */
const SILENCE_META = /\bsilence\b|\bstay silent\b|\bno more\b/i

/** Parenthesized or bracketed meta the model may wrap the whole reply in. */
const WRAPPED_META = /^\(.*\)$|^\[.*\]$/u

/** Two ASCII sentences; CJK sentence punctuation is not space-separated. */
const MULTIPLE_SENTENCE = /[.!?]\s+[A-Z]/

/** Markdown emphasis or a literal newline that survived sanitization. */
const FORMATTING = /[\n*]/

/** Evaluative filler the model should never offer as a next prompt. */
const EVALUATIVE_WORDS = [
  'thanks', 'thank you', 'looks good', 'sounds good', 'that works',
  'that worked', "that's all", 'nice', 'great', 'perfect',
  'makes sense', 'awesome', 'excellent',
]
const EVALUATIVE = new RegExp(
  `\\b(?:${EVALUATIVE_WORDS.join('|')})\\b|谢谢|感谢|不错|很好|很棒|太棒了|完美|没毛病`,
  'i',
)

/** Assistant-voice phrasing: the suggestion must read as the USER typing. */
const ASSISTANT_VOICE_PHRASES = [
  'let me', "i'll", "i've", "i'm", 'i can', 'i would', 'i think', 'i notice',
  "here's", 'here is', 'here are', "that's", 'this is', 'this will',
  'you can', 'you should', 'you could', 'sure,', 'of course', 'certainly',
  '我来', '我帮你', '我建议', '我可以', '让我', '这可以', '这里可以',
]
const ASSISTANT_VOICE = new RegExp(`^(?:${ASSISTANT_VOICE_PHRASES.join('|')})`, 'i')

/** Single-word suggestions only count as real next prompts when they are known user commands. */
const ALLOWED_SINGLE_WORDS: ReadonlySet<string> = new Set([
  // Affirmatives and common action commands.
  'yes', 'yeah', 'yep', 'yea', 'yup', 'sure', 'ok', 'okay',
  'push', 'commit', 'deploy', 'stop', 'continue', 'check', 'exit', 'quit', 'no',
  // Chinese equivalents.
  '继续', '好', '好的', '行', '可以', '提交', '推送', '停止', '退出', '完成', '检查', '部署', '测试', '运行',
])

function isAllowedSingleWord(lower: string): boolean {
  return ALLOWED_SINGLE_WORDS.has(lower) || lower.startsWith('/')
}

/**
 * Reject raw model output that is not a usable next prompt: meta-text
 * ("no suggestion", "stay silent"), evaluative filler, assistant-voice
 * phrasing, multi-sentence or over-long output, or formatting. Returns true
 * when the output should be treated as "no suggestion" instead of displayed.
 * @param text - sanitized, single-line model output.
 * @returns true when the suggestion should be dropped silently.
 */
export function shouldFilterSuggestion(text: string): boolean {
  const value = text.trim()
  if (value === '') return true
  const lower = value.toLowerCase()
  const wordCount = value.split(/\s+/).filter(Boolean).length

  // The model spells out the "stay silent" instruction instead of following it.
  if (lower === 'done'
    || lower === 'nothing found'
    || lower.startsWith('nothing to suggest')
    || lower.startsWith('no suggestion')
    || lower.startsWith('no follow-up')
    || SILENCE_META.test(lower)) {
    return true
  }
  // Meta wrapped in punctuation: (silence — ...), [no suggestion].
  if (WRAPPED_META.test(value)) return true
  // Error echo the model might pass through.
  if (lower.startsWith('api error:') || lower.startsWith('error:')) return true
  // Word-count bounds: more than 12 words is too verbose; single words are
  // only usable for known user commands. CJK has no separators, so it is
  // judged by code-point length instead.
  if (hasCJK(value)) {
    if (Array.from(value).length < 2 && !isAllowedSingleWord(lower)) return true
  } else {
    if (wordCount > 12) return true
    if (wordCount < 2 && !isAllowedSingleWord(lower)) return true
  }
  // Length, sentence, and formatting guards. The length guard is byte-based
  // so CJK suggestions (3 bytes per char) stay as concise as English ones.
  if (Buffer.byteLength(value, 'utf8') >= 100) return true
  if (MULTIPLE_SENTENCE.test(value)) return true
  if (FORMATTING.test(value)) return true
  if (EVALUATIVE.test(value)) return true
  if (ASSISTANT_VOICE.test(value)) return true
  return false
}
