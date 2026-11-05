import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import {
    BRAIN_SLUG_RE,
    brainPageTypeSchema,
    type BrainPageRef,
    type BrainPageType,
    type BrainProposal,
    type BrainProposalHighlight,
    type BrainProposalStatus,
} from '@rerun/contracts'
import matter from 'gray-matter'
import { textHash } from '../brain/chunks.js'
import { parseLinks } from '../brain/links.js'
import { newId, nowIso } from '../lib/ids.js'

// Desktop company-brain proposals. Original review and tool behavior:
// apps/engine/src/brain/proposals.ts, apps/engine/src/brain/search.ts,
// apps/engine/src/tools/builtin/brain.ts at a6d63a4.
// Differences: proposals live beside the page folder, not in the hosted brain database.
// Accept and dismiss record a decision and never call writePage. Keyword search reads the
// markdown pages and does not call embedText or /api/embed. The caller passes the engine
// data directory it already resolved. Tool arguments cannot choose it.

const O_NOFOLLOW_ANY = 0x20000000
const PROPOSAL_ID = /^[a-z0-9]{21}$/
const LIST_LIMIT = 100
const SEARCH_PAGE_LIMIT = 2000
const PASSAGES_PER_PAGE = 2
const MAX_RELATED = 8
const DECIDED_BY = 'user:desktop'

export class DesktopBrainProposalError extends Error {
    constructor(readonly status: number, message: string) {
        super(message)
        this.name = 'DesktopBrainProposalError'
    }
}

export type DesktopBrainPageFile = {
    slug: string
    title: string
    type: BrainPageType
    content: string
    hash: string
    sources: string[]
    updatedAt: string
    updatedBy: string
    unconfirmed: string[]
}

export type DesktopBrainPassage = { heading: string; content: string }
export type DesktopBrainHit = { slug: string; title: string; type: BrainPageType; passages: DesktopBrainPassage[]; score: number }
export type DesktopBrainSearchResult = { hits: DesktopBrainHit[]; related: BrainPageRef[] }

export type DesktopBrainAcceptedPageWrite = {
    slug: string
    title: string
    type: BrainPageType
    content: string
    sources: string[]
    baseHash: string | null
    author: string
    proposalId: string
    force: false
}

export type DesktopBrainDecision = {
    proposal: BrainProposal
    applied: false
    conflict: boolean
    unchanged: boolean
    pageWrite: DesktopBrainAcceptedPageWrite | null
}

type StoredHighlight = BrainProposalHighlight
type StoredProposal = {
    id: string
    agentId: string
    agentName: string
    sessionId: string
    slug: string
    mode: 'create' | 'edit'
    title: string
    headline: string | null
    highlights: StoredHighlight[]
    type: BrainPageType
    content: string
    reason: string
    sources: string[]
    baseHash: string | null
    fingerprint: string
    status: BrainProposalStatus
    createdAt: string
    decidedAt: string | null
    decidedBy: string | null
    accepted: DesktopBrainAcceptedPageWrite | null
}

export type DesktopBrainProposalDraft = Omit<StoredProposal, 'id' | 'status' | 'createdAt' | 'decidedAt' | 'decidedBy' | 'accepted'>

export type DesktopBrainAccess = { signal?: AbortSignal; beforeCommit?: () => Promise<void> | void }

const outside = () => new DesktopBrainProposalError(400, 'That path is outside the company brain.')
const notReady = () => new DesktopBrainProposalError(404, 'The company brain is not ready.')
const unreadable = () => new DesktopBrainProposalError(500, 'The company brain could not be read.')
const proposalUnreadable = () => new DesktopBrainProposalError(500, 'A proposal could not be read.')

function throwIfAborted(signal?: AbortSignal) {
    signal?.throwIfAborted()
}

function currentUid(): bigint {
    if (typeof process.getuid !== 'function') throw new DesktopBrainProposalError(400, 'Company brain is only available on this Mac.')
    return BigInt(process.getuid())
}

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
}

