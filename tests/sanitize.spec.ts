import { describe, expect, it } from 'vitest'
import { hasCJK, redactSecrets, sanitizeSuggestion, shouldFilterSuggestion } from '../src/sanitize.ts'

describe('redactSecrets', () => {
  it('masks AWS, OpenAI, GitHub, Slack, JWT, and Stripe secret shapes', () => {
    // Secret-shaped fixtures are assembled at runtime so the source never
    // contains a literal credential pattern (GitHub secret scanning). The
    // template form is deliberate: it keeps the credential shape out of the
    // source text, which is exactly why the "unnecessary template" lint does
    // not apply here.
    /* oxlint-disable no-unnecessary-template-expression */
    const awsKey = `AKIA${'1234567890ABCDEF'}`
    const skToken = `sk-${'abcdefghijklmnopqrstuvwxyz1234567890'}`
    const ghp = `ghp_${'A'.repeat(40)}`
    const gho = `gho_${'A'.repeat(40)}`
    const xoxb = `xoxb-${'1234567890-abcdefghijkl'}`
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.')
    const stripe = `rk_live_${'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'}`
    /* oxlint-enable no-unnecessary-template-expression */
    expect(redactSecrets(`aws ${awsKey} end`)).toContain('<aws-access-key-id>')
    expect(redactSecrets(skToken)).toBe('<secret-token>')
    expect(redactSecrets(ghp)).toBe('<github-token>')
    expect(redactSecrets(gho)).toBe('<github-token>')
    expect(redactSecrets(`slack ${xoxb}`)).toContain('<slack-token>')
    expect(redactSecrets(jwt)).toBe('<jwt>')
    expect(redactSecrets(`stripe ${stripe}`)).toContain('<stripe-key>')
  })

  it('keeps a JWT without the eyJ prefix unmarked', () => {
    expect(redactSecrets('plain JWT text')).toBe('plain JWT text')
  })

  it('leaves ordinary prose untouched', () => {
    expect(redactSecrets('帮我写一个登录页面的验证码校验函数')).toBe('帮我写一个登录页面的验证码校验函数')
  })
})

describe('sanitizeSuggestion', () => {
  it('strips ANSI escape sequences and surrounding quotes', () => {
    expect(sanitizeSuggestion('\x1b[31m"继续修复登录页"\x1b[0m', 100).text).toBe('继续修复登录页')
  })

  it('strips code fences and collapses newlines to one line', () => {
    expect(sanitizeSuggestion('```text\n继续\n修复\n登录页\n```', 100).text).toBe('继续 修复 登录页')
  })

  it('collapses whitespace runs', () => {
    expect(sanitizeSuggestion('  继续   修复  登录页  ', 100).text).toBe('继续 修复 登录页')
  })

  it('truncates to the visible character cap and reports it', () => {
    const result = sanitizeSuggestion('abcdefgh', 3)
    expect(result).toEqual({ text: 'abc', truncated: true })
  })

  it('reports an in-budget suggestion as untruncated', () => {
    expect(sanitizeSuggestion('abc', 3)).toEqual({ text: 'abc', truncated: false })
  })

  it('drops control characters, the chip placeholder, and lone surrogates', () => {
    expect(sanitizeSuggestion('a\u0007b\u0000c\uFFFCd', 10).text).toBe('abcd')
    const broken = 'ok\uD800text'
    expect(sanitizeSuggestion(broken, 20).text).toBe('oktext')
  })

  it('returns an empty text when the output was entirely control', () => {
    expect(sanitizeSuggestion('\u001b[31m\u001b[0m', 10)).toEqual({ text: '', truncated: false })
  })
})

describe('hasCJK', () => {
  it('detects CJK ideographs and ignores other scripts', () => {
    expect(hasCJK('继续')).toBe(true)
    expect(hasCJK('mixed 中文 text')).toBe(true)
    expect(hasCJK('plain english')).toBe(false)
    expect(hasCJK('')).toBe(false)
  })
})

describe('shouldFilterSuggestion', () => {
  it('rejects empty output', () => {
    expect(shouldFilterSuggestion('')).toBe(true)
    expect(shouldFilterSuggestion('   ')).toBe(true)
  })

  it('rejects meta-text the model spells out instead of a suggestion', () => {
    for (const meta of [
      'done',
      'nothing found',
      'nothing to suggest right now',
      'no suggestion available',
      'no follow-up needed',
      'please stay silent',
      'no more tasks',
    ]) {
      expect(shouldFilterSuggestion(meta)).toBe(true)
    }
  })

  it('rejects meta wrapped in punctuation', () => {
    expect(shouldFilterSuggestion('(please hold)')).toBe(true)
    expect(shouldFilterSuggestion('[anything]')).toBe(true)
  })

  it('rejects error echo the model might pass through', () => {
    expect(shouldFilterSuggestion('api error: timeout')).toBe(true)
    expect(shouldFilterSuggestion('error: something broke')).toBe(true)
  })

  it('rejects over-long output and stray single words, keeping known commands', () => {
    expect(shouldFilterSuggestion('one two three four five six seven eight nine ten eleven twelve thirteen')).toBe(true)
    expect(shouldFilterSuggestion('refactor')).toBe(true)
    expect(shouldFilterSuggestion('ok')).toBe(false)
    expect(shouldFilterSuggestion('/skills')).toBe(false)
  })

  it('rejects a lone unknown CJK character but keeps known CJK commands', () => {
    expect(shouldFilterSuggestion('哈')).toBe(true)
    expect(shouldFilterSuggestion('好')).toBe(false)
    expect(shouldFilterSuggestion('继续')).toBe(false)
  })

  it('rejects long CJK suggestions by byte length', () => {
    expect(shouldFilterSuggestion('长'.repeat(40))).toBe(true)
    expect(shouldFilterSuggestion('继续修复登录页')).toBe(false)
  })

  it('rejects multi-sentence, formatted, evaluative, and assistant-voice output', () => {
    expect(shouldFilterSuggestion('Run the tests. Then commit')).toBe(true)
    expect(shouldFilterSuggestion('run *all* the tests')).toBe(true)
    expect(shouldFilterSuggestion('thanks for the help')).toBe(true)
    expect(shouldFilterSuggestion('不错，继续')).toBe(true)
    expect(shouldFilterSuggestion('grateful for your help')).toBe(false)
    expect(shouldFilterSuggestion("I'll take a look at it")).toBe(true)
    expect(shouldFilterSuggestion('我来检查一下')).toBe(true)
  })

  it('keeps a plausible single-sentence next prompt', () => {
    expect(shouldFilterSuggestion('run the tests')).toBe(false)
    expect(shouldFilterSuggestion('继续修复那个 bug 并补充单元测试')).toBe(false)
  })
})
