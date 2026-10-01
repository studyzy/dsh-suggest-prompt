/**
 * The host-only `suggestPromptTranscript` fold.
 *
 * `dsh >= 0.2.0` prohibits new synchronous reads of Session event history, so
 * the plugin maintains the transcript it feeds the auxiliary call as projection
 * state built from newly committed events. These tests pin the properties that
 * make that substitution safe:
 *
 * - the fold is a pure transition that returns the SAME reference for events it
 *   does not retain (the projection drive's `Object.is` gate depends on it);
 * - only genuine user input and assistant text are retained (harness-injected
 *   context is dropped, exactly as the previous log scan dropped it);
 * - the retained window is bounded, so a long session does not accumulate.
 */
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyTranscriptProjection, EMPTY_TRANSCRIPT_STATE, TRANSCRIPT_RETAINED_TURNS } from '../src/transcript.ts'
import { buildTranscript } from '../src/generate.ts'

/** Fold one session's committed events into the transcript state. */
function fold(session: Session) {
  return session.snapshotEvents().reduce(applyTranscriptProjection, EMPTY_TRANSCRIPT_STATE)
}

/** Append one completed turn carrying a real user prompt and an assistant answer. */
function appendTurn(session: Session, turn: number, user: string, assistant: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: user }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: assistant }],
      source: { provider: 'main', model: 'main-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('applyTranscriptProjection', () => {
  it('returns the same reference for an event it does not retain', () => {
    const session = Session.create(SessionId('unretained'))
    session.append('turn/start', { turn: 1 })
    const state = fold(session)
    // A request/header carries no transcript text; the drive's Object.is gate
    // relies on the fold returning the very same reference.
    const event = {
      type: 'request/header',
      seq: 9,
      data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' },
    } as unknown as SessionEvent
    expect(applyTranscriptProjection(state, event)).toBe(state)
  })

  it('records the newest completed turn and its start boundary', () => {
    const session = Session.create(SessionId('boundaries'))
    appendTurn(session, 1, '第一问', '第一答')
    appendTurn(session, 2, '第二问', '第二答')
    const state = fold(session)
    expect(state.lastCompletedTurn).toBe(2)
    expect(state.turnStarts.map(entry => entry.turn)).toEqual([1, 2])
  })

  it('drops turn-start rows older than the retained window', () => {
    const session = Session.create(SessionId('trim-starts'))
    for (let turn = 1; turn <= TRANSCRIPT_RETAINED_TURNS + 3; turn++) {
      session.append('turn/start', { turn })
    }
    const state = fold(session)
    expect(state.turnStarts.length).toBeLessThanOrEqual(TRANSCRIPT_RETAINED_TURNS + 1)
    // The newest boundary always survives the trim.
    expect(state.turnStarts[state.turnStarts.length - 1]?.turn).toBe(TRANSCRIPT_RETAINED_TURNS + 3)
  })

  it('bounds retained entries as turns age out', () => {
    const session = Session.create(SessionId('bounded'))
    for (let turn = 1; turn <= TRANSCRIPT_RETAINED_TURNS + 4; turn++) {
      appendTurn(session, turn, `问题${turn}`, `回答${turn}`)
    }
    const state = fold(session)
    // Two entries per turn, never more than the retained window's worth.
    expect(state.entries.length).toBeLessThanOrEqual(TRANSCRIPT_RETAINED_TURNS * 2)
    // The newest turn is always retained.
    expect(state.entries.some(entry => entry.text === `回答${TRANSCRIPT_RETAINED_TURNS + 4}`)).toBe(true)
  })

  it('excludes harness-injected user context from the retained entries', () => {
    const session = Session.create(SessionId('injected'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `<system-reminder>${'x'.repeat(5000)}</system-reminder>` }],
      source: { kind: 'agent-instructions', form: 'instructions', baseline: true },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Runtime snapshot …' }],
      source: { kind: 'suggest-prompt', plugin: 'test-fixture', form: 'transcript' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '真正的问题' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const state = fold(session)
    expect(state.entries.map(entry => entry.text)).toEqual(['真正的问题'])
  })

  it('redacts secrets at fold time, so retained state never holds them', () => {
    const session = Session.create(SessionId('redacted'))
    appendTurn(session, 1, 'key is sk-abcdefghijklmnopqrstuvwxyz012345', 'noted')
    const state = fold(session)
    const retained = state.entries.map(entry => entry.text).join('\n')
    expect(retained).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
    // `redactSecrets` substitutes its own marker; the raw secret is gone.
    expect(retained).toContain('<secret-token>')
  })

  it('tracks the suggestion cursor used to dedupe across reloads', () => {
    const session = Session.create(SessionId('cursor'))
    appendTurn(session, 1, '问', '答')
    expect(fold(session).lastSuggestedTurn).toBe(-1)
    session.append('suggest-prompt/suggested', {
      version: 1, turn: 1, baseSeq: 2, text: '建议', truncated: false, requestSeq: 1, acceptKey: 'Tab',
    })
    expect(fold(session).lastSuggestedTurn).toBe(1)
  })
})

describe('buildTranscript over fold state', () => {
  it('returns undefined before any turn completes', () => {
    const session = Session.create(SessionId('no-completed'))
    session.append('turn/start', { turn: 1 })
    expect(buildTranscript(fold(session), 1, 500)).toBeUndefined()
  })

  it('selects the completed-turn window the fold retained', () => {
    const session = Session.create(SessionId('window'))
    appendTurn(session, 1, '旧问题', '旧回答')
    appendTurn(session, 2, '新问题', '新回答')
    const transcript = buildTranscript(fold(session), 1, 500)
    expect(transcript?.pairs.map(pair => pair.text)).toEqual(['新问题', '新回答'])
  })
})