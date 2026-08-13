import { describe, expect, it } from 'vitest'
import { redactSecrets, sanitizeSuggestion } from '../src/sanitize.ts'

describe('redactSecrets', () => {
  it('masks AWS, OpenAI, GitHub, Slack, JWT, and Stripe secret shapes', () => {
    // Secret-shaped fixtures are assembled at runtime so the source never
    // contains a literal credential pattern (GitHub secret scanning).
    const awsKey = `AKIA${'1234567890ABCDEF'}`
    const skToken = `sk-${'abcdefghijklmnopqrstuvwxyz1234567890'}`
    const ghp = `ghp_${'A'.repeat(40)}`
    const gho = `gho_${'A'.repeat(40)}`
    const xoxb = `xoxb-${'1234567890-abcdefghijkl'}`
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.')
    const stripe = `rk_live_${'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'}`
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
