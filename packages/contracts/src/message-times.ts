import type { AuthorTurn } from './chat-author.js'

const DAY_MS = 24 * 60 * 60 * 1000
export const TIME_BREAK_GAP_MS = 60 * 60 * 1000

export function calendarDaysBetween(earlier: Date, later: Date): number {
    const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    return Math.round((startOf(later) - startOf(earlier)) / DAY_MS)
}

export function messageDayLabel(iso: string, now: Date = new Date()): string {
    const date = new Date(iso)
    const daysAgo = calendarDaysBetween(date, now)
    if (daysAgo <= 0) return 'Today'
    if (daysAgo === 1) return 'Yesterday'
    if (daysAgo < 7) return date.toLocaleDateString('en-US', { weekday: 'long' })
    const sameYear = date.getFullYear() === now.getFullYear()
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

function opensStretch(previous: string, time: string): boolean {
    const before = new Date(previous)
    const current = new Date(time)
    return current.getTime() - before.getTime() >= TIME_BREAK_GAP_MS || calendarDaysBetween(before, current) !== 0
}

/** The messages that open a stretch of the conversation: the first one, a new day, or a word after an hour of silence. */
export function timeBreaksOf(times: readonly string[]): Set<number> {
    const breaks = new Set<number>()
    let previous: string | undefined
    times.forEach((time, index) => {
        if (!Number.isFinite(Date.parse(time))) return
        if (previous === undefined || opensStretch(previous, time)) breaks.add(index)
        previous = time
    })
    return breaks
}

/** A person who picks the thread back up hours later starts a new group, under its own separator. */
export function splitTurnsAtBreaks<M extends { id: string }>(turns: readonly AuthorTurn<M>[], breaks: ReadonlySet<number>): AuthorTurn<M>[] {
    return turns.flatMap(turn => {
        const pieces: AuthorTurn<M>[] = []
        for (const item of turn.items) {
            const current = pieces.at(-1)
            if (current && !breaks.has(item.index)) current.items.push(item)
            else pieces.push({ key: pieces.length === 0 ? turn.key : item.message.id, authorId: turn.authorId, items: [item] })
        }
        return pieces
    })
}
