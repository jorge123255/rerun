import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import matter from 'gray-matter'
import { BRAIN_CARD_TYPES, brainPageTypeSchema, brainPageWriteSchema, brainSlugSchema, type BrainPage, type BrainPageSummary, type BrainRevision } from '@rerun/contracts'
import { chunkPage, pageSections, textHash } from '../brain/chunks.js'
import { parseLinks } from '../brain/links.js'
import { HttpError, notFound } from '../lib/errors.js'

export const DESKTOP_BRAIN_AUTHOR = 'user:local-profile-1'
export const desktopBrainWriteSchema = brainPageWriteSchema.omit({ author: true }).extend({ title: brainPageWriteSchema.shape.title.trim().min(1), baseHash: brainPageWriteSchema.shape.baseHash.unwrap().regex(/^[a-f0-9]{32}$/).nullable() }).strict()
const MAX_FILE_BYTES = 512_000
const MAX_PAGES = 1000
const locks = new Map<string, Promise<unknown>>()
export async function withDesktopBrainPagesLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
    const key = resolve(directory)
    const previous = locks.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    locks.set(key, next)
    try { return await next } finally { if (locks.get(key) === next) locks.delete(key) }
}
type PageFile = BrainPageSummary & { content: string; sources: string[]; unconfirmed: string[] }
type Detail = { page: BrainPage; revisions: BrainRevision[] }
type RevisionContent = { revision: BrainRevision; content: string }
const pageHash = (page: { title: string; type: string; content: string }) => textHash(`${page.title.trim()}\n${page.type}\n${page.content.trim()}`)
const headings = (content: string) => [...new Set(pageSections(content).map(section => section.heading))]
const words = (body: string) => body.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const conflict = () => new HttpError(409, 'This page changed. Reload it before applying your change.')
const slugOf = (value: string) => brainSlugSchema.parse(value)
const revisionOf = (row: Record<string, unknown>): BrainRevision => ({ id: String(row.id), slug: String(row.slug), title: String(row.title), hash: String(row.hash), author: String(row.author), proposalId: row.proposal_id == null ? null : String(row.proposal_id), createdAt: String(row.created_at) })

export async function assertDesktopBrainDirectory(directory: string): Promise<void> {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || await realpath(directory) !== resolve(directory)) throw new HttpError(503, 'Brain storage is unavailable.')
}