function rethrow(error: unknown): never {
    if (isAbort(error) || error instanceof DesktopBrainProposalError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw notReady()
    if (code === 'ELOOP' || code === 'EACCES' || code === 'EPERM') throw outside()
    // A grant or deletion check has no filesystem code. Keep that error; hide other I/O failures.
    if (code) throw unreadable()
    throw error
}

export function desktopBrainPageHash(page: { title: string; type: string; content: string }): string {
    return textHash(`${page.title.trim()}\n${page.type}\n${page.content.trim()}`)
}

// Same identity as apps/engine/src/brain/proposals.ts proposalFingerprint.
export function desktopBrainProposalFingerprint(input: { slug: string; content: string }): string {
    const normalized = input.content.toLowerCase().normalize('NFKD').replace(/\s+/g, ' ').trim()
    return createHash('sha256').update(`${input.slug}|${normalized}`).digest('hex').slice(0, 32)
}

// Same term split as toMatchQuery, without the hosted FTS quotes.
export function desktopBrainTerms(query: string): string[] {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
    return [...new Set(terms.filter(term => term.length > 1))]
}

export function desktopBrainPagesDirectory(engineDataDir: string): string {
    return join(engineDataDir, 'brain')
}

export function desktopBrainProposalsDirectory(engineDataDir: string): string {
    return join(engineDataDir, 'brain-proposals')
}

export async function resolveDesktopBrainEngineDirectory(engineDataDir: string, signal?: AbortSignal): Promise<string> {
    try {
        throwIfAborted(signal)
        if (!isAbsolute(engineDataDir)) throw outside()
        const engine = await realpath(engineDataDir)
        const info = await lstat(engine, { bigint: true })
        if (info.isSymbolicLink() || !info.isDirectory()) throw outside()
        if (info.uid !== currentUid()) throw new DesktopBrainProposalError(403, 'This company brain belongs to another user. It was left unopened.')
        return engine
    } catch (error) { rethrow(error) }
}

export async function resolveDesktopBrainEngineFromDataRoot(dataRoot: string, signal?: AbortSignal): Promise<string> {
    try {
        throwIfAborted(signal)
        if (!isAbsolute(dataRoot)) throw outside()
        const root = await realpath(dataRoot)
        return await resolveDesktopBrainEngineDirectory(join(root, 'workspaces', '1', 'engine'), signal)
    } catch (error) { rethrow(error) }
}

function contained(root: string, target: string) {
    const rel = relative(root, target)
    if (rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) return
    throw outside()
}

async function directoryOrNull(path: string, signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal)
    const info = await lstat(path, { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    })
    if (!info) return false
    if (info.isSymbolicLink() || !info.isDirectory()) throw outside()
    if (info.uid !== currentUid()) throw new DesktopBrainProposalError(403, 'This company brain belongs to another user. It was left unopened.')
    if (await realpath(path) !== path) throw outside()
    return true
}

function asString(value: unknown): string | null {
    if (typeof value === 'string') return value
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
    return null
}

