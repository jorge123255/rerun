import {
    CARD_MAX_CELL_CHARS, CARD_MAX_COLUMNS, CARD_MAX_GROUPS, CARD_MAX_MEDIA_CHARS, CARD_MAX_ROWS,
    tableCardSchema, type TableCard, type TableCardGroup,
} from '@rerun/contracts'
import type { DataFocus } from '@/lib/data/source'

const TABLE_NAME_MAX = 200
const CARD_MAX_CHARS = 60_000
const IMAGE = /\.(?:png|jpe?g|webp|gif)$/i
const PROTOCOL = /^[a-z][a-z0-9+.-]*:/i
const CONTROL = /[\p{Cc}]/u

function candidate(value: unknown, depth = 0): unknown {
    if (depth > 2) return undefined
    if (typeof value === 'string') {
        if (value.length > CARD_MAX_CHARS) return undefined
        try { return candidate(JSON.parse(value), depth + 1) }
        catch { return undefined }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const wrapper = value as { type?: unknown; value?: unknown }
        if (wrapper.type === 'json' && 'value' in wrapper) return candidate(wrapper.value, depth + 1)
        if (wrapper.type === 'text' && typeof wrapper.value === 'string') return candidate(wrapper.value, depth + 1)
    }
    return value
}

/** A path this coworker's authenticated Files image route can open, relative to its Files root. */
function ownImagePath(path: string): boolean {
    return path.length > 0 && path.length <= 4096 && IMAGE.test(path) && !path.startsWith('/') && !path.includes('\\')
        && !CONTROL.test(path) && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('.'))
}

/**
 * The one authenticated image access the Mac app has: the bytes route of this conversation's
 * coworker. A card never turns a cell into another host, another coworker's Files, or a direct
 * file read. Returns null when the cell cannot be shown, so the layout draws its glyph.
 */
export function desktopTableCardImageUrl(agentId: string | undefined, path: unknown): string | null {
    if (!agentId || typeof path !== 'string' || !ownImagePath(path)) return null
    return `/api/desktop/agents/${encodeURIComponent(agentId)}/files/image?path=${encodeURIComponent(path)}`
}

function imageColumns(card: TableCard): Set<string> {
    const columns = new Set<string>()
    if (card.fields?.image) columns.add(card.fields.image)
    for (const [column, format] of Object.entries(card.formats ?? {})) if (format === 'image') columns.add(column)
    return columns
}

/**
 * A card cell that names a picture. The web card hotlinks an http(s) value before it ever asks the
 * host for a file, so a remote or shared value is dropped here instead: the Mac app makes no
 * network request a database row chose, and the shared database has no authenticated image route.
 */
function imageCell(value: unknown): unknown {
    if (typeof value !== 'string' || value.length > CARD_MAX_MEDIA_CHARS || PROTOCOL.test(value) || value.startsWith('//')) return null
    return ownImagePath(value) ? value : null
}

function boundedGroup(value: unknown): TableCardGroup | undefined {
    if (!value || typeof value !== 'object') return undefined
    const group = value as { value?: unknown; total?: unknown; sum?: unknown }
    if (typeof group.value !== 'string' || group.value.length > CARD_MAX_CELL_CHARS) return undefined
    if (!Number.isSafeInteger(group.total) || (group.total as number) < 0) return undefined
    if (group.sum !== undefined && (typeof group.sum !== 'number' || !Number.isFinite(group.sum))) return undefined
    return { value: group.value, total: group.total as number, ...(group.sum === undefined ? {} : { sum: group.sum as number }) }
}

/**
 * Validate one recorded card_table result for the Mac conversation. It accepts the live tool output
 * (a JSON string), a stored text/json wrapper and a parsed card. The engine already bounded what it
 * wrote, but a saved tool result is untrusted input to the renderer, so every bound is re-checked
 * and every picture cell is reduced to either this coworker's own Files path or nothing.
 *
 * The card's `scope` is a label and the choice between the two panels; it is never an owner. The
 * coworker that owns the conversation decides whose Files are read, and both database routes
 * authorize themselves.
 */
export function desktopTableCardOf(value: unknown): TableCard | undefined {
    const parsed = tableCardSchema.safeParse(candidate(value))
    if (!parsed.success) return undefined
    const card = parsed.data
    if (!card.table || card.table.length > TABLE_NAME_MAX || card.columns.length > CARD_MAX_COLUMNS) return undefined
    if (card.rows.length > CARD_MAX_ROWS) return undefined
    if (!Number.isSafeInteger(card.total) || card.total < 0) return undefined
    const groups = card.groups?.map(boundedGroup)
    if (groups?.some(group => group === undefined) || (groups?.length ?? 0) > CARD_MAX_GROUPS) return undefined
    if (card.view !== undefined && (!card.view || card.view.length > TABLE_NAME_MAX)) return undefined

    const images = imageColumns(card)
    const media = new Set([...images, ...Object.entries(card.formats ?? {}).filter(([, format]) => format === 'url').map(([column]) => column)])
    const rows: Record<string, unknown>[] = []
    for (const row of card.rows) {
        const kept: Record<string, unknown> = {}
        for (const column of card.columns) {
            const cell = row[column]
            if (images.has(column)) { kept[column] = card.scope === 'agent' ? imageCell(cell) : null; continue }
            if (typeof cell === 'string' && cell.length > (media.has(column) ? CARD_MAX_MEDIA_CHARS : CARD_MAX_CELL_CHARS)) return undefined
            kept[column] = cell === undefined ? null : cell
        }
        rows.push(kept)
    }
    // The card lives in the transcript and is replayed later: a forged payload never gets to be
    // larger than the tool output bound the worker already enforces.
    if (JSON.stringify({ ...card, rows }).length > CARD_MAX_CHARS) return undefined

    return {
        ...card,
        columns: [...card.columns],
        rows,
        ...(groups ? { groups: groups as TableCardGroup[] } : {}),
        ...(card.fields ? { fields: { ...card.fields } } : {}),
    }
}

/** What the Open database button asks the app to show: the live table, on this card's view. */
export function desktopTableCardFocus(card: TableCard): DataFocus {
    return { table: card.table, ...(card.view ? { view: card.view } : {}) }
}
