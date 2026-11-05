import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import matter from 'gray-matter'
import { BRAIN_CARD_TYPES, brainPageTypeSchema, brainPageWriteSchema, brainSlugSchema, type BrainPage, type BrainPageSummary, type BrainRevision, type BrainProposalStatus } from '@rerun/contracts'
import { chunkPage, pageSections, textHash } from '../brain/chunks.js'
import { parseLinks } from '../brain/links.js'
import { desktopBrainDecisionSchema, desktopBrainHashSchema, desktopBrainProposalDraftSchema, desktopBrainProposalFingerprint, desktopBrainRequestIdSchema, desktopBrainTerms, type DesktopBrainAccess, type DesktopBrainDecision, type DesktopBrainDecisionInput, type DesktopBrainProposalDraft, type DesktopBrainProposalView, type DesktopBrainSearchResult } from './brain-proposals.js'
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
    let activePublications: Map<string, string | null> | null = null
    const pathOf = (slug: string) => resolve(directory, `${slugOf(slug)}.md`)
    async function rawPage(slug: string): Promise<string | null> {
        await assertDirectory()
        if (activePublications?.has(slug)) return activePublications.get(slug)!
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
            const file = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW)
            try { await file.sync() } finally { await file.close() }
            await rename(temporary, target)
            const parent = await open(directory, constants.O_RDONLY)
            try { await parent.sync() } finally { await parent.close() }
        } finally { await rm(temporary, { force: true }) }
    }
    // The committed journal makes page bytes, history, proposal decisions and receipts one
    // recoverable operation. Files are published only AFTER the SQLite commit, never before it.
    async function recoverPublications(database: Client) {
        const rows = (await database.execute('SELECT slug, raw FROM desktop_brain_publications ORDER BY slug')).rows
        for (const row of rows) {
            const slug = slugOf(String(row.slug))
            if (row.raw === null) {
                await rm(pathOf(slug), { force: true })
                const parent = await open(directory, constants.O_RDONLY)
                try { await parent.sync() } finally { await parent.close() }
            }
            else { parsePage(slug, String(row.raw)); await replace(slug, String(row.raw)) }
            await database.execute({ sql: 'DELETE FROM desktop_brain_publications WHERE slug = ?', args: [slug] })
        }
    }
    async function stage(db: Transaction, slug: string, raw: string | null) {
        await db.execute({ sql: 'INSERT INTO desktop_brain_publications(slug, raw) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET raw = excluded.raw', args: [slug, raw] })
        activePublications!.set(slug, raw)
    }
    async function run<T>(_write: boolean, action: (db: Transaction) => Promise<T>, access?: DesktopBrainAccess): Promise<T> {
        return withDesktopBrainPagesLock(directory, async () => {
            await assertDirectory()
            const database = await getDatabase()
            await recoverPublications(database)
            const db = await database.transaction('write')
            activePublications = new Map()
            try {
                access?.signal?.throwIfAborted()
                const result = await action(db)
                await access?.beforeCommit?.()
                access?.signal?.throwIfAborted()
                await assertDirectory()
                await db.commit()
                activePublications = null
                await recoverPublications(database)
                return result
            } catch (error) {
                if (!db.closed) await db.rollback().catch(() => {})
                throw error
            } finally { activePublications = null; db.close() }
        })
    }
    async function mutate<T>(requestId: string, identity: unknown, action: (db: Transaction) => Promise<T>): Promise<T> {
        desktopBrainRequestIdSchema.parse(requestId)
        const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
        const receipt = await run(true, async db => {
            const previous = (await db.execute({ sql: 'SELECT fingerprint, result_json FROM desktop_brain_receipts WHERE request_id = ?', args: [requestId] })).rows[0]
            if (previous) {
                if (String(previous.fingerprint) !== fingerprint) throw new HttpError(409, 'This request identity was already used for a different change.')
                return JSON.parse(String(previous.result_json)) as { value?: T; status?: number; error?: string }
            }
            let result: { value?: T; status?: number; error?: string }
            try { result = { value: await action(db) } }
            catch (error) {
                // Guard conflicts happen before any mutation. Failed I/O/SQL rolls the entire
                // transaction back; only a definitive guard refusal receives a durable receipt.
                if (!(error instanceof HttpError) || ![404, 409].includes(error.status)) throw error
                result = { status: error.status, error: error.message }
            }
            await db.execute({ sql: 'INSERT INTO desktop_brain_receipts(request_id, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?)', args: [requestId, fingerprint, JSON.stringify(result), new Date().toISOString()] })
            return result
        })
        if (receipt.status) throw new HttpError(receipt.status, receipt.error ?? 'Brain change failed.')
        return receipt.value as T
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
    async function save(db: Transaction, slug: string, rawInput: unknown, separateRevision = false, restoredSeed = false, proposalId: string | null = null, author = DESKTOP_BRAIN_AUTHOR): Promise<Detail> {
        const input = desktopBrainWriteSchema.parse(rawInput)
        const raw = await rawPage(slug), current = raw === null ? null : parsePage(slug, raw)
        if ((current && input.baseHash !== current.hash) || (!current && input.baseHash !== null)) throw conflict()
        const fields = { title: input.title.trim(), type: input.type, content: input.content.trim(), sources: input.sources }
        const hash = pageHash(fields)
        if (current && current.hash === hash && JSON.stringify(current.sources) === JSON.stringify(fields.sources)) return detail(db, slug)
        if (!current && Number((await db.execute('SELECT COUNT(*) AS n FROM brain_pages')).rows[0].n) >= MAX_PAGES) throw new HttpError(413, 'Too many Brain pages.')
        const before = new Map(pageSections(current?.content ?? '').map(section => [section.heading, words(section.body)]))
        const unconfirmed = restoredSeed ? headings(fields.content) : [...new Set(pageSections(fields.content).filter(section => current?.unconfirmed.includes(section.heading) && before.get(section.heading) === words(section.body)).map(section => section.heading))]
        const page: PageFile = { slug, ...fields, hash, updatedAt: new Date().toISOString(), updatedBy: author, unconfirmed }
        const body = matter.stringify(`\n${page.content}\n`, { title: page.title, type: page.type, updatedAt: page.updatedAt, updatedBy: page.updatedBy, sources: page.sources, unconfirmed })
        await index(db, page)
        const last = (await db.execute({ sql: 'SELECT id, author, proposal_id, created_at FROM brain_revisions WHERE slug = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', args: [slug] })).rows[0]
        if (current && !separateRevision && last && last.proposal_id == null && String(last.author) === page.updatedBy && Date.parse(page.updatedAt) - Date.parse(String(last.created_at)) < 10 * 60_000) {
            await db.execute({ sql: 'UPDATE brain_revisions SET title = ?, content = ?, hash = ?, created_at = ? WHERE id = ?', args: [page.title, page.content, page.hash, page.updatedAt, String(last.id)] })
        } else {
            await db.execute({ sql: 'INSERT INTO brain_revisions(id, slug, title, content, hash, author, proposal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', args: [randomUUID(), slug, page.title, page.content, page.hash, page.updatedBy, proposalId, page.updatedAt] })
        }
        await stage(db, slug, body)
        return detail(db, slug)
    }
    const api = {
        initialize: () => withDesktopBrainPagesLock(directory, async () => {
            await assertDirectory()
            const database = await getDatabase()
            await database.executeMultiple(DESKTOP_BRAIN_STORE_DDL)
            await recoverPublications(database)
        }),
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
        savePage: (slug: string, input: unknown, requestId: string) => {
            const parsed = desktopBrainWriteSchema.parse(input)
            return mutate(requestId, ['save', slugOf(slug), parsed], db => save(db, slug, parsed))
        },
        deletePage: (slug: string, expectedHash: string, requestId: string) => {
            desktopBrainHashSchema.parse(expectedHash)
            return mutate(requestId, ['delete', slugOf(slug), expectedHash], async db => {
                const raw = await rawPage(slug)
                if (raw === null) throw notFound('page')
                if (parsePage(slug, raw).hash !== expectedHash) throw conflict()
                await unindex(db, slug)
                await stage(db, slug, null)
                return { ok: true as const }
            })
        },
        listRevisions: (slug: string) => run(false, db => revisions(db, slug)),
        readRevision: (slug: string, id: string) => run(false, db => revision(db, slug, id)),
        restorePage: (slug: string, id: string, expectedHash: string, requestId: string) => {
            desktopBrainHashSchema.parse(expectedHash)
            return mutate(requestId, ['restore', slugOf(slug), id, expectedHash], async db => {
                const current = await readPage(slug)
                if (!current) throw notFound('page')
                if (current.hash !== expectedHash) throw conflict()
                const found = await revision(db, slug, id)
                return save(db, slug, { title: found.revision.title, type: current.type, content: found.content, sources: current.sources, baseHash: expectedHash }, true, found.revision.author === 'seed')
            })
        },
        confirmSections: (slug: string, sections: string[] | null, expectedHash: string, requestId: string) => {
            desktopBrainHashSchema.parse(expectedHash)
            return mutate(requestId, ['confirm', slugOf(slug), sections, expectedHash], async db => {
                const raw = await rawPage(slug)
                if (raw === null) throw notFound('page')
                const page = parsePage(slug, raw)
                if (page.hash !== expectedHash) throw conflict()
                page.unconfirmed = sections === null ? [] : page.unconfirmed.filter(heading => !sections.includes(heading))
                await stage(db, slug, matter.stringify(`\n${page.content}\n`, { title: page.title, type: page.type, updatedAt: page.updatedAt, updatedBy: page.updatedBy, sources: page.sources, unconfirmed: page.unconfirmed }))
                return detail(db, slug)
            })
        },
        listProposals: (status: BrainProposalStatus = 'proposed') => run(false, async db => {
            const rows = (await db.execute({ sql: 'SELECT * FROM brain_proposals WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT 101', args: [status] })).rows
            if (rows.length > 100) throw new HttpError(413, 'Too many Brain proposals. Review the current changes first.')
            return Promise.all(rows.map(row => proposalView(row)))
        }),
        countProposals: () => run(false, async db => Number((await db.execute("SELECT COUNT(*) AS n FROM brain_proposals WHERE status = 'proposed'")).rows[0].n)),
        propose: (rawInput: DesktopBrainProposalDraft, access?: DesktopBrainAccess) => run(true, async db => {
            const input = desktopBrainProposalDraftSchema.parse(rawInput)
            access?.signal?.throwIfAborted()
            const current = await readPage(input.slug)
            if ((current?.hash ?? null) !== input.baseHash) throw conflict()
            const fingerprint = desktopBrainProposalFingerprint(input)
            const duplicate = (await db.execute({ sql: 'SELECT * FROM brain_proposals WHERE fingerprint = ? LIMIT 1', args: [fingerprint] })).rows[0]
            if (duplicate) return { status: 'duplicate' as const, proposal: await proposalView(duplicate) }
            const open = (await db.execute({ sql: "SELECT id FROM brain_proposals WHERE status = 'proposed' AND agent_id = ? AND slug = ? LIMIT 1", args: [input.agentId, input.slug] })).rows[0]
            if (!open && Number((await db.execute("SELECT COUNT(*) AS n FROM brain_proposals WHERE status = 'proposed'")).rows[0].n) >= 100) throw new HttpError(413, 'Review the pending Brain proposals before adding more.')
            const id = open ? String(open.id) : randomUUID()
            await access?.beforeCommit?.()
            access?.signal?.throwIfAborted()
            await db.execute({ sql: `INSERT INTO brain_proposals(id, agent_id, agent_name, session_id, slug, mode, title, headline, highlights_json, type, content, reason, sources_json, base_hash, fingerprint, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
                ON CONFLICT(id) DO UPDATE SET agent_name = excluded.agent_name, session_id = excluded.session_id, title = excluded.title, headline = excluded.headline, highlights_json = excluded.highlights_json, type = excluded.type, content = excluded.content, reason = excluded.reason, sources_json = excluded.sources_json, base_hash = excluded.base_hash, mode = excluded.mode, fingerprint = excluded.fingerprint`,
                args: [id, input.agentId, input.agentName, input.sessionId, input.slug, current ? 'edit' : 'create', input.title, input.headline, JSON.stringify(input.highlights), input.type, input.content, input.reason, JSON.stringify(input.sources), input.baseHash, fingerprint, new Date().toISOString()] })
            const row = (await db.execute({ sql: 'SELECT * FROM brain_proposals WHERE id = ?', args: [id] })).rows[0]
            return { status: open ? 'updated' as const : 'proposed' as const, proposal: await proposalView(row) }
        }, access),
        decideProposal: (id: string, decision: 'accept' | 'dismiss', rawInput: DesktopBrainDecisionInput): Promise<DesktopBrainDecision> => {
            const input = desktopBrainDecisionSchema.parse(rawInput)
            return mutate(input.requestId, ['decision', id, decision, input], async db => {
                const row = (await db.execute({ sql: 'SELECT * FROM brain_proposals WHERE id = ?', args: [id] })).rows[0]
                if (!row) throw notFound('proposal')
                const proposal = await proposalView(row)
                if (proposal.status !== 'proposed' || proposal.reviewedFingerprint !== input.reviewedFingerprint) throw new HttpError(409, 'This proposal changed. Review its current version before deciding.')
                if (proposal.expectedPageHash !== input.expectedPageHash) throw conflict()
                if (decision === 'accept') {
                    // A stale proposal must first be rebased by its coworker. Reviewing a new
                    // current hash alone is not permission to overwrite facts the proposal missed.
                    if (proposal.baseHash !== input.expectedPageHash) throw conflict()
                    await save(db, proposal.slug, { title: input.edits?.title ?? proposal.title, type: input.edits?.type ?? proposal.type, content: input.edits?.content ?? proposal.content, sources: proposal.sources, baseHash: input.expectedPageHash }, true, false, proposal.id, `agent:${proposal.agentName}`.slice(0, 120))
                }
                await db.execute({ sql: 'UPDATE brain_proposals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?', args: [decision === 'accept' ? 'accepted' : 'dismissed', new Date().toISOString(), DESKTOP_BRAIN_AUTHOR, id] })
                const decided = (await db.execute({ sql: 'SELECT * FROM brain_proposals WHERE id = ?', args: [id] })).rows[0]
                return { proposal: await proposalView(decided), applied: decision === 'accept', slug: proposal.slug, requestId: input.requestId }
            })
        },
        search: (query: string, limit = 5): Promise<DesktopBrainSearchResult> => run(false, async db => {
            const terms = desktopBrainTerms(query)
            if (!terms.length) return { hits: [], related: [] }
            const match = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')
            const rows = (await db.execute({ sql: 'SELECT c.slug, c.heading, c.content, p.title, p.type, bm25(brain_chunks_fts) AS score FROM brain_chunks_fts JOIN brain_chunks c ON c.id = brain_chunks_fts.chunk_id JOIN brain_pages p ON p.slug = c.slug WHERE brain_chunks_fts MATCH ? ORDER BY score LIMIT 100', args: [match] })).rows
            const hits: DesktopBrainSearchResult['hits'] = []
            for (const row of rows) {
                const slug = String(row.slug)
                let hit = hits.find(item => item.slug === slug)
                if (!hit) { if (hits.length >= Math.max(1, Math.min(limit, 10))) continue; hit = { slug, title: String(row.title), type: brainPageTypeSchema.parse(row.type), score: Number(row.score), passages: [] }; hits.push(hit) }
                if (hit.passages.length < 2) hit.passages.push({ heading: String(row.heading), content: String(row.content) })
            }
            const related = new Map<string, { slug: string; title: string }>()
            for (const hit of hits) {
                const page = await detail(db, hit.slug)
                for (const slug of page.page.links) {
                    if (hits.some(item => item.slug === slug) || related.size >= 8) continue
                    const linked = await readPage(slug)
                    if (linked) related.set(slug, { slug, title: linked.title })
                }
            }
            return { hits, related: [...related.values()] }
        }),
    }
    async function proposalView(row: Record<string, unknown>): Promise<DesktopBrainProposalView> {
        const input: DesktopBrainProposalDraft = {
            agentId: String(row.agent_id), agentName: String(row.agent_name), sessionId: String(row.session_id), slug: String(row.slug),
            title: String(row.title), headline: row.headline == null ? '' : String(row.headline), highlights: JSON.parse(String(row.highlights_json ?? '[]')),
            type: brainPageTypeSchema.parse(row.type), content: String(row.content), reason: String(row.reason), sources: JSON.parse(String(row.sources_json)), baseHash: row.base_hash == null ? null : String(row.base_hash),
        }
        const current = await readPage(input.slug)
        return { ...input, id: String(row.id), mode: row.mode === 'edit' ? 'edit' : 'create', status: row.status as BrainProposalStatus,
            headline: input.headline || null, outdated: (current?.hash ?? null) !== input.baseHash, currentContent: current?.content ?? null,
            createdAt: String(row.created_at), decidedAt: row.decided_at == null ? null : String(row.decided_at), decidedBy: row.decided_by == null ? null : String(row.decided_by),
            reviewedFingerprint: desktopBrainProposalFingerprint(input), expectedPageHash: current?.hash ?? null }
    }
    return api
}

export const DESKTOP_BRAIN_STORE_DDL = `
CREATE TABLE IF NOT EXISTS desktop_brain_publications (slug TEXT PRIMARY KEY, raw TEXT);
CREATE TABLE IF NOT EXISTS desktop_brain_receipts (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
`
