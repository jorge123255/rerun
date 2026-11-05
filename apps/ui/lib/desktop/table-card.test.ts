import { describe, expect, it, vi } from 'vitest'
import { CARD_MAX_CELL_CHARS, CARD_MAX_COLUMNS, CARD_MAX_GROUPS, CARD_MAX_MEDIA_CHARS, CARD_MAX_ROWS } from '@rerun/contracts'
import { desktopTableCardFocus, desktopTableCardImageUrl, desktopTableCardOf } from './table-card'

const card = (patch: Record<string, unknown> = {}) => ({
    kind: 'table' as const,
    scope: 'agent' as const,
    table: 'deals',
    columns: ['name', 'stage'],
    rows: [{ name: 'Acme', stage: 'Won' }],
    total: 1,
    columnsTruncated: false,
    view: 'Pipeline',
    ...patch,
})

describe('desktopTableCardOf', () => {
    it('accepts the live tool output, a stored wrapper and a parsed card', () => {
        expect(desktopTableCardOf(card())).toMatchObject({ table: 'deals', rows: [{ name: 'Acme', stage: 'Won' }] })
        expect(desktopTableCardOf(JSON.stringify(card()))).toMatchObject({ table: 'deals' })
        expect(desktopTableCardOf({ type: 'text', value: JSON.stringify(card()) })).toMatchObject({ table: 'deals' })
        expect(desktopTableCardOf({ type: 'json', value: card() })).toMatchObject({ table: 'deals' })
    })

    it('refuses an oversized serialized result before parsing it', () => {
        const oversized = JSON.stringify(card({ rows: [{ name: 'x'.repeat(60_000) }] }))
        const parse = vi.spyOn(JSON, 'parse')
        try {
            expect(desktopTableCardOf(oversized)).toBeUndefined()
            expect(parse).not.toHaveBeenCalled()
        } finally { parse.mockRestore() }
    })

    it('rejects anything that is not a bounded table card', () => {
        expect(desktopTableCardOf(undefined)).toBeUndefined()
        expect(desktopTableCardOf('not json')).toBeUndefined()
        expect(desktopTableCardOf({ ...card(), kind: 'file' })).toBeUndefined()
        expect(desktopTableCardOf({ ...card(), scope: 'workspace' })).toBeUndefined()
        expect(desktopTableCardOf(card({ table: '' }))).toBeUndefined()
        expect(desktopTableCardOf(card({ total: -1 }))).toBeUndefined()
        expect(desktopTableCardOf(card({ total: 1.5 }))).toBeUndefined()
        expect(desktopTableCardOf(card({ view: '' }))).toBeUndefined()
    })

    it('keeps the renderer bounds the layouts can draw', () => {
        const row = { name: 'Acme', stage: 'Won' }
        const rows = Array.from({ length: CARD_MAX_ROWS + 1 }, () => row)
        expect(desktopTableCardOf(card({ rows }))).toBeUndefined()
        expect(desktopTableCardOf(card({ rows: rows.slice(0, CARD_MAX_ROWS) }))?.rows).toHaveLength(CARD_MAX_ROWS)

        const columns = Array.from({ length: CARD_MAX_COLUMNS + 1 }, (_, index) => `c${index}`)
        expect(desktopTableCardOf(card({ columns }))).toBeUndefined()

        const groups = Array.from({ length: CARD_MAX_GROUPS + 1 }, (_, index) => ({ value: `g${index}`, total: 1 }))
        expect(desktopTableCardOf(card({ groups }))).toBeUndefined()
        expect(desktopTableCardOf(card({ groups: groups.slice(0, CARD_MAX_GROUPS) }))?.groups).toHaveLength(CARD_MAX_GROUPS)
        expect(desktopTableCardOf(card({ groups: [{ value: 'Won', total: 2, sum: 10 }] }))?.groups).toEqual([{ value: 'Won', total: 2, sum: 10 }])
        expect(desktopTableCardOf(card({ groups: [{ value: 'Won', total: 2, sum: 'ten' }] }))).toBeUndefined()

        expect(desktopTableCardOf(card({ rows: [{ name: 'x'.repeat(CARD_MAX_CELL_CHARS), stage: null }] }))).toBeDefined()
        expect(desktopTableCardOf(card({ rows: [{ name: 'x'.repeat(CARD_MAX_CELL_CHARS + 1), stage: null }] }))).toBeUndefined()
    })

    it('drops a row key the card does not declare a column for', () => {
        const parsed = desktopTableCardOf(card({ rows: [{ name: 'Acme', stage: 'Won', __rowid: 4, secret: 'x' }] }))
        expect(parsed?.rows).toEqual([{ name: 'Acme', stage: 'Won' }])
        expect(Object.keys(parsed!.rows[0])).not.toContain('__rowid')
    })

    it('draws a picture cell only from this coworker’s own Files, never from the network or the shared space', () => {
        const image = (value: unknown, scope: 'agent' | 'shared' = 'agent') => desktopTableCardOf(card({
            scope, columns: ['image'], rows: [{ image: value }], fields: { image: 'image', title: 'image' },
        }))?.rows[0].image

        expect(image('shots/photo.png')).toBe('shots/photo.png')
        expect(image('https://example.org/photo.png')).toBeNull()
        expect(image('//example.org/photo.png')).toBeNull()
        expect(image('data:image/png;base64,AAAA')).toBeNull()
        expect(image('/private/var/tmp/photo.png')).toBeNull()
        expect(image('../other/photo.png')).toBeNull()
        expect(image('.hidden/photo.png')).toBeNull()
        expect(image('notes.txt')).toBeNull()
        expect(image('shots/photo.png', 'shared')).toBeNull()
        expect(image(42)).toBeNull()
        expect(image('x'.repeat(CARD_MAX_MEDIA_CHARS + 1))).toBeNull()
    })

    it('bounds a url-formatted cell without rewriting it', () => {
        const cardWithUrl = (value: string) => desktopTableCardOf(card({
            columns: ['link'], rows: [{ link: value }], formats: { link: 'url' },
        }))
        expect(cardWithUrl('https://example.org/a')?.rows[0].link).toBe('https://example.org/a')
        expect(cardWithUrl(`https://example.org/${'x'.repeat(CARD_MAX_MEDIA_CHARS)}`)).toBeUndefined()
    })

    it('keeps the card scope as a label, never as an owner', () => {
        const parsed = desktopTableCardOf({ ...card(), agentId: 'another-coworker', owner: 'root' })
        expect(parsed).toBeDefined()
        expect(Object.keys(parsed!)).not.toContain('agentId')
        expect(Object.keys(parsed!)).not.toContain('owner')
        expect(parsed!.scope).toBe('agent')
    })

    it('opens the exact table and view the card names, and the table alone when it names none', () => {
        expect(desktopTableCardFocus(desktopTableCardOf(card())!)).toEqual({ table: 'deals', view: 'Pipeline' })
        expect(desktopTableCardFocus(desktopTableCardOf(card({ view: undefined }))!)).toEqual({ table: 'deals' })
    })
})

describe('desktopTableCardImageUrl', () => {
    it('addresses the authenticated Files image route of one trusted coworker', () => {
        expect(desktopTableCardImageUrl('agent 1', 'shots/photo.png')).toBe('/api/desktop/agents/agent%201/files/image?path=shots%2Fphoto.png')
    })

    it('refuses a path the Files route would not open', () => {
        expect(desktopTableCardImageUrl(undefined, 'shots/photo.png')).toBeNull()
        expect(desktopTableCardImageUrl('agent-1', 'https://example.org/photo.png')).toBeNull()
        expect(desktopTableCardImageUrl('agent-1', '/etc/passwd')).toBeNull()
        expect(desktopTableCardImageUrl('agent-1', 'shots/clip.mp4')).toBeNull()
    })
})