function sectionHeadings(content: string): string[] {
    return [...new Set([...content.matchAll(/^#{2,3}\s+(.+?)\s*#*\s*$/gm)].map(match => match[1].trim()))]
}

function parsePage(slug: string, raw: string): DesktopBrainPageFile {
    const parsed = matter(raw)
    const data = parsed.data as Record<string, unknown>
    const type = brainPageTypeSchema.safeParse(data.type)
    const content = parsed.content.trim()
    const updatedBy = asString(data.updatedBy) ?? 'user'
    const headings = sectionHeadings(content)
    const unconfirmed = Array.isArray(data.unconfirmed)
        ? data.unconfirmed.map(String).filter(heading => headings.includes(heading))
        : updatedBy === 'seed' ? headings : []
    const page = {
        slug,
        title: asString(data.title)?.trim() || slug,
        type: type.success ? type.data : 'note' as const,
        content,
        sources: Array.isArray(data.sources) ? data.sources.map(String) : [],
        updatedAt: asString(data.updatedAt) ?? '',
        updatedBy,
        unconfirmed,
    }
    return { ...page, hash: desktopBrainPageHash(page) }
}

async function readPageAt(engine: string, slug: string, signal?: AbortSignal): Promise<DesktopBrainPageFile | null> {
    throwIfAborted(signal)
    if (!BRAIN_SLUG_RE.test(slug)) return null
    const dir = desktopBrainPagesDirectory(engine)
    if (!(await directoryOrNull(dir, signal))) return null
    const path = join(dir, `${slug}.md`)
    contained(dir, path)
    const info = await lstat(path, { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    })
    if (!info) return null
    if (info.isSymbolicLink() || !info.isFile()) throw outside()
    if (info.uid !== currentUid()) throw new DesktopBrainProposalError(403, 'This company brain belongs to another user. It was left unopened.')
    return parsePage(slug, await readFile(path, 'utf8'))
}

export async function readDesktopBrainPage(engineDataDir: string, slug: string, signal?: AbortSignal): Promise<DesktopBrainPageFile | null> {
    try { return await readPageAt(await resolveDesktopBrainEngineDirectory(engineDataDir, signal), slug, signal) }
    catch (error) { rethrow(error) }
}

export async function listDesktopBrainPages(engineDataDir: string, signal?: AbortSignal): Promise<DesktopBrainPageFile[]> {
    try {
        const engine = await resolveDesktopBrainEngineDirectory(engineDataDir, signal)
        const dir = desktopBrainPagesDirectory(engine)
        if (!(await directoryOrNull(dir, signal))) return []
        const entries = await readdir(dir, { withFileTypes: true })
        if (entries.length > SEARCH_PAGE_LIMIT) throw new DesktopBrainProposalError(413, 'The company brain is too large to search this way.')
        const pages: DesktopBrainPageFile[] = []
        for (const entry of entries) {
            throwIfAborted(signal)
            if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.md')) continue
            const slug = entry.name.slice(0, -3)
            const page = await readPageAt(engine, slug, signal)
            if (page) pages.push(page)
        }
        return pages
    } catch (error) { rethrow(error) }
}

function countTerm(haystack: string, term: string): number {
    let count = 0
    let from = 0
    while (from <= haystack.length) {
        const found = haystack.indexOf(term, from)
        if (found < 0) break
        count += 1
        from = found + term.length
    }
    return count
}

export async function searchDesktopBrain(engineDataDir: string, query: string, limit = 5, signal?: AbortSignal): Promise<DesktopBrainSearchResult> {
    const terms = desktopBrainTerms(query)
    if (!terms.length || limit < 1) return { hits: [], related: [] }
    const pages = await listDesktopBrainPages(engineDataDir, signal)
    const ranked = pages.flatMap(page => {
        const title = page.title.toLowerCase()
        const slug = page.slug.toLowerCase()
        const content = page.content.toLowerCase()
        let score = 0
        for (const term of terms) {
            score += countTerm(title, term) * 5 + countTerm(slug, term) * 3 + countTerm(content, term)
        }
        if (score <= 0) return []
        const passages = sectionHeadings(page.content).length || page.content
            ? page.content.split(/\n(?=#{2,3}\s+)/).map(block => {
                const headingMatch = /^#{2,3}\s+(.+?)\s*#*\s*$/m.exec(block)
                const heading = headingMatch?.[1]?.trim() || 'Overview'
                const body = block.replace(/^#{2,3}\s+.*$/m, '').trim()
                const text = `${heading}\n${body}`.toLowerCase()
                const passageScore = terms.reduce((sum, term) => sum + countTerm(text, term), 0)
                return { heading, content: body || block.trim(), score: passageScore }
            }).filter(passage => passage.content).sort((a, b) => b.score - a.score).slice(0, PASSAGES_PER_PAGE)
            : []
        return [{ slug: page.slug, title: page.title, type: page.type, score, passages: passages.map(({ heading, content }) => ({ heading, content })) }]
    }).sort((a, b) => b.score - a.score).slice(0, limit)

    const selected = new Set(ranked.map(hit => hit.slug))
    const related = new Map<string, string>()
    for (const page of pages) {
        const targets = parseLinks(page.content, page.slug)
        const pageSelected = selected.has(page.slug)
        for (const target of targets) {
            if (selected.has(target)) {
                if (!pageSelected && !related.has(page.slug)) related.set(page.slug, page.title)
            } else if (pageSelected) {
                const linked = pages.find(candidate => candidate.slug === target)
                if (linked && !related.has(linked.slug)) related.set(linked.slug, linked.title)
            }
        }
    }
    return {
        hits: ranked,
        related: [...related.entries()].sort((a, b) => a[1].localeCompare(b[1])).slice(0, MAX_RELATED).map(([slug, title]) => ({ slug, title })),
    }
}

async function proposalsDir(engine: string, create: boolean, signal?: AbortSignal): Promise<string | null> {
    const dir = desktopBrainProposalsDirectory(engine)
    contained(engine, dir)
    const present = await directoryOrNull(dir, signal)
    if (!present && !create) return null
    if (!present) {
        await mkdir(dir, { mode: 0o755 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
        if (!(await directoryOrNull(dir, signal))) throw outside()
    }
    return dir
}

function parseStored(raw: string, id: string): StoredProposal {
    const value = JSON.parse(raw) as Partial<StoredProposal>
    if (value.id !== id || !PROPOSAL_ID.test(id) || !BRAIN_SLUG_RE.test(String(value.slug))) throw proposalUnreadable()
    const type = brainPageTypeSchema.safeParse(value.type)
    if (!type.success || (value.mode !== 'create' && value.mode !== 'edit')) throw proposalUnreadable()
    if (value.status !== 'proposed' && value.status !== 'accepted' && value.status !== 'dismissed') throw proposalUnreadable()
    if (typeof value.content !== 'string' || typeof value.title !== 'string' || typeof value.fingerprint !== 'string') throw proposalUnreadable()
    return {
        id,
        agentId: String(value.agentId),
        agentName: String(value.agentName),
        sessionId: String(value.sessionId),
        slug: String(value.slug),
        mode: value.mode,
        title: value.title,
        headline: value.headline == null ? null : String(value.headline),
        highlights: Array.isArray(value.highlights) ? value.highlights : [],
        type: type.data,
        content: value.content,
        reason: String(value.reason ?? ''),
        sources: Array.isArray(value.sources) ? value.sources.map(String) : [],
        baseHash: value.baseHash == null ? null : String(value.baseHash),
        fingerprint: value.fingerprint,
        status: value.status,
        createdAt: String(value.createdAt),
        decidedAt: value.decidedAt == null ? null : String(value.decidedAt),
        decidedBy: value.decidedBy == null ? null : String(value.decidedBy),
        accepted: value.accepted ?? null,
    }
}

async function readStored(dir: string, id: string, signal?: AbortSignal): Promise<StoredProposal | null> {
    throwIfAborted(signal)
    if (!PROPOSAL_ID.test(id)) throw new DesktopBrainProposalError(400, 'That proposal was not found.')
    const path = join(dir, `${id}.json`)
    contained(dir, path)
    const info = await lstat(path, { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    })
    if (!info) return null
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n || info.uid !== currentUid()) throw outside()
    try { return parseStored(await readFile(path, 'utf8'), id) }
    catch (error) {
        if (error instanceof DesktopBrainProposalError) throw error
        throw proposalUnreadable()
    }
}

const followFlags = () => (process.platform === 'darwin' ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW)

async function writeStored(dir: string, row: StoredProposal, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const dest = join(dir, `${row.id}.json`)
    contained(dir, dest)
    const existing = await lstat(dest, { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    })
    if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.uid !== currentUid())) throw outside()
    const tmp = join(dir, `.${row.id}.${randomBytes(6).toString('hex')}.tmp`)
    contained(dir, tmp)
    if (process.platform !== 'darwin' && process.platform !== 'linux') throw new DesktopBrainProposalError(400, 'Company brain is only available on this Mac.')
    const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | followFlags(), 0o600)
    try {
        await handle.writeFile(JSON.stringify(row))
        await handle.sync()
    } finally { await handle.close() }
    try { await rename(tmp, dest) }
    finally { await unlink(tmp).catch(() => {}) }
}

async function withLock<T>(dir: string, id: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    const lock = join(dir, `.${id}.lock`)
    contained(dir, lock)
    let handle
    try { handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | followFlags(), 0o600) }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DesktopBrainProposalError(409, 'This proposal is being decided. Try again.')
        throw error
    }
    await handle.close()
    try {
        throwIfAborted(signal)
        return await action()
    } finally { await unlink(lock).catch(() => {}) }
}

async function eachStored(engine: string, signal?: AbortSignal): Promise<StoredProposal[]> {
    const dir = await proposalsDir(engine, false, signal)
    if (!dir) return []
    const names = (await readdir(dir)).filter(name => name.endsWith('.json') && !name.startsWith('.'))
    const rows: StoredProposal[] = []
    for (const name of names) {
        throwIfAborted(signal)
        const row = await readStored(dir, basename(name, '.json'), signal)
        if (row) rows.push(row)
    }
    return rows
}

function toProposal(row: StoredProposal, current: DesktopBrainPageFile | null): BrainProposal {
    const outdated = row.status === 'proposed' && (row.mode === 'edit' ? current?.hash !== row.baseHash : current !== null)
    return {
        id: row.id,
        agentId: row.agentId,
        agentName: row.agentName,
        sessionId: row.sessionId,
        slug: row.slug,
        mode: row.mode,
        title: row.title,
        headline: row.headline,
        highlights: row.highlights,
        type: row.type,
        content: row.content,
        reason: row.reason,
        sources: row.sources,
        baseHash: row.baseHash,
        status: row.status,
        outdated,
        currentContent: current?.content ?? null,
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
        decidedBy: row.decidedBy,
    }
}

async function withCurrent(engine: string, row: StoredProposal, signal?: AbortSignal): Promise<BrainProposal> {
    return toProposal(row, await readPageAt(engine, row.slug, signal))
}

export async function listDesktopBrainProposals(engineDataDir: string, status?: BrainProposalStatus, signal?: AbortSignal): Promise<BrainProposal[]> {
    try {
        const engine = await resolveDesktopBrainEngineDirectory(engineDataDir, signal)
        const rows = (await eachStored(engine, signal))
            .filter(row => !status || row.status === status)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, LIST_LIMIT)
        const current = new Map<string, DesktopBrainPageFile | null>()
        const proposals: BrainProposal[] = []
        for (const row of rows) {
            if (!current.has(row.slug)) current.set(row.slug, await readPageAt(engine, row.slug, signal))
            proposals.push(toProposal(row, current.get(row.slug) ?? null))
        }
        return proposals
    } catch (error) { rethrow(error) }
}