// Uses the original Markdown store and brainDb tables. No embedding/seed/model-tool module is loaded.
export function createDesktopBrainPagesStore(directory: string, getDatabase: () => Promise<Client>) {
    directory = resolve(directory)
    let directoryIdentity: { dev: number; ino: number } | undefined
    async function assertDirectory() {
        await assertDesktopBrainDirectory(directory)
        const stat = await lstat(directory)
        if (directoryIdentity && (stat.dev !== directoryIdentity.dev || stat.ino !== directoryIdentity.ino)) throw new HttpError(503, 'Brain directory changed.')
        directoryIdentity ??= { dev: stat.dev, ino: stat.ino }
    }
    const pathOf = (slug: string) => resolve(directory, `${slugOf(slug)}.md`)
    async function rawPage(slug: string): Promise<string | null> {
        await assertDirectory()
        let file
        try { file = await open(pathOf(slug), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
        catch (error) { if (missing(error)) return null; throw error }
        try {
            const stat = await file.stat()
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new HttpError(503, 'Brain page storage is invalid or too large.')
            const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
            let count = 0
            while (count < bytes.length) {
                const next = await file.read(bytes, count, bytes.length - count, null)
                if (!next.bytesRead) break
                count += next.bytesRead
            }
            if (count > MAX_FILE_BYTES) throw new HttpError(503, 'Brain page storage is too large.')
            return bytes.subarray(0, count).toString('utf8')
        } finally { await file.close() }
    }
    function parsePage(slug: string, raw: string): PageFile {
        const { data, content: body } = matter(raw)
        const asString = (value: unknown) => typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : null
        const content = body.trim(), updatedBy = asString(data.updatedBy) ?? 'user'
        const type = brainPageTypeSchema.safeParse(data.type)
        const sections = headings(content)
        const page = { slug, title: asString(data.title)?.trim() || slug, type: type.success ? type.data : 'note' as const, content,
            sources: Array.isArray(data.sources) ? data.sources.map(String) : [], updatedAt: asString(data.updatedAt) ?? '', updatedBy,
            unconfirmed: Array.isArray(data.unconfirmed) ? data.unconfirmed.map(String).filter(h => sections.includes(h)) : updatedBy === 'seed' ? sections : [] }
        if (!brainPageWriteSchema.safeParse({ ...page, baseHash: null, author: updatedBy }).success) throw new HttpError(503, 'Brain page storage is invalid.')
        return { ...page, hash: pageHash(page) }
    }
    const readPage = async (slug: string) => { const raw = await rawPage(slug); return raw === null ? null : parsePage(slug, raw) }
    async function replace(slug: string, raw: string): Promise<void> {
        await assertDirectory()
        const target = pathOf(slug), temporary = `${target}.${randomUUID()}.tmp`
        try {
            await writeFile(temporary, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
            await rename(temporary, target)
        } finally { await rm(temporary, { force: true }) }
    }
    async function run<T>(write: boolean, action: (db: Transaction, rollback: (fn: () => Promise<void>) => void) => Promise<T>): Promise<T> {
        return withDesktopBrainPagesLock(directory, async () => {
            await assertDirectory()
            const db = await (await getDatabase()).transaction(write ? 'write' : 'read')
            const undo: Array<() => Promise<void>> = []
            try {
                const result = await action(db, fn => undo.push(fn))
                await assertDirectory()
                await db.commit()
                return result
            } catch (error) {
                let failed = false
                try { await db.rollback() } catch { failed = true }
                for (const restore of undo.reverse()) { try { await restore() } catch { failed = true } }
                if (failed) throw new HttpError(503, 'Brain storage recovery failed. Local reconciliation is required.')
                throw error
            } finally { db.close() }
        })
    }
    async function revisions(db: Transaction, slug: string): Promise<BrainRevision[]> {
        const rows = (await db.execute({ sql: 'SELECT id, slug, title, hash, author, proposal_id, created_at FROM brain_revisions WHERE slug = ? ORDER BY created_at DESC, rowid DESC LIMIT 50', args: [slugOf(slug)] })).rows
        if (!rows.length && !(await readPage(slug))) throw notFound('page')
        return rows.map(revisionOf)
    }
    async function revision(db: Transaction, slug: string, id: string): Promise<RevisionContent> {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HttpError(400, 'Invalid revision identity.')
        const row = (await db.execute({ sql: 'SELECT * FROM brain_revisions WHERE slug = ? AND id = ?', args: [slugOf(slug), id] })).rows[0]
        if (!row) throw notFound('revision')
        if (String(row.content).length > 60_000) throw new HttpError(503, 'Brain revision is too large.')
        return { revision: revisionOf(row), content: String(row.content) }
    }
    async function detail(db: Transaction, slug: string): Promise<Detail> {
        const page = await readPage(slug)
        if (!page) throw notFound('page')
        const indexed = (await db.execute({ sql: 'SELECT hash FROM brain_pages WHERE slug = ?', args: [slug] })).rows[0]
        if (!indexed) throw new HttpError(503, 'Brain page is missing from its local index.')
        if (String(indexed.hash) !== page.hash) throw new HttpError(409, 'Brain index needs local reconciliation.')
        const rows = (await db.execute({ sql: 'SELECT l.from_slug AS slug, p.title FROM brain_links l JOIN brain_pages p ON p.slug = l.from_slug WHERE l.to_slug = ? ORDER BY p.title LIMIT 1001', args: [slug] })).rows
        if (rows.length > MAX_PAGES) throw new HttpError(413, 'Too many Brain backlinks.')
        return { page: { ...page, links: parseLinks(page.content, slug), backlinks: rows.map(row => ({ slug: String(row.slug), title: String(row.title) })) }, revisions: await revisions(db, slug) }
    }
    async function unindex(db: Transaction, slug: string) {
        await db.execute({ sql: 'DELETE FROM brain_chunks_fts WHERE chunk_id IN (SELECT id FROM brain_chunks WHERE slug = ?)', args: [slug] })
        for (const table of ['brain_chunks', 'brain_links', 'brain_pages']) await db.execute({ sql: `DELETE FROM ${table} WHERE ${table === 'brain_links' ? 'from_slug' : 'slug'} = ?`, args: [slug] })
    }
    async function index(db: Transaction, page: PageFile) {
        await unindex(db, page.slug)
        for (const chunk of chunkPage(page)) {
            const id = randomUUID()
            await db.execute({ sql: 'INSERT INTO brain_chunks(id, slug, heading, ordinal, content, text_hash) VALUES (?, ?, ?, ?, ?, ?)', args: [id, page.slug, chunk.heading, chunk.ordinal, chunk.content, chunk.textHash] })
            await db.execute({ sql: 'INSERT INTO brain_chunks_fts(content, chunk_id) VALUES (?, ?)', args: [chunk.text, id] })
        }
        for (const target of parseLinks(page.content, page.slug)) await db.execute({ sql: 'INSERT OR IGNORE INTO brain_links(from_slug, to_slug) VALUES (?, ?)', args: [page.slug, target] })
        await db.execute({ sql: 'INSERT INTO brain_pages(slug, title, type, hash, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)', args: [page.slug, page.title, page.type, page.hash, page.updatedAt, page.updatedBy] })
    }
    async function save(db: Transaction, undo: (fn: () => Promise<void>) => void, slug: string, rawInput: unknown, separateRevision = false, restoredSeed = false): Promise<Detail> {
        const input = desktopBrainWriteSchema.parse(rawInput)
        const raw = await rawPage(slug), current = raw === null ? null : parsePage(slug, raw)
        if ((current && input.baseHash !== current.hash) || (!current && input.baseHash !== null)) throw conflict()
        const fields = { title: input.title.trim(), type: input.type, content: input.content.trim(), sources: input.sources }
        const hash = pageHash(fields)
        if (current && current.hash === hash && JSON.stringify(current.sources) === JSON.stringify(fields.sources)) return detail(db, slug)
        if (!current && Number((await db.execute('SELECT COUNT(*) AS n FROM brain_pages')).rows[0].n) >= MAX_PAGES) throw new HttpError(413, 'Too many Brain pages.')
        const before = new Map(pageSections(current?.content ?? '').map(section => [section.heading, words(section.body)]))
        const unconfirmed = restoredSeed ? headings(fields.content) : [...new Set(pageSections(fields.content).filter(section => current?.unconfirmed.includes(section.heading) && before.get(section.heading) === words(section.body)).map(section => section.heading))]
        const page: PageFile = { slug, ...fields, hash, updatedAt: new Date().toISOString(), updatedBy: DESKTOP_BRAIN_AUTHOR, unconfirmed }
        const body = matter.stringify(`\n${page.content}\n`, { title: page.title, type: page.type, updatedAt: page.updatedAt, updatedBy: page.updatedBy, sources: page.sources, unconfirmed })
        await index(db, page)
        const last = (await db.execute({ sql: 'SELECT id, author, proposal_id, created_at FROM brain_revisions WHERE slug = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', args: [slug] })).rows[0]
        if (current && !separateRevision && last && last.proposal_id == null && String(last.author) === page.updatedBy && Date.parse(page.updatedAt) - Date.parse(String(last.created_at)) < 10 * 60_000) {
            await db.execute({ sql: 'UPDATE brain_revisions SET title = ?, content = ?, hash = ?, created_at = ? WHERE id = ?', args: [page.title, page.content, page.hash, page.updatedAt, String(last.id)] })
        } else {
            await db.execute({ sql: 'INSERT INTO brain_revisions(id, slug, title, content, hash, author, proposal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', args: [randomUUID(), slug, page.title, page.content, page.hash, page.updatedBy, null, page.updatedAt] })
        }
        await replace(slug, body)
        undo(() => raw === null ? rm(pathOf(slug)) : replace(slug, raw))
        return detail(db, slug)
    }
    return {
        rebuildLocalIndex: () => run(true, async db => {
            const entries = await readdir(directory, { withFileTypes: true })
            const slugs = entries.filter(entry => entry.name.endsWith('.md')).map(entry => entry.name.slice(0, -3)).filter(slug => brainSlugSchema.safeParse(slug).success)
            if (slugs.length > MAX_PAGES) throw new HttpError(413, 'Too many Brain pages.')
            const pages: PageFile[] = []
            for (const slug of slugs) {
                const page = await readPage(slug)
                if (!page) throw new HttpError(503, 'Brain page disappeared during indexing.')
                pages.push(page)
            }
            for (const table of ['brain_chunks_fts', 'brain_chunks', 'brain_links', 'brain_pages']) await db.execute(`DELETE FROM ${table}`)
            for (const page of pages) await index(db, page)
            return { indexed: pages.length }
        }),
        listPages: () => run(false, async db => {
            const rows = (await db.execute('SELECT slug, title, type, hash, updated_at, updated_by FROM brain_pages LIMIT 1001')).rows
            if (rows.length > MAX_PAGES) throw new HttpError(413, 'Too many Brain pages.')
            const pages: BrainPageSummary[] = []
            for (const row of rows) {
                const page = await readPage(String(row.slug))
                if (!page) throw new HttpError(503, 'Brain index refers to a missing page.')
                if (page.hash !== String(row.hash)) throw new HttpError(409, 'Brain index needs local reconciliation.')
                const { content: _content, sources: _sources, unconfirmed: _unconfirmed, ...summary } = page
                pages.push(summary)
            }
            const order = new Map<string, number>(BRAIN_CARD_TYPES.map((type, index) => [type, index]))
            return pages.sort((a, b) => (order.get(a.type) ?? order.size) - (order.get(b.type) ?? order.size) || a.title.localeCompare(b.title))
        }),
        readPage: (slug: string) => run(false, db => detail(db, slugOf(slug))),
        savePage: (slug: string, input: unknown) => run(true, (db, undo) => save(db, undo, slugOf(slug), input)),
        deletePage: (slug: string) => run(true, async (db, undo) => {
            const raw = await rawPage(slug)
            if (raw === null) throw notFound('page')
            await unindex(db, slug)
            await rm(pathOf(slug))
            undo(() => replace(slug, raw))
            return { ok: true as const }
        }),
        listRevisions: (slug: string) => run(false, db => revisions(db, slug)),
        readRevision: (slug: string, id: string) => run(false, db => revision(db, slug, id)),
        restorePage: (slug: string, id: string, expectedHash: string) => run(true, async (db, undo) => {
            const current = await readPage(slug)
            if (!current) throw notFound('page')
            if (current.hash !== expectedHash) throw conflict()
            const found = await revision(db, slug, id)
            return save(db, undo, slug, { title: found.revision.title, type: current.type, content: found.content, sources: current.sources, baseHash: expectedHash }, true, found.revision.author === 'seed')
        }),
        confirmSections: (slug: string, sections: string[] | null) => run(true, async (db, undo) => {
            const raw = await rawPage(slug)
            if (raw === null) throw notFound('page')
            const page = parsePage(slug, raw)
            page.unconfirmed = sections === null ? [] : page.unconfirmed.filter(heading => !sections.includes(heading))
            await replace(slug, matter.stringify(`\n${page.content}\n`, { title: page.title, type: page.type, updatedAt: page.updatedAt, updatedBy: page.updatedBy, sources: page.sources, unconfirmed: page.unconfirmed }))
            undo(() => replace(slug, raw))
            return detail(db, slug)
        }),
    }
}
