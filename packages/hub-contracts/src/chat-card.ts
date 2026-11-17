import { z } from 'zod'

// A card is a snapshot frozen at the moment the agent sent it, carried in the tool output so it
// survives a reload. These bounds keep that payload small: it is replayed into the model context on
// every later turn of the conversation.
export const CARD_DEFAULT_ROWS = 5
export const CARD_MAX_ROWS = 20
export const CARD_MAX_COLUMNS = 8
export const CARD_MAX_CELL_CHARS = 120
// An image or a link cut short is a broken one, so those cells get a wider bound, and a value past it
// is dropped rather than truncated.
export const CARD_MAX_MEDIA_CHARS = 2048
export const CARD_MAX_GROUPS = 6

export const CARD_LAYOUTS = ['table', 'list', 'gallery', 'board'] as const
export type CardLayout = (typeof CARD_LAYOUTS)[number]

/** The badge tones an agent can name, a subset of the UI's BadgeTone that contracts cannot import. */
export const CARD_TONES = ['brand', 'neutral', 'green', 'red', 'orange', 'cyan', 'yellow'] as const
export type CardTone = (typeof CARD_TONES)[number]

export const CARD_FORMATS = ['number', 'percent', 'date', 'datetime', 'rating', 'progress', 'boolean', 'url', 'email', 'tag', 'image'] as const
export type CardFormat = (typeof CARD_FORMATS)[number] | `currency:${string}`

const CURRENCY_FORMAT = /^currency:[A-Z]{3}$/

export function isCardFormat(value: string): value is CardFormat {
    return (CARD_FORMATS as readonly string[]).includes(value) || CURRENCY_FORMAT.test(value)
}

export const CARD_GALLERY_SHAPES = ['square', 'landscape', 'portrait'] as const
export const CARD_GALLERY_ARRANGEMENTS = ['grid', 'carousel'] as const

export const cardFieldsSchema = z.object({
    title: z.string().optional(),
    subtitle: z.string().optional(),
    image: z.string().optional(),
    badge: z.string().optional(),
    value: z.string().optional(),
    date: z.string().optional(),
})
export type CardFields = z.infer<typeof cardFieldsSchema>
export const CARD_FIELD_ROLES = ['title', 'subtitle', 'image', 'badge', 'value', 'date'] as const satisfies readonly (keyof CardFields)[]

export const cardTonesSchema = z.record(z.string(), z.enum(CARD_TONES).catch('neutral'))

export const cardDisplaySchema = z.object({
    shape: z.enum(CARD_GALLERY_SHAPES).optional(),
    arrangement: z.enum(CARD_GALLERY_ARRANGEMENTS).optional(),
})

// Everything past `columnsTruncated` is optional and forgiving: a card sent before layouts existed
// still parses, and a layout, tone or display a newer engine sends falls back instead of failing the
// whole card.
export const tableCardSchema = z.object({
    kind: z.literal('table'),
    scope: z.enum(['agent', 'shared']),
    table: z.string(),
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.unknown())),
    total: z.number(),
    columnsTruncated: z.boolean(),
    layout: z.enum(CARD_LAYOUTS).optional().catch(undefined),
    fields: cardFieldsSchema.optional(),
    /** Column name to format. The renderer draws a format it does not know as plain text. */
    formats: z.record(z.string(), z.string()).optional(),
    /** Badge value to tone. */
    tones: cardTonesSchema.optional(),
    groupBy: z.string().optional(),
    /** One entry per board column, counted over the whole table, not over the rows in the card. */
    groups: z.array(z.object({ value: z.string(), total: z.number(), sum: z.number().optional() })).optional(),
    display: cardDisplaySchema.optional().catch(undefined),
    /** The saved view the card was drawn from, so opening the database lands on it. */
    view: z.string().optional(),
})
export type TableCard = z.infer<typeof tableCardSchema>
export type TableCardGroup = NonNullable<TableCard['groups']>[number]

export const CARD_MAX_FILES = 12

export const fileCardEntrySchema = z.object({
    path: z.string(),
    name: z.string(),
    size: z.number(),
    // A path is relative to the root it was resolved in: the agent's workspace or the shared space.
    scope: z.enum(['agent', 'shared']).default('agent'),
})
export type FileCardEntry = z.infer<typeof fileCardEntrySchema>

// A card sent before one card could carry several files holds its single file at the top level.
const withLegacySingleFile = (value: unknown) =>
    value && typeof value === 'object' && !('files' in value) && 'path' in value ? { kind: 'file', files: [value] } : value

export const fileCardSchema = z.preprocess(
    withLegacySingleFile,
    z.object({
        kind: z.literal('file'),
        files: z.array(fileCardEntrySchema).min(1),
    })
)
export type FileCard = z.infer<typeof fileCardSchema>

// How a card cell reads as text, shared by the web card and the app's.
export function cellText(value: unknown): string {
    if (value === null || value === undefined) return ''
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
}

// Fixed locale and UTC: cards are also server-rendered on the landing, and a date formatted in the
// reader's zone would not hydrate.
export function formatText(value: unknown, format?: string): string {
    if (value === null || value === undefined || value === '') return ''
    if (format?.startsWith('currency:')) {
        const number = Number(value)
        if (Number.isNaN(number)) return cellText(value)
        try {
            return new Intl.NumberFormat('en-US', { style: 'currency', currency: format.slice('currency:'.length), maximumFractionDigits: 0 }).format(number)
        } catch {
            return cellText(value)
        }
    }
    if (format === 'number') {
        const number = Number(value)
        if (Number.isNaN(number)) return cellText(value)
        return new Intl.NumberFormat('en-US', { notation: Math.abs(number) >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 2 }).format(number)
    }
    if (format === 'percent') {
        const number = Number(value)
        return Number.isNaN(number) ? cellText(value) : `${Math.round(number * 100)}%`
    }
    if (format === 'date' || format === 'datetime') {
        const date = parseUtc(String(value))
        if (Number.isNaN(date.getTime())) return cellText(value)
        return new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            timeZone: 'UTC',
            ...(format === 'datetime' ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
        }).format(date)
    }
    if (format === 'url')
        return String(value)
            .replace(/^https?:\/\/(www\.)?/, '')
            .replace(/\/$/, '')
    return cellText(value)
}

function parseUtc(text: string) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(`${text}T00:00:00Z`)
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text)) return new Date(`${text.replace(' ', 'T')}Z`)
    return new Date(text)
}

export function isNumericFormat(format?: string) {
    return format === 'number' || format === 'percent' || !!format?.startsWith('currency:')
}

// SQLite has no boolean type: an agent stores 0/1, and sometimes the strings 'true' / 'false'.
export function isTruthyCell(value: unknown) {
    if (typeof value === 'string') return !['', '0', 'false', 'no'].includes(value.trim().toLowerCase())
    return !!value
}