export async function countDesktopBrainProposals(engineDataDir: string, signal?: AbortSignal): Promise<number> {
    try {
        const engine = await resolveDesktopBrainEngineDirectory(engineDataDir, signal)
        return (await eachStored(engine, signal)).filter(row => row.status === 'proposed').length
    } catch (error) { rethrow(error) }
}

export async function findDesktopBrainProposalByFingerprint(engineDataDir: string, fingerprint: string, signal?: AbortSignal): Promise<StoredProposal | null> {
    const engine = await resolveDesktopBrainEngineDirectory(engineDataDir, signal)
    return (await eachStored(engine, signal)).find(row => row.fingerprint === fingerprint) ?? null
}

export async function openDesktopBrainProposalFor(engineDataDir: string, agentId: string, slug: string, signal?: AbortSignal): Promise<StoredProposal | null> {
    const engine = await resolveDesktopBrainEngineDirectory(engineDataDir, signal)
    return (await eachStored(engine, signal))
        .filter(row => row.agentId === agentId && row.slug === slug && row.status === 'proposed')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
}

async function commit(access?: DesktopBrainAccess) {
    throwIfAborted(access?.signal)
    await access?.beforeCommit?.()
    throwIfAborted(access?.signal)
}

export async function insertDesktopBrainProposal(engineDataDir: string, input: DesktopBrainProposalDraft, access?: DesktopBrainAccess): Promise<StoredProposal> {
    try {
        await commit(access)
        const engine = await resolveDesktopBrainEngineDirectory(engineDataDir, access?.signal)
        const dir = await proposalsDir(engine, true, access?.signal)
        if (!dir) throw notReady()
        const row: StoredProposal = { ...input, id: newId(), status: 'proposed', createdAt: nowIso(), decidedAt: null, decidedBy: null, accepted: null }
        await commit(access)
        await writeStored(dir, row, access?.signal)
        return row
    } catch (error) { rethrow(error) }
}

