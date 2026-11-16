// @vitest-environment jsdom
/**
 * Ghost alignment geometry.
 *
 * The ghost is rendered into the composer's overlay slot, whose containing block
 * is the composer card's padding box. The editor is NOT at that box's top edge:
 * the card stacks an accessory slot and the attachments row (pasted image chips)
 * above it. These tests pin the measurement that walks from the card to the
 * editor's first glyph, and the fallback that keeps the stylesheet defaults when
 * there is no layout to copy (jsdom, a detached tree).
 *
 * jsdom implements no layout, so each element's rect is stubbed; computed styles
 * come from inline `style` declarations, which jsdom does resolve.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  findComposerCard, measureGhostBox, sameGhostBox, type GhostBox,
} from '../src/browser/ghost-geometry.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

/** A rect literal with only the fields the measurement reads. */
function rect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top, left, width, height, x: left, y: top, right: left + width, bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

/** Stub `getBoundingClientRect` on one element. */
function place(element: HTMLElement, box: DOMRect): void {
  element.getBoundingClientRect = () => box
}

/**
 * Build the composer shape the fixture cares about:
 * card (0,0,600x120) → overlay anchor (absolute, height 0) → accessory →
 * attachments row (48px) → scroll layer → contenteditable.
 */
interface Fixture {
  readonly card: HTMLDivElement
  readonly overlay: HTMLDivElement
  readonly attachments: HTMLDivElement
  readonly scroll: HTMLDivElement
  readonly editable: HTMLDivElement
}

/**
 * Mount the fixture.
 * @param options - `editorTop`/`editorLeft` position the scroll layer inside the
 * card, `padding` is applied to the editable host.
 */
function mountFixture(options: {
  editorTop: number
  editorLeft: number
  width?: number
  padding?: string
  withEditable?: boolean
}): Fixture {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  place(card, rect(0, 0, 600, 200))

  const overlay = document.createElement('div')
  overlay.setAttribute('data-composer-overlay', '')
  place(overlay, rect(0, 0, 600, 0))

  const attachments = document.createElement('div')
  place(attachments, rect(8, 16, 568, 48))

  const scroll = document.createElement('div')
  scroll.setAttribute('data-input-scroll', '')
  const width = options.width ?? 600
  place(scroll, rect(options.editorTop, options.editorLeft, width, 36))

  const editable = document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  editable.style.padding = options.padding ?? '4px 8px 0 14px'
  place(editable, rect(options.editorTop, options.editorLeft, width, 36))
  if (options.withEditable !== false) scroll.append(editable)

  card.append(overlay, attachments, scroll)
  document.body.append(card)
  return { card, overlay, attachments, scroll, editable }
}

describe('measureGhostBox', () => {
  it('anchors the ghost on the editor text origin, below an attachments row', () => {
    // Attachments push the editor 68px down and 16px right; the editor adds
    // 4px/14px of its own padding. A stylesheet `top` would have painted the
    // ghost over the image chips at y=12.
    const fixture = mountFixture({ editorTop: 68, editorLeft: 16 })
    const box = measureGhostBox(fixture.card)
    expect(box).toEqual({ top: 72, left: 30, width: 600 - 14 - 8 })
  })

  it('tracks a composer with no attachments (editor at the card top edge)', () => {
    const fixture = mountFixture({ editorTop: 8, editorLeft: 0, width: 400 })
    expect(measureGhostBox(fixture.card)).toEqual({ top: 12, left: 14, width: 400 - 14 - 8 })
  })

  it('follows the editor when the padding moves off the editable host', () => {
    // dsh may keep the padding on .input while the contenteditable stays flush;
    // the measurement must not add padding twice.
    const fixture = mountFixture({ editorTop: 80, editorLeft: 6, padding: '0px' })
    expect(measureGhostBox(fixture.card)).toEqual({ top: 80, left: 6, width: 600 })
  })

  it('reads a legacy textarea composer', () => {
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    place(card, rect(0, 0, 500, 100))
    const scroll = document.createElement('div')
    scroll.setAttribute('data-input-scroll', '')
    place(scroll, rect(20, 10, 480, 40))
    const textarea = document.createElement('textarea')
    textarea.style.padding = '6px 10px'
    place(textarea, rect(20, 10, 480, 40))
    scroll.append(textarea)
    card.append(scroll)
    document.body.append(card)
    expect(measureGhostBox(card)).toEqual({ top: 26, left: 20, width: 460 })
  })

  it('returns undefined when there is no layout to copy', () => {
    // jsdom reports zero-sized rects: the ghost must keep the CSS fallback
    // instead of being pinned to the card's corner.
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const scroll = document.createElement('div')
    scroll.setAttribute('data-input-scroll', '')
    card.append(scroll)
    document.body.append(card)
    expect(measureGhostBox(card)).toBeUndefined()
  })

  it('returns undefined without a card or without a scroll layer', () => {
    expect(measureGhostBox(null)).toBeUndefined()
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    place(card, rect(0, 0, 600, 100))
    document.body.append(card)
    expect(measureGhostBox(card)).toBeUndefined()
  })
})

describe('findComposerCard', () => {
  it('resolves the card from a node rendered into the overlay slot', () => {
    const fixture = mountFixture({ editorTop: 68, editorLeft: 16 })
    const ghost = document.createElement('div')
    fixture.overlay.append(ghost)
    expect(findComposerCard(ghost)).toBe(fixture.card)
  })

  it('returns null for a detached node', () => {
    expect(findComposerCard(document.createElement('div'))).toBeNull()
    expect(findComposerCard(null)).toBeNull()
  })

  it('falls back to the nearest ancestor that holds the editor', () => {
    // A composer without the [data-composer-card] marker must not silently drop
    // back to the stylesheet offset: the structural parent is the same element.
    const card = document.createElement('div')
    const overlay = document.createElement('div')
    const scroll = document.createElement('div')
    scroll.setAttribute('data-input-scroll', '')
    const ghost = document.createElement('div')
    overlay.append(ghost)
    card.append(overlay, scroll)
    document.body.append(card)
    expect(findComposerCard(ghost)).toBe(card)
  })
})

describe('sameGhostBox', () => {
  const box: GhostBox = { top: 72, left: 30, width: 578 }

  it('compares by value so an unchanged measurement does not re-render', () => {
    expect(sameGhostBox(box, { ...box })).toBe(true)
    expect(sameGhostBox(undefined, undefined)).toBe(true)
  })

  it('detects a moved editor and a missing measurement', () => {
    expect(sameGhostBox(box, { ...box, top: 120 })).toBe(false)
    expect(sameGhostBox(box, undefined)).toBe(false)
    expect(sameGhostBox(undefined, box)).toBe(false)
  })
})
