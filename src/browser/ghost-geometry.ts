/**
 * Geometry for the suggestion ghost.
 *
 * The ghost renders into the composer's overlay slot (`[data-composer-overlay]`,
 * `position: absolute; inset: 0 0 auto`), so its containing block is the
 * composer CARD's padding box — not the editor. The editor is NOT at the card's
 * top edge: the card is a flex column with a `gap`, and the attachments row
 * (image chips) plus the accessory slot sit above it. A fixed `top` in the
 * stylesheet therefore lands ON the attachments row as soon as the composer
 * carries one, which is exactly the overlap this module removes.
 *
 * Instead of hard-coding offsets that drift with every composer tweak, the ghost
 * measures the editor's text origin and copies it. When the DOM cannot be
 * measured (jsdom, a detached tree, an editor that has not been laid out) the
 * stylesheet defaults apply.
 */

/** Offsets, in px, from the overlay anchor box to the editor's text origin. */
export interface GhostBox {
  readonly top: number
  readonly left: number
  readonly width: number
}

/** The element that actually hosts draft text: Lexical host or legacy textarea. */
const EDITABLE_SELECTOR = '[contenteditable], textarea'

/** Parse a computed px length; an unparseable value falls back to `fallback`. */
function px(value: string | undefined, fallback = 0): number {
  if (value === undefined) return fallback
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * The composer card that hosts `anchor`.
 *
 * The card is addressed by its `[data-composer-card]` marker. Should a future
 * composer drop that marker, the same element is still identifiable structurally
 * — it is the nearest ancestor that also contains the editor scroll layer — so
 * the ghost keeps measuring instead of silently reverting to a stylesheet offset.
 * @param anchor - any node rendered into the composer overlay slot.
 * @returns the card element, or `null` when `anchor` is detached/not a composer.
 */
export function findComposerCard(anchor: Element | null): HTMLElement | null {
  if (anchor === null) return null
  const marked = anchor.closest('[data-composer-card]')
  if (marked instanceof HTMLElement) return marked
  for (let node = anchor.parentElement; node !== null; node = node.parentElement) {
    if (node.querySelector('[data-input-scroll]') !== null) return node
  }
  return null
}

/**
 * Measure the composer editor's text origin, relative to the card's padding box
 * (the box the absolutely positioned overlay anchor fills).
 *
 * The editor's own computed padding is included, so the ghost tracks the first
 * glyph rather than the editor border box — and it keeps working when the
 * composer moves that padding between the scroll layer and the editable host.
 *
 * @param card - the composer card, or `null` when there is none.
 * @returns the measured box, or `undefined` when there is no layout to copy.
 */
export function measureGhostBox(card: HTMLElement | null): GhostBox | undefined {
  if (card === null) return undefined
  const scroll = card.querySelector('[data-input-scroll]')
  if (!(scroll instanceof HTMLElement)) return undefined
  const editable = scroll.querySelector(EDITABLE_SELECTOR)
  const host = editable instanceof HTMLElement ? editable : scroll
  const cardRect = card.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  // A zero-sized box means "no layout here" (jsdom, a detached tree) or an
  // editor that has not been laid out yet: there is nothing to copy, so the
  // caller keeps the stylesheet defaults rather than pinning the ghost to 0,0.
  if (hostRect.width <= 0 || hostRect.height <= 0) return undefined
  const cardStyle = getComputedStyle(card)
  const hostStyle = getComputedStyle(host)
  const padTop = px(hostStyle.paddingTop)
  const padLeft = px(hostStyle.paddingLeft)
  const padRight = px(hostStyle.paddingRight)
  const top = hostRect.top - cardRect.top - px(cardStyle.borderTopWidth) + padTop
  const left = hostRect.left - cardRect.left - px(cardStyle.borderLeftWidth) + padLeft
  const width = hostRect.width - padLeft - padRight
  if (!Number.isFinite(top) || !Number.isFinite(left)) return undefined
  return { top, left, width: width > 0 ? width : 0 }
}

/**
 * Value equality for measured boxes, so a re-measure that changed nothing does
 * not re-render the ghost.
 * @param a - previous box.
 * @param b - freshly measured box.
 * @returns true when both describe the same geometry.
 */
export function sameGhostBox(a: GhostBox | undefined, b: GhostBox | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.top === b.top && a.left === b.left && a.width === b.width
}