export async function replaceDesktopBrainProposal(engineDataDir: string, id: string, input: DesktopBrainProposalDraft, access?: DesktopBrainAccess): Promise<void> {
    try {
        await commit(access)
        const engine = await resolveDesktopBrainEngineDirectory(engineDataDir, access?.signal)
        const dir = await proposalsDir(engine, false, access?.signal)
        if (!dir) throw new DesktopBrainProposalError(404, 'Proposal not found.')
        await withLock(dir, id, access?.signal, async () => {
            const current = await readStored(dir, id, access?.signal)
            if (!current || current.status !== 'proposed') throw new DesktopBrainProposalError(404, 'Proposal not found.')
            await commit(access)
            await writeStored(dir, {
                ...current,
                ...input,
                id: current.id,
                status: 'proposed',
                createdAt: nowIso(),
                decidedAt: null,
                decidedBy: null,
                accepted: null,
            }, access?.signal)
        })
    } catch (error) { rethrow(error) }
}

function pageWriteOf(row: StoredProposal): DesktopBrainAcceptedPageWrite | null {
    if (row.status !== 'accepted' || !row.accepted) return null
    return { ...row.accepted, force: false }
}

export async function decideDesktopBrainProposal(
    engineDataDir: string,
    id: string,
    decision: 'accept' | 'dismiss',
    edits: { title?: string; type?: BrainPageType; content?: string } = {},
    access?: DesktopBrainAccess,
): Promise<DesktopBrainDecision> {
    try {
        await commit(access)
        const engine = await resolveDesktopBrainEngineDirectory(engineDataDir, access?.signal)
        const dir = await proposalsDir(engine, false, access?.signal)
        if (!dir) throw new DesktopBrainProposalError(404, 'Proposal not found.')
        return await withLock(dir, id, access?.signal, async () => {
            const row = await readStored(dir, id, access?.signal)
            if (!row) throw new DesktopBrainProposalError(404, 'Proposal not found.')
            const wanted = decision === 'accept' ? 'accepted' : 'dismissed'
            if (row.status === wanted) {
                return { proposal: await withCurrent(engine, row, access?.signal), applied: false, conflict: false, unchanged: true, pageWrite: pageWriteOf(row) }
            }
            if (row.status !== 'proposed') {
                throw new DesktopBrainProposalError(409, `This proposal was already ${row.status}. The page was not written.`)
            }
            const current = await readPageAt(engine, row.slug, access?.signal)
            const stale = row.mode === 'edit' ? current?.hash !== row.baseHash : current !== null
            if (decision === 'accept' && stale) {
                throw new DesktopBrainProposalError(409, 'The page changed since the coworker read it. The proposal is still waiting, and the page was not written.')
            }
            const accepted: DesktopBrainAcceptedPageWrite | null = decision === 'accept' ? {
                slug: row.slug,
                title: edits.title ?? row.title,
                type: edits.type ?? row.type,
                content: edits.content ?? row.content,
                sources: row.sources,
                baseHash: current?.hash ?? null,
                author: `agent:${row.agentName}`,
                proposalId: row.id,
                force: false,
            } : null
            const next: StoredProposal = {
                ...row,
                status: decision === 'accept' ? 'accepted' : 'dismissed',
                decidedAt: nowIso(),
                decidedBy: DECIDED_BY,
                accepted,
            }
            await commit(access)
            await writeStored(dir, next, access?.signal)
            const saved = await readStored(dir, id, access?.signal)
            if (!saved || saved.status !== next.status || saved.decidedAt !== next.decidedAt) throw proposalUnreadable()
            return { proposal: await withCurrent(engine, saved, access?.signal), applied: false, conflict: false, unchanged: false, pageWrite: pageWriteOf(saved) }
        })
    } catch (error) { rethrow(error) }
}
