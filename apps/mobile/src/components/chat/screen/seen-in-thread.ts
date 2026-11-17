// The web's `useSeenInThread`: below this share of a block in view, it does not count as seen.
const SEEN_RATIO = 0.4

type Span = { top: number; bottom: number }

// Whether enough of a block of the thread sits in the part of it left visible, between the header
// and the footer that float over it, both in content coordinates.
export function seenInThread(block: Span, visible: Span): boolean {
    const height = block.bottom - block.top
    if (height <= 0) return true
    const shown = Math.min(visible.bottom, block.bottom) - Math.max(visible.top, block.top)
    return shown / height >= SEEN_RATIO
}
