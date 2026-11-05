import { constants } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseFrontmatter } from '../skills/frontmatter.js'
import { acquireSkillLease, renameSkillEntry } from './skill-publication-native.js'
import { SkillBoundaryError } from './skill-publication-error.js'
export { SkillBoundaryError } from './skill-publication-error.js'
import { connectorSkillReadOnlyError, MAX_SKILL_FILE_BYTES, MAX_SKILL_FOLDER_BYTES, MAX_SKILL_REFERENCE_FILES, TEXT_FILE_PAGE_CHARS } from '@rerun/contracts'

// One filesystem boundary for desktop skill reads and writes. The UI server and the desktop
// skill tools both call this module. A process-local lock is not the boundary: every mutation
// is confined to a directory inode that was opened no-follow, and a publish either lands the
// new bytes or leaves the previous inode in place.
//
// Hosted skill routes keep using apps/engine/src/skills/loader.ts. This module does not patch
// that loader. The hosted loader removes a skill directory before renaming a staging folder
// over it; nothing here does that.

const O_NOFOLLOW_ANY = 0x20000000
const SKILL_SLUG = /^[a-z0-9-]{1,64}$/
const SERVICE_KEY = /^[a-z0-9][a-z0-9._-]{0,63}(?:@[a-z0-9]{6})?$/
const MANIFEST = 'SKILL.md'
const TEMP_PREFIX = '.rerun-skill-tmp-'
const BACKUP_PREFIX = '.rerun-skill-bak-'
const STAGE_PREFIX = '.rerun-skill-stage-'

export type ConfinedText = { content: string; truncated: boolean; identity: string }
export type SkillFilePayload = { path: string; content: string }
export type PublishedSkill = { slug: string; name: string; description: string; body: string; files: string[]; identity?: string }
export type SkillPublishHooks = {
    beforeDirectoryCreate?: () => Promise<void> | void
    beforeFilePublish?: () => Promise<void> | void
    beforeLeaseAcquire?: () => Promise<void> | void
    afterOriginalMoved?: () => Promise<void> | void
}

type Identity = { dev: bigint; ino: bigint }
type PinnedDir = { handle: FileHandle; pinned: string; path: string; identity: Identity; uid: bigint }

let hooks: SkillPublishHooks | null = null

/** Test-only. Production leaves this unset, so the hooks never run. */
export function setSkillPublishHooksForTests(next: SkillPublishHooks | null): void {
    hooks = next
}

const outside = () => new SkillBoundaryError(400, 'That path is outside this coworker’s skills or is not a file.')
const unreadableOwners = () => new SkillBoundaryError(400, 'Could not check which skills an app owns. Try again.')
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')
const isPlain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const same = (left: Identity | null, right: Identity | null) => !!left && !!right && left.dev === right.dev && left.ino === right.ino
const identityOf = (info: { dev: bigint; ino: bigint }) => ({ dev: info.dev, ino: info.ino })
const identityKey = (info: Identity) => `${info.dev}:${info.ino}`
type Version = Identity & { size: bigint; mtimeNs: bigint; ctimeNs: bigint; uid: bigint; nlink: bigint }
const versionKey = (info: Version) => `${identityKey(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.uid}:${info.nlink}`
const sameVersion = (a: Version, b: Version) => versionKey(a) === versionKey(b)
type PublishOptions = { beforeCommit?: () => Promise<void>; signal?: AbortSignal }
const MAX_TREE_DEPTH = 32

async function withPublication<T>(skillsRoot: string, options: PublishOptions, action: (root: PinnedDir, check: () => Promise<void>) => Promise<T>): Promise<T> {
    options.signal?.throwIfAborted()
    await options.beforeCommit?.()
    await ensureSkillsRoot(skillsRoot)
    const root = await openDirectory(skillsRoot)
    try {
        await hooks?.beforeLeaseAcquire?.()
        const lease = await acquireSkillLease(root.path, root.identity, options.signal)
        try {
            const check = async () => {
                lease.assertCurrent()
                await options.beforeCommit?.()
                lease.assertCurrent()
                await assertSame(root)
            }
            await check()
            await recoverSkillPublications(root, check)
            return await action(root, check)
        } finally { await lease.release() }
    } finally { await root.handle.close() }
}

function currentUid(): bigint {
    if (typeof process.getuid !== 'function') throw new SkillBoundaryError(400, 'Skill files can only be changed on this Mac.')
    return BigInt(process.getuid())
}

function relativeParts(path: string): string[] {
    if (path.length > 4096) throw outside()
    const parts = path.split('/').filter(part => part && part !== '.')
    if (parts.length > MAX_TREE_DEPTH) throw outside()
    if (isAbsolute(path) || path.includes('\0') || parts.includes('..') || parts.some(part => part.includes('\\'))) throw outside()
    return parts
}

function reserved(name: string): boolean {
    return name.startsWith(TEMP_PREFIX) || name.startsWith(BACKUP_PREFIX) || name.startsWith(STAGE_PREFIX) || name.startsWith('.rerun-skill-')
}

export function skillSlugOf(name: string): string {
    return name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

function assertSlug(slug: string): void {
    if (!SKILL_SLUG.test(slug)) throw new SkillBoundaryError(400, 'Invalid skill slug.')
}

// A services registry owns a skill only when the document has the expected shape. Arrays,
// booleans and unknown names are not "no owners".
export function ownersOfRegistryJson(content: string): Map<string, string> {
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch { throw unreadableOwners() }
    if (!isPlain(parsed) || !('services' in parsed) || !isPlain(parsed.services)) throw unreadableOwners()
    const owners = new Map<string, string>()
    for (const [key, entry] of Object.entries(parsed.services)) {
        if (!SERVICE_KEY.test(key)) throw unreadableOwners()
        if (!isPlain(entry)) throw unreadableOwners()
        if ('status' in entry && entry.status !== undefined && typeof entry.status !== 'string') throw unreadableOwners()
        if ('label' in entry && entry.label !== undefined && typeof entry.label !== 'string') throw unreadableOwners()
        if ('installedAt' in entry && entry.installedAt !== undefined && typeof entry.installedAt !== 'string') throw unreadableOwners()
        const skills = 'skills' in entry ? entry.skills : undefined
        if (skills !== undefined && (!Array.isArray(skills) || skills.some(slug => typeof slug !== 'string' || !SKILL_SLUG.test(slug)))) throw unreadableOwners()
        const at = key.lastIndexOf('@')
        const service = at > 0 && /^[a-z0-9]{6}$/.test(key.slice(at + 1)) ? key.slice(0, at) : key
        if (!service || service.includes('@')) throw unreadableOwners()
        for (const slug of (skills ?? []) as string[]) if (!owners.has(slug)) owners.set(slug, service)
    }
    return owners
}

function openFlags(directory: boolean, write = false): number {
    const base = (write ? constants.O_WRONLY : constants.O_RDONLY) | (directory ? constants.O_DIRECTORY : constants.O_NONBLOCK)
    return base | (process.platform === 'darwin' ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW)
}

async function openNoFollow(target: string, directory: boolean): Promise<FileHandle> {
    try {
        if (process.platform === 'darwin') return await open(target, openFlags(directory))
        let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY)
        try {
            const parts = target.split('/').filter(Boolean)
            for (const [index, part] of parts.entries()) {
                const last = index === parts.length - 1
                const next = await open(`/proc/self/fd/${handle.fd}/${part}`, constants.O_NOFOLLOW | (last ? openFlags(directory) : constants.O_RDONLY | constants.O_DIRECTORY))
                await handle.close()
                handle = next
            }
            return handle
        } catch (error) {
            await handle.close()
            throw error
        }
    } catch (error) {
        if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw outside()
        throw error
    }
}

async function pinnedDirectory(handle: FileHandle): Promise<string> {
    if (process.platform !== 'darwin') return `/proc/self/fd/${handle.fd}`
    const info = await handle.stat({ bigint: true })
    return `/.vol/${info.dev}/${info.ino}`
}

async function openPinned(pinned: string, name: string, flags: number, mode = 0o644): Promise<FileHandle> {
    try { return await open(join(pinned, name), flags, mode) }
    catch (error) {
        if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw outside()
        throw error
    }
}

async function statAt(path: string) {
    try { return await lstat(path, { bigint: true }) }
    catch (error) { if (missing(error)) return null; throw error }
}

async function openDirectory(absolute: string): Promise<PinnedDir> {
    const uid = currentUid()
    const listed = await statAt(absolute)
    if (!listed || listed.isSymbolicLink() || !listed.isDirectory()) throw listed ? outside() : new SkillBoundaryError(404, 'Skill not found.')
    if (listed.uid !== uid) throw new SkillBoundaryError(403, 'This skill belongs to another user. It was left unchanged.')
    const real = await realpath(absolute).catch(() => null)
    if (real !== absolute) throw outside()
    const handle = await openNoFollow(absolute, true)
    try {
        const opened = await handle.stat({ bigint: true })
        if (opened.uid !== uid || !opened.isDirectory() || opened.dev !== listed.dev || opened.ino !== listed.ino) throw outside()
        return { handle, pinned: await pinnedDirectory(handle), path: absolute, identity: identityOf(opened), uid }
    } catch (error) {
        await handle.close()
        throw error
    }
}

async function assertSame(dir: PinnedDir): Promise<void> {
    const [opened, listed, real] = await Promise.all([
        dir.handle.stat({ bigint: true }),
        statAt(dir.path),
        realpath(dir.path).catch(() => null),
    ])
    if (!listed || listed.isSymbolicLink() || !listed.isDirectory() || real !== dir.path || opened.uid !== dir.uid || listed.uid !== dir.uid || !same(identityOf(opened), dir.identity) || !same(identityOf(listed), dir.identity)) {
        throw outside()
    }
}

function completeUtf8End(bytes: Buffer): number {
    let index = bytes.length
    while (index > 0 && (bytes[index - 1]! & 0b11000000) === 0b10000000) index -= 1
    if (index === bytes.length) return bytes.length
    if (index === 0) return 0
    const lead = bytes[index - 1]!
    const need = lead >= 0b11110000 ? 4 : lead >= 0b11100000 ? 3 : lead >= 0b11000000 ? 2 : 1
    return bytes.length - (index - 1) < need ? index - 1 : bytes.length
}

// Truncation is true when unread bytes remain, a character was cut to the page, or a partial
// UTF-8 sequence could not be returned. Slicing the string without that flag let a 150,000
// character ASCII file look complete.
function decodeBounded(bytes: Buffer, fileSize: number, maxChars: number | null): { text: string; truncated: boolean } {
    const end = completeUtf8End(bytes)
    const whole = bytes.subarray(0, end)
    let text: string
    let invalid = false
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(whole) }
    catch { invalid = true; text = new TextDecoder('utf-8', { fatal: false }).decode(whole) }
    let truncated = fileSize > bytes.length || end < bytes.length || invalid
    if (maxChars !== null && text.length > maxChars) {
        text = text.slice(0, maxChars)
        truncated = true
    }
    return { text, truncated }
}

function incompleteEditorSave(size: bigint, content: string): boolean {
    const bytes = Buffer.byteLength(content, 'utf8')
    if (content.length >= TEXT_FILE_PAGE_CHARS && size > BigInt(bytes)) return true
    if (content.length <= TEXT_FILE_PAGE_CHARS && size > BigInt(TEXT_FILE_PAGE_CHARS * 4)) return true
    return false
}

async function readExact(handle: FileHandle, length: number): Promise<Buffer> {
    const bytes = Buffer.alloc(length)
    let got = 0
    while (got < length) {
        const read = await handle.read(bytes, got, length - got, got)
        if (!read.bytesRead) break
        got += read.bytesRead
    }
    if (got !== length) throw new SkillBoundaryError(409, 'This file changed while it was being read.')
    return bytes
}

async function readHandle(handle: FileHandle, limit: number, maxChars: number | null): Promise<ConfinedText> {
    const info = await handle.stat({ bigint: true })
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== BigInt(1) || info.uid !== currentUid()) throw outside()
    const fileSize = Number(info.size)
    if (!Number.isSafeInteger(fileSize)) throw new SkillBoundaryError(413, 'This file is too large to read here.')
    const toRead = Math.min(fileSize, limit)
    const bytes = await readExact(handle, toRead)
    const decoded = decodeBounded(bytes, fileSize, maxChars)
    const after = await handle.stat({ bigint: true })
    if (!sameVersion(info, after)) throw new SkillBoundaryError(409, 'This file changed while it was being read.')
    return { content: decoded.text, truncated: decoded.truncated, identity: `${versionKey(info)}:${decoded.truncated ? 'partial' : 'complete'}` }
}

export async function readConfinedFile(root: string, path: string, offset = 0, options: PublishOptions = {}): Promise<ConfinedText | null> {
    if (!await statAt(root)) return null
    return withPublication(dirname(root), options, () => readConfinedFileUnlocked(root, path, offset))
}

async function readConfinedFileUnlocked(root: string, path: string, offset = 0): Promise<ConfinedText | null> {
    const parts = relativeParts(path)
    if (parts.length === 0) throw new SkillBoundaryError(400, 'Choose a file to read.')
    let dir: PinnedDir
    try { dir = await openDirectory(root) }
    catch (error) { if (error instanceof SkillBoundaryError && error.status === 404) return null; throw error }
    try {
        let pinned = dir.pinned
        const owned: PinnedDir[] = []
        let currentPath = dir.path
        try {
            for (const [index, part] of parts.entries()) {
                const last = index === parts.length - 1
                const info = await statAt(join(pinned, part))
                if (!info) return null
                if (info.isSymbolicLink() || info.uid !== dir.uid) throw outside()
                if (last) {
                    if (!info.isFile() || info.nlink !== BigInt(1)) throw outside()
                    if (!Number.isInteger(offset) || offset < 0) throw new SkillBoundaryError(400, 'offset must be a non-negative integer.')
                    const byteLimit = (offset + TEXT_FILE_PAGE_CHARS) * 4
                    if (byteLimit > MAX_SKILL_FILE_BYTES) throw new SkillBoundaryError(413, 'This file is too large to read here.')
                    const file = await openPinned(pinned, part, openFlags(false))
                    try {
                        const openedInfo = await file.stat({ bigint: true })
                        if (!sameVersion(openedInfo, info)) throw outside()
                        const read = await readHandle(file, byteLimit, offset + TEXT_FILE_PAGE_CHARS)
                        const listedAfter = await statAt(join(pinned, part))
                        if (!listedAfter || !sameVersion(openedInfo, listedAfter)) throw new SkillBoundaryError(409, 'This file changed while it was being read.')
                        await assertSame(dir)
                        for (const parent of owned) await assertSame(parent)
                        if (await realpath(join(root, ...parts.slice(0, -1))) !== join(root, ...parts.slice(0, -1))) throw outside()
                        return { content: read.content.slice(offset, offset + TEXT_FILE_PAGE_CHARS), truncated: read.truncated, identity: read.identity }
                    } finally { await file.close() }
                }
                if (!info.isDirectory()) throw outside()
                const next = await openPinned(pinned, part, openFlags(true))
                const opened = await next.stat({ bigint: true })
                if (!same(identityOf(opened), identityOf(info)) || opened.uid !== dir.uid) { await next.close(); throw outside() }
                currentPath = join(currentPath, part)
                pinned = await pinnedDirectory(next)
                owned.push({ handle: next, pinned, path: currentPath, identity: identityOf(opened), uid: dir.uid })
            }
            return null
        } finally {
            await Promise.all(owned.map(item => item.handle.close()))
        }
    } finally {
        await dir.handle.close()
    }
}

async function ensureChildDirectory(parent: PinnedDir, parentPinned: string, parentPath: string, name: string): Promise<PinnedDir> {
    if (reserved(name) || name === '.' || name === '..') throw outside()
    const path = join(parentPath, name)
    const existing = await statAt(join(parentPinned, name))
    if (existing) {
        if (existing.isSymbolicLink() || !existing.isDirectory() || existing.uid !== parent.uid) throw outside()
        const handle = await openPinned(parentPinned, name, openFlags(true))
        const opened = await handle.stat({ bigint: true })
        if (!same(identityOf(opened), identityOf(existing))) { await handle.close(); throw outside() }
        return { handle, pinned: await pinnedDirectory(handle), path, identity: identityOf(opened), uid: parent.uid }
    }
    await hooks?.beforeDirectoryCreate?.()
    await assertSame(parent)
    const parentNow = await parent.handle.stat({ bigint: true })
    if (!same(identityOf(parentNow), parent.identity)) throw outside()
    await mkdir(join(parentPinned, name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    const created = await statAt(join(parentPinned, name))
    if (!created || created.isSymbolicLink() || !created.isDirectory() || created.uid !== parent.uid) throw outside()
    const listed = await statAt(path)
    if (!listed || !same(identityOf(listed), identityOf(created))) throw outside()
    const handle = await openPinned(parentPinned, name, openFlags(true))
    const opened = await handle.stat({ bigint: true })
    if (!same(identityOf(opened), identityOf(created))) { await handle.close(); throw outside() }
    return { handle, pinned: await pinnedDirectory(handle), path, identity: identityOf(opened), uid: parent.uid }
}

async function writeTemp(pinned: string, name: string, content: string, uid: bigint): Promise<Identity> {
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.byteLength > MAX_SKILL_FILE_BYTES) throw new SkillBoundaryError(413, 'A skill file can be at most 10 MB.')
    const handle = await openPinned(pinned, name, openFlags(false, true) | constants.O_CREAT | constants.O_EXCL, 0o644)
    try {
        const opened = await handle.stat({ bigint: true })
        const listed = await statAt(join(pinned, name))
        if (!listed || opened.uid !== uid || opened.nlink !== BigInt(1) || !same(identityOf(opened), identityOf(listed))) throw outside()
        await handle.writeFile(bytes)
        await handle.sync()
        return identityOf(opened)
    } finally {
        await handle.close()
    }
}

async function removeName(pinned: string, name: string, expected: Identity | null): Promise<void> {
    const info = await statAt(join(pinned, name))
    if (!info) return
    if (expected && !same(identityOf(info), expected)) return
    if (info.isDirectory()) return
    await unlink(join(pinned, name))
}

const JOURNAL_PREFIX = '.rerun-skill-journal-'
type JournalFile = { identity: string; hash: string }
type PublicationJournal = { version: 1; parent: string; parentIdentity: string; final: string; backup: string; temp: string; before: JournalFile; after: JournalFile }
const hashBytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const recordOf = (value: { info: Version; bytes: Buffer }): JournalFile => ({ identity: identityKey(value.info), hash: hashBytes(value.bytes) })
const matching = (value: { info: Version; bytes: Buffer } | null, expected: JournalFile) => value !== null && identityKey(value.info) === expected.identity && hashBytes(value.bytes) === expected.hash

async function readSnapshot(parent: PinnedDir, name: string): Promise<{ info: Version; bytes: Buffer } | null> {
    const listed = await statAt(join(parent.pinned, name))
    if (!listed) return null
    if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== BigInt(1) || listed.uid !== parent.uid) throw outside()
    if (listed.size > BigInt(MAX_SKILL_FILE_BYTES)) throw new SkillBoundaryError(413, 'A skill file can be at most 10 MB.')
    const file = await openPinned(parent.pinned, name, openFlags(false))
    try {
        const before = await file.stat({ bigint: true })
        if (!sameVersion(before, listed)) throw new SkillBoundaryError(409, 'This file changed. Reopen it before trying again.')
        const bytes = await readExact(file, Number(before.size))
        const after = await file.stat({ bigint: true })
        const final = await statAt(join(parent.pinned, name))
        if (!final || !sameVersion(before, after) || !sameVersion(before, final)) throw new SkillBoundaryError(409, 'This file changed. Reopen it before trying again.')
        await assertSame(parent)
        return { info: before, bytes }
    } finally { await file.close() }
}

async function retireFile(parent: PinnedDir, name: string, expected: Identity): Promise<void> {
    const retired = `.rerun-skill-retired-${randomBytes(12).toString('hex')}`
    await renameSkillEntry(parent.path, parent.identity, name, expected, retired)
    const info = await statAt(join(parent.pinned, retired))
    if (!info || !info.isFile() || !same(identityOf(info), expected)) throw outside()
    await unlink(join(parent.pinned, retired))
    await parent.handle.sync()
}

async function preserveFile(parent: PinnedDir, name: string, info: Identity, final: string, kind: 'previous' | 'draft'): Promise<string> {
    const recovery = `${final.slice(0, 120)}.${kind}-${randomBytes(6).toString('hex')}.md`
    await renameSkillEntry(parent.path, parent.identity, name, info, recovery)
    return recovery
}

function parseJournal(value: unknown): PublicationJournal {
    const row = value as Partial<PublicationJournal> | null
    const entry = (name: unknown) => typeof name === 'string' && name.length <= 255 && !!name && name !== '.' && name !== '..' && !/[\/\\\0]/.test(name)
    const record = (file: unknown) => !!file && typeof file === 'object' && /^\d+:\d+$/.test(String((file as JournalFile).identity)) && /^[a-f0-9]{64}$/.test(String((file as JournalFile).hash))
    if (!row || row.version !== 1 || !/^\d+:\d+$/.test(row.parentIdentity ?? '') || typeof row.parent !== 'string' || relativeParts(row.parent).join('/') !== row.parent ||
        !SKILL_SLUG.test(row.parent.split('/')[0] ?? '') || row.parent.split('/').some(reserved) || row.parent.split('/').length > MAX_TREE_DEPTH ||
        !entry(row.final) || reserved(row.final!) || !entry(row.backup) || !row.backup!.startsWith(BACKUP_PREFIX) ||
        !entry(row.temp) || !row.temp!.startsWith(TEMP_PREFIX) || !record(row.before) || !record(row.after)) {
        throw new SkillBoundaryError(409, 'A previous Skills change needs recovery. Its files were left unchanged.')
    }
    return row as PublicationJournal
}

async function recoverJournal(root: PinnedDir, name: string, record: PublicationJournal, check: () => Promise<void>, journalIdentity: Identity): Promise<void> {
    const recoveryCheck = async () => {
        await check()
        const slug = record.parent.split('/')[0]!
        const owner = (await ownersInWorkspace(join(dirname(root.path), 'workspace'))).get(slug)
        if (owner) throw new SkillBoundaryError(409, connectorSkillReadOnlyError(slug, owner))
        await assertSame(root)
    }
    await recoveryCheck()
    const parent = await openDirectory(join(root.path, record.parent))
    try {
        if (identityKey(parent.identity) !== record.parentIdentity) throw new SkillBoundaryError(409, 'The interrupted skill folder moved or was replaced. Its recovery files were left unchanged.')
        let final = await readSnapshot(parent, record.final)
        let backup = await readSnapshot(parent, record.backup)
        const temp = await readSnapshot(parent, record.temp)
        if (!final && backup && identityKey(backup.info) === record.before.identity) {
            await recoveryCheck()
            await renameSkillEntry(parent.path, parent.identity, record.backup, backup.info, record.final)
            final = await readSnapshot(parent, record.final)
            backup = null
        }
        const newAtFinal = matching(final, record.after)
        const recoveries: string[] = []
        // A third-party winner remains at the ordinary name. Neither the previous bytes nor
        // our draft is removed; recovery names are visible in the original bundled-file list.
        if (backup) {
            if (identityKey(backup.info) !== record.before.identity) throw new SkillBoundaryError(409, 'Skills recovery found another file. All versions were preserved.')
            await recoveryCheck()
            // Retain the displaced inode even after success. A writer can open it after
            // any lsof/stat check; preserving it is the only honest way to keep such writes.
            // Retained versions count against the same bounded per-skill storage budget.
            if (!newAtFinal || !matching(backup, record.before)) recoveries.push(await preserveFile(parent, record.backup, backup.info, record.final, 'previous'))
        }
        if (temp) {
            await recoveryCheck()
            if (!matching(temp, record.after)) throw new SkillBoundaryError(409, 'Skills recovery found a changed draft. All versions were preserved.')
            if (newAtFinal) await retireFile(parent, record.temp, temp.info)
            else recoveries.push(await preserveFile(parent, record.temp, temp.info, record.final, 'draft'))
        }
        if (!final) throw new SkillBoundaryError(409, 'A previous Skills change needs recovery. Its files were left unchanged.')
        const journal = await statAt(join(root.pinned, name))
        await recoveryCheck()
        if (!journal || !same(journal, journalIdentity)) throw new SkillBoundaryError(409, 'The Skills recovery record changed. It was left unchanged.')
        await retireFile(root, name, journalIdentity)
        if (recoveries.length) throw new SkillBoundaryError(409, `Another editor changed this file. Recovery copies are in the skill: ${recoveries.join(', ')}`)
    } finally { await parent.handle.close() }
}

async function recoverSkillPublications(root: PinnedDir, check: () => Promise<void>): Promise<void> {
    const names = (await readdir(root.pinned)).filter(name => name.startsWith(JOURNAL_PREFIX))
    if (names.length > 100) throw new SkillBoundaryError(409, 'Too many interrupted Skills changes need recovery.')
    for (const name of names) {
        const file = await readSnapshot(root, name)
        if (!file || file.bytes.length > 4096) throw new SkillBoundaryError(409, 'An interrupted Skills change needs recovery.')
        let parsed: unknown
        try { parsed = JSON.parse(file.bytes.toString('utf8')) } catch { throw new SkillBoundaryError(409, 'An interrupted Skills change needs recovery.') }
        await recoverJournal(root, name, parseJournal(parsed), check, file.info)
    }
}

async function publishFile(root: PinnedDir, parent: PinnedDir, name: string, content: string, options: { createOnly?: boolean; baseIdentity?: string; completeRead?: boolean }, check: () => Promise<void>): Promise<void> {
    await check()
    const before = await readSnapshot(parent, name)
    const skillRoot = await openDirectory(join(root.path, parent.path.slice(root.path.length + 1).split('/')[0]!))
    const budget = treeBudget()
    try { await listRealFiles(skillRoot, '', budget) } finally { await skillRoot.handle.close() }
    if (budget.bytes + Buffer.byteLength(content, 'utf8') > MAX_SKILL_FOLDER_BYTES || (!before && budget.files >= MAX_SKILL_REFERENCE_FILES && name !== MANIFEST)) throw new SkillBoundaryError(413, 'This skill folder exceeds its file or size limit.')
    if (before && budget.retained >= 1000) throw new SkillBoundaryError(413, 'This skill has reached its retained-recovery storage limit. Existing versions were kept.')
    if (options.createOnly && before) throw new SkillBoundaryError(409, 'A file with that name already exists.')
    if (options.completeRead) {
        if (!options.baseIdentity || !options.baseIdentity.endsWith(':complete')) throw new SkillBoundaryError(409, 'This file was only partly read, so it was not saved.')
        if (!before || `${versionKey(before.info)}:complete` !== options.baseIdentity) throw new SkillBoundaryError(409, 'This file changed. It was not saved.')
    }
    const temp = `${TEMP_PREFIX}${randomBytes(12).toString('hex')}`
    const tempIdentity = await writeTemp(parent.pinned, temp, content, parent.uid)
    let journalName: string | null = null
    try {
        await hooks?.beforeFilePublish?.()
        await check()
        await assertSame(parent)
        const now = await readSnapshot(parent, name)
        if (before ? !now || !sameVersion(before.info, now.info) || hashBytes(before.bytes) !== hashBytes(now.bytes) : now !== null) throw new SkillBoundaryError(409, 'This file changed. It was not saved.')
        if (before) {
            const staged = await readSnapshot(parent, temp)
            if (!staged) throw outside()
            const record: PublicationJournal = { version: 1, parent: parent.path.slice(root.path.length + 1), parentIdentity: identityKey(parent.identity), final: name,
                backup: `${BACKUP_PREFIX}${randomBytes(12).toString('hex')}`, temp, before: recordOf(before), after: recordOf(staged) }
            journalName = `${JOURNAL_PREFIX}${randomBytes(12).toString('hex')}.json`
            const journalIdentity = await writeTemp(root.pinned, journalName, JSON.stringify(record), root.uid)
            await root.handle.sync()
            await check()
            await renameSkillEntry(parent.path, parent.identity, name, before.info, record.backup)
            await hooks?.afterOriginalMoved?.()
            const displaced = await readSnapshot(parent, record.backup)
            if (!matching(displaced, record.before)) throw new SkillBoundaryError(409, 'This file changed. Its previous bytes were preserved.')
            await check()
            await renameSkillEntry(parent.path, parent.identity, temp, tempIdentity, name)
            await recoverJournal(root, journalName, record, check, journalIdentity)
            journalName = null
        } else {
            await renameSkillEntry(parent.path, parent.identity, temp, tempIdentity, name)
        }
        await assertSame(parent)
    } catch (error) {
        // Once journalled, retain all recovery evidence. The next read/write restores a
        // missing ordinary name or preserves an independent winner without replacement.
        if (!journalName) await removeName(parent.pinned, temp, tempIdentity)
        throw error
    }
}

export async function writeConfinedFile(root: string, path: string, content: string, options: PublishOptions & { createOnly?: boolean; baseIdentity?: string; completeRead?: boolean } = {}): Promise<void> {
    const parts = relativeParts(path)
    const name = parts.at(-1)
    if (!name || reserved(name) || parts.length > MAX_TREE_DEPTH) throw new SkillBoundaryError(400, 'Send a file path to save.')
    if (parts.length === 1 && name.toUpperCase() === MANIFEST.toUpperCase()) throw new SkillBoundaryError(400, 'Send a file path other than SKILL.md.')
    await withPublication(dirname(root), options, async (skills, check) => {
        const rootDir = await openDirectory(root)
        const opened: PinnedDir[] = [rootDir]
        try {
            let parent = rootDir
            for (const part of parts.slice(0, -1)) {
                await check()
                parent = await ensureChildDirectory(parent, parent.pinned, parent.path, part)
                opened.push(parent)
            }
            await publishFile(skills, parent, name, content, options, check)
        } finally { await Promise.all(opened.reverse().map(item => item.handle.close())) }
    })
}

export async function deleteConfinedFile(root: string, path: string, options: PublishOptions = {}): Promise<void> {
    const parts = relativeParts(path)
    const name = parts.at(-1)
    if (!name || reserved(name) || parts.length > MAX_TREE_DEPTH) throw new SkillBoundaryError(400, 'Send a file path to delete.')
    if (parts.length === 1 && name.toUpperCase() === MANIFEST.toUpperCase()) throw new SkillBoundaryError(400, 'Send a file path other than SKILL.md.')
    await withPublication(dirname(root), options, async (_skills, check) => {
        const parentPath = join(root, ...parts.slice(0, -1))
        let parent: PinnedDir
        try { parent = await openDirectory(parentPath) } catch (error) { if (error instanceof SkillBoundaryError && error.status === 404) return; throw error }
        try {
            const before = await readSnapshot(parent, name)
            if (!before) return
            await check()
            const deleted = `.rerun-skill-deleted-${randomBytes(12).toString('hex')}`
            // This exclusive move is the delete commit. It never removes a later arrival at
            // the ordinary name; a crash leaves only an already-deleted hidden entry.
            await renameSkillEntry(parent.path, parent.identity, name, before.info, deleted)
            const moved = await readSnapshot(parent, deleted)
            if (!moved || hashBytes(moved.bytes) !== hashBytes(before.bytes)) {
                if (moved) await preserveFile(parent, deleted, moved.info, name, 'previous')
                throw new SkillBoundaryError(409, 'This file changed during deletion. A recovery copy was preserved.')
            }
            await retireFile(parent, deleted, moved.info)
        } finally { await parent.handle.close() }
    })
}

async function ensureSkillsRoot(skillsRoot: string): Promise<void> {
    const existing = await statAt(skillsRoot)
    if (existing) return
    const parentPath = dirname(skillsRoot)
    const name = basename(skillsRoot)
    const parent = await openDirectory(parentPath)
    try {
        await assertSame(parent)
        await hooks?.beforeDirectoryCreate?.()
        await assertSame(parent)
        await mkdir(join(parent.pinned, name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
        const created = await statAt(join(parent.pinned, name))
        const atPath = await statAt(skillsRoot)
        if (!created || !atPath || created.isSymbolicLink() || !created.isDirectory() || created.uid !== parent.uid || !same(identityOf(created), identityOf(atPath))) throw outside()
    } finally {
        await parent.handle.close()
    }
}

async function writeTree(root: PinnedDir, files: { path: string; content: string }[]): Promise<string[]> {
    let total = 0
    const names: string[] = []
    for (const file of files) {
        const parts = relativeParts(file.path)
        const name = parts[parts.length - 1]
        if (!name || reserved(name) || (parts.length === 1 && name.toUpperCase() === MANIFEST.toUpperCase())) throw new SkillBoundaryError(400, 'Use the skill body to change SKILL.md')
        const bytes = Buffer.byteLength(file.content, 'utf8')
        if (bytes > MAX_SKILL_FILE_BYTES) throw new SkillBoundaryError(413, `${file.path} is too large (max 10 MB per file)`)
        total += bytes
        if (total > MAX_SKILL_FOLDER_BYTES) throw new SkillBoundaryError(413, 'Skill folder is too large (max 50 MB)')
        let parent = root
        const opened: PinnedDir[] = []
        try {
            for (const part of parts.slice(0, -1)) {
                parent = await ensureChildDirectory(parent, parent.pinned, parent.path, part)
                opened.push(parent)
            }
            await writeTemp(parent.pinned, name, file.content, parent.uid)
            names.push(parts.join('/'))
        } finally {
            await Promise.all(opened.reverse().map(item => item.handle.close()))
        }
    }
    return names
}

function renderManifest(name: string, description: string, body: string): string {
    return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`
}

export function parseSkillDraft(content: string, overrides?: { name?: string; description?: string }): { name: string; description: string; body: string } {
    if (!content.trim()) throw new SkillBoundaryError(400, 'File is empty')
    const { data, body } = parseFrontmatter(content)
    const name = (overrides?.name ?? (typeof data.name === 'string' ? data.name : '')).trim()
    if (!name) throw new SkillBoundaryError(400, "Missing 'name' in frontmatter")
    const description = overrides?.description ?? (typeof data.description === 'string' ? data.description : '')
    if (!body.trim()) throw new SkillBoundaryError(400, 'Skill body is empty')
    return { name, description, body: body.trim() }
}

type TreeBudget = { files: number; bytes: number; entries: number; retained: number }
const treeBudget = (): TreeBudget => ({ files: 0, bytes: 0, entries: 0, retained: 0 })
function visitTree(budget: TreeBudget, depth: number, entries: number) {
    budget.entries += entries
    if (depth > MAX_TREE_DEPTH || budget.entries > 5000) throw new SkillBoundaryError(413, 'This skill folder has too many nested entries.')
}
function countFile(budget: TreeBudget, size: bigint, reference = true) {
    if (size > BigInt(MAX_SKILL_FILE_BYTES)) throw new SkillBoundaryError(413, 'A skill file can be at most 10 MB.')
    budget.bytes += Number(size)
    if (reference) budget.files += 1
    if (budget.bytes > MAX_SKILL_FOLDER_BYTES || budget.files > MAX_SKILL_REFERENCE_FILES) throw new SkillBoundaryError(413, 'This skill has reached its active-file and retained-recovery storage limit. Existing versions were kept.')
}
async function listRealFiles(dir: PinnedDir, prefix: string, budget = treeBudget(), depth = 0): Promise<string[]> {
    const names: string[] = []
    const entries = (await readdir(dir.pinned)).sort((a, b) => a.localeCompare(b))
    visitTree(budget, depth, entries.length)
    for (const entry of entries) {
        if (entry.startsWith(BACKUP_PREFIX)) {
            const kept = await statAt(join(dir.pinned, entry))
            if (!kept || !kept.isFile() || kept.isSymbolicLink() || kept.nlink !== BigInt(1) || kept.uid !== dir.uid) throw outside()
            budget.retained += 1
            if (budget.retained > 1000) throw new SkillBoundaryError(413, 'This skill has reached its retained-recovery storage limit. Existing versions were kept.')
            countFile(budget, kept.size, false)
            continue
        }
        if (reserved(entry) || entry === '.DS_Store' || entry === 'node_modules' || entry === '.git') continue
        const info = await statAt(join(dir.pinned, entry))
        if (!info || info.isSymbolicLink() || info.uid !== dir.uid) continue
        const rel = prefix ? `${prefix}/${entry}` : entry
        if (info.isDirectory()) {
            const handle = await openPinned(dir.pinned, entry, openFlags(true))
            try {
                const child: PinnedDir = { handle, pinned: await pinnedDirectory(handle), path: join(dir.path, entry), identity: identityOf(await handle.stat({ bigint: true })), uid: dir.uid }
                if (!same(child.identity, info)) throw outside()
                names.push(...await listRealFiles(child, rel, budget, depth + 1))
            } finally { await handle.close() }
        } else if (info.isFile() && info.nlink === BigInt(1)) { countFile(budget, info.size, rel !== MANIFEST); if (rel !== MANIFEST) names.push(rel) }
    }
    return names
}

export async function skillManifestExists(skillsRoot: string, slug: string, options: PublishOptions = {}): Promise<boolean> {
    if (!await statAt(skillsRoot)) return false
    return withPublication(skillsRoot, options, () => skillManifestExistsUnlocked(skillsRoot, slug))
}

async function skillManifestExistsUnlocked(skillsRoot: string, slug: string): Promise<boolean> {
    assertSlug(slug)
    const rootInfo = await statAt(skillsRoot)
    if (!rootInfo) return false
    const root = await openDirectory(skillsRoot)
    try {
        const dir = await statAt(join(root.pinned, slug))
        if (!dir || dir.isSymbolicLink() || !dir.isDirectory() || dir.uid !== root.uid) return false
        const handle = await openPinned(root.pinned, slug, openFlags(true))
        try {
            const manifest = await statAt(join(await pinnedDirectory(handle), MANIFEST))
            const opened = await handle.stat({ bigint: true })
            const current = await statAt(join(root.pinned, slug))
            await assertSame(root)
            return same(opened, dir) && same(current, dir) && opened.uid === root.uid && !!manifest && manifest.isFile() && !manifest.isSymbolicLink() && manifest.nlink === BigInt(1) && manifest.uid === root.uid
        } finally { await handle.close() }
    } finally { await root.handle.close() }
}

export async function readPublishedSkill(skillsRoot: string, slug: string, options: PublishOptions = {}): Promise<PublishedSkill | null> {
    if (!await statAt(skillsRoot)) return null
    return withPublication(skillsRoot, options, () => readPublishedSkillUnlocked(skillsRoot, slug))
}

async function readPublishedSkillUnlocked(skillsRoot: string, slug: string): Promise<PublishedSkill | null> {
    assertSlug(slug)
    if (!await skillManifestExistsUnlocked(skillsRoot, slug)) return null
    const skill = await openDirectory(join(skillsRoot, slug))
    try {
        const snapshot = await readSnapshot(skill, MANIFEST)
        if (!snapshot) return null
        const decoded = decodeBounded(snapshot.bytes, snapshot.bytes.length, null)
        if (decoded.truncated) throw new SkillBoundaryError(409, 'This skill manifest was only partly read, so it was left unchanged.')
        const draft = parseSkillDraft(decoded.text)
        const files = await listRealFiles(skill, '')
        await assertSame(skill)
        return { slug, ...draft, files, identity: `${versionKey(snapshot.info)}:complete` }
    } finally { await skill.handle.close() }
}

async function readWholeFile(pinned: string, name: string): Promise<string> {
    const file = await openPinned(pinned, name, openFlags(false))
    try {
        const info = await file.stat({ bigint: true })
        if (info.size > BigInt(MAX_SKILL_FILE_BYTES)) throw new SkillBoundaryError(413, 'A skill file can be at most 10 MB.')
        const read = await readHandle(file, MAX_SKILL_FILE_BYTES, null)
        if (read.truncated) throw new SkillBoundaryError(413, 'A skill file can be at most 10 MB.')
        return read.content
    } finally { await file.close() }
}

async function collectImportFiles(dir: PinnedDir, prefix: string, budget = treeBudget(), depth = 0): Promise<SkillFilePayload[]> {
    const files: SkillFilePayload[] = []
    const entries = (await readdir(dir.pinned)).sort((a, b) => a.localeCompare(b))
    visitTree(budget, depth, entries.length)
    for (const entry of entries) {
        if (reserved(entry) || entry === '.DS_Store' || entry === 'node_modules' || entry === '.git') continue
        const info = await statAt(join(dir.pinned, entry))
        if (!info || info.isSymbolicLink() || info.uid !== dir.uid) continue
        const rel = prefix ? `${prefix}/${entry}` : entry
        if (info.isDirectory()) {
            const handle = await openPinned(dir.pinned, entry, openFlags(true))
            try {
                const child: PinnedDir = { handle, pinned: await pinnedDirectory(handle), path: join(dir.path, entry), identity: identityOf(await handle.stat({ bigint: true })), uid: dir.uid }
                if (!same(child.identity, info)) throw outside()
                files.push(...await collectImportFiles(child, rel, budget, depth + 1))
            } finally { await handle.close() }
        } else if (info.isFile() && info.nlink === BigInt(1) && rel !== MANIFEST) {
            countFile(budget, info.size)
            const content = await readWholeFile(dir.pinned, entry)
            files.push({ path: rel, content })
        }
    }
    return files
}

/** Summary-only listing; full bodies and reference trees are fetched only for a selected skill. */
export async function listPublishedSkills(skillsRoot: string, options: PublishOptions = {}): Promise<PublishedSkill[]> {
    if (!await statAt(skillsRoot)) return []
    return withPublication(skillsRoot, options, async (root, check) => {
        const skills: PublishedSkill[] = []
        const names = await readdir(root.pinned)
        if (names.length > 1000) throw new SkillBoundaryError(413, 'Too many skills to list.')
        let manifestBytes = 0
        let summaryBytes = 0
        for (const slug of names.filter(name => SKILL_SLUG.test(name)).sort((a, b) => a.localeCompare(b))) {
            await check()
            const info = await statAt(join(root.pinned, slug))
            if (!info || info.isSymbolicLink() || !info.isDirectory() || info.uid !== root.uid) continue
            const folder = await openDirectory(join(root.path, slug))
            try {
                const listed = await statAt(join(folder.pinned, MANIFEST))
                if (!listed) continue
                manifestBytes += Number(listed.size)
                if (manifestBytes > MAX_SKILL_FILE_BYTES) throw new SkillBoundaryError(413, 'The skill index is too large to read at once.')
                const snapshot = await readSnapshot(folder, MANIFEST)
                if (!snapshot) continue
                if (!sameVersion(listed, snapshot.info)) throw new SkillBoundaryError(409, 'A skill changed while its index was being read.')
                manifestBytes = manifestBytes - Number(listed.size) + snapshot.bytes.length
                if (manifestBytes > MAX_SKILL_FILE_BYTES) throw new SkillBoundaryError(413, 'The skill index is too large to read at once.')
                const decoded = decodeBounded(snapshot.bytes, snapshot.bytes.length, null)
                if (decoded.truncated) throw new SkillBoundaryError(409, 'A skill manifest is not complete UTF-8.')
                const draft = parseSkillDraft(decoded.text)
                summaryBytes += Buffer.byteLength(draft.name, 'utf8') + Buffer.byteLength(draft.description, 'utf8')
                if (summaryBytes > 1_048_576) throw new SkillBoundaryError(413, 'The skill index is too large to show at once.')
                skills.push({ slug, name: draft.name, description: draft.description, body: '', files: [] })
            } finally { await folder.handle.close() }
            await check()
        }
        return skills
    })
}

// Missing registry means no connector owns a skill. A symlink or a document that is not
// `{ services: { ... } }` refuses, so a broken registry cannot look like an empty one.
export async function ownersInWorkspace(workspaceRoot: string): Promise<Map<string, string>> {
    const root = await openDirectory(workspaceRoot).catch(error => {
        if (error instanceof SkillBoundaryError) throw unreadableOwners()
        throw error
    })
    try {
        const folder = await statAt(join(root.pinned, '.rerun'))
        if (!folder) return new Map()
        if (folder.isSymbolicLink() || !folder.isDirectory() || folder.uid !== root.uid) throw unreadableOwners()
        const child = await openDirectory(join(root.path, '.rerun'))
        try {
            if (!same(child.identity, folder)) throw unreadableOwners()
            const listed = await statAt(join(child.pinned, 'services.json'))
            if (!listed) return new Map()
            if (listed.size > BigInt(1_048_576)) throw unreadableOwners()
            const file = await readSnapshot(child, 'services.json')
            if (!file) throw unreadableOwners()
            if (file.bytes.length > 1_048_576 || !sameVersion(listed, file.info)) throw unreadableOwners()
            await assertSame(child)
            await assertSame(root)
            return ownersOfRegistryJson(file.bytes.toString('utf8'))
        } finally { await child.handle.close() }
    } finally { await root.handle.close() }
}

// Reads a workspace skill file or folder without following a symlink. Directory imports keep
// bundled files as payloads; they are published later by publishNewSkill, not copied.
export async function readSkillImportSource(workspaceRoot: string, sourcePath: string): Promise<{ markdown: string; files: SkillFilePayload[]; fallbackName: string }> {
    const parts = relativeParts(sourcePath)
    if (parts.some(part => part.startsWith('.'))) throw new SkillBoundaryError(400, 'Import a visible workspace file or skill folder.')
    if (parts.length === 0) throw new SkillBoundaryError(400, 'Send a path to import.')
    const missingSource = () => new SkillBoundaryError(404, `Source not found: ${sourcePath}`)
    const root = await openDirectory(workspaceRoot).catch(error => {
        if (error instanceof SkillBoundaryError) throw missingSource()
        throw error
    })
    const opened: FileHandle[] = []
    try {
        let pinned = root.pinned
        for (const [index, part] of parts.entries()) {
            const info = await statAt(join(pinned, part))
            if (!info) throw missingSource()
            if (info.isSymbolicLink() || info.uid !== root.uid) throw outside()
            const last = index === parts.length - 1
            if (last && info.isDirectory()) {
                const handle = await openPinned(pinned, part, openFlags(true))
                opened.push(handle)
                const dirPinned = await pinnedDirectory(handle)
                const manifest = await statAt(join(dirPinned, MANIFEST))
                if (!manifest || manifest.isSymbolicLink() || !manifest.isFile() || manifest.nlink !== BigInt(1)) throw new SkillBoundaryError(400, `No SKILL.md in ${sourcePath}`)
                const child: PinnedDir = { handle, pinned: dirPinned, path: join(workspaceRoot, ...parts), identity: identityOf(await handle.stat({ bigint: true })), uid: root.uid }
                return { markdown: await readWholeFile(dirPinned, MANIFEST), files: await collectImportFiles(child, ''), fallbackName: part }
            }
            if (last && info.isFile() && info.nlink === BigInt(1)) {
                return { markdown: await readWholeFile(pinned, part), files: [], fallbackName: part.replace(/\.md$/i, '') }
            }
            if (last || !info.isDirectory()) throw outside()
            const next = await openPinned(pinned, part, openFlags(true))
            opened.push(next)
            pinned = await pinnedDirectory(next)
        }
        throw missingSource()
    } finally {
        await Promise.all(opened.map(handle => handle.close()))
        await root.handle.close()
    }
}

export async function publishNewSkill(skillsRoot: string, slug: string, draft: { name: string; description: string; body: string; files?: SkillFilePayload[] }, options: PublishOptions = {}): Promise<PublishedSkill> {
    assertSlug(slug)
    if ((draft.files?.length ?? 0) > MAX_SKILL_REFERENCE_FILES) throw new SkillBoundaryError(400, `Too many reference files (max ${MAX_SKILL_REFERENCE_FILES})`)
    return withPublication(skillsRoot, options, async (root, check) => {
        if (await statAt(join(root.pinned, slug))) throw new SkillBoundaryError(409, 'A skill with that name already exists.')
        const stageName = `${STAGE_PREFIX}${randomBytes(12).toString('hex')}`
        await mkdir(join(root.pinned, stageName), { mode: 0o755 })
        const stage = await openDirectory(join(root.path, stageName))
        let attempted = false
        try {
            await writeTemp(stage.pinned, MANIFEST, renderManifest(draft.name, draft.description, draft.body), root.uid)
            const files = await writeTree(stage, draft.files ?? [])
            await listRealFiles(stage, '')
            await stage.handle.sync()
            await check()
            await assertSame(stage)
            attempted = true
            await renameSkillEntry(root.path, root.identity, stageName, stage.identity, slug)
            const result = await readPublishedSkillUnlocked(skillsRoot, slug)
            if (!result) throw new SkillBoundaryError(409, 'Could not confirm the new skill. Reopen Skills before trying again.')
            return { ...result, files }
        } finally {
            await stage.handle.close()
            // An uncertain native rename may have moved an independent inode. Leave its
            // recovery name alone; only a never-published staging folder is disposable.
            if (!attempted) await removeOwnedDirectory(root.pinned, stageName, stage.identity, root.uid)
        }
    })
}

async function removeOwnedDirectory(parentPinned: string, name: string, expected: Identity, uid: bigint): Promise<void> {
    const info = await statAt(join(parentPinned, name))
    if (!info || !same(identityOf(info), expected) || info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid) return
    const handle = await openPinned(parentPinned, name, openFlags(true))
    try {
        const opened = await handle.stat({ bigint: true })
        if (!same(identityOf(opened), expected)) return
        const pinned = await pinnedDirectory(handle)
        for (const entry of await readdir(pinned)) await removeEntry(pinned, entry, uid)
    } finally { await handle.close() }
    const again = await statAt(join(parentPinned, name))
    if (again && same(identityOf(again), expected)) await rmdir(join(parentPinned, name))
}

async function removeEntry(parentPinned: string, name: string, uid: bigint): Promise<void> {
    const info = await statAt(join(parentPinned, name))
    if (!info || info.uid !== uid) return
    if (info.isSymbolicLink()) { await unlink(join(parentPinned, name)); return }
    if (info.isDirectory()) { await removeOwnedDirectory(parentPinned, name, identityOf(info), uid); return }
    if (info.isFile()) await unlink(join(parentPinned, name))
}

export async function replaceSkillManifest(skillsRoot: string, slug: string, patch: { description?: string; body?: string; baseIdentity?: string }, options: PublishOptions = {}): Promise<PublishedSkill> {
    assertSlug(slug)
    return withPublication(skillsRoot, options, async (root, check) => {
        const skill = await openDirectory(join(skillsRoot, slug))
        try {
            const before = await readSnapshot(skill, MANIFEST)
            if (!before) throw new SkillBoundaryError(404, 'Skill not found.')
            const read = decodeBounded(before.bytes, before.bytes.length, null)
            if (read.truncated) throw new SkillBoundaryError(409, 'This skill manifest is not complete UTF-8. It was left unchanged.')
            const current = parseSkillDraft(read.text)
            const baseIdentity = `${versionKey(before.info)}:complete`
            if (patch.baseIdentity && patch.baseIdentity !== baseIdentity) throw new SkillBoundaryError(409, 'This skill changed. Reopen it before saving.')
            const description = patch.description ?? current.description
            const body = patch.body ?? current.body
            if (!body.trim()) throw new SkillBoundaryError(400, 'Skill body is empty')
            await publishFile(root, skill, MANIFEST, renderManifest(current.name, description, body), { baseIdentity, completeRead: true }, check)
            const saved = await readSnapshot(skill, MANIFEST)
            if (!saved) throw outside()
            return { slug, name: current.name, description, body: body.trim(), files: await listRealFiles(skill, ''), identity: `${versionKey(saved.info)}:complete` }
        } finally { await skill.handle.close() }
    })
}

export async function deleteSkillFolder(skillsRoot: string, slug: string, options: PublishOptions = {}): Promise<void> {
    assertSlug(slug)
    await withPublication(skillsRoot, options, async (root, check) => {
        const info = await statAt(join(root.pinned, slug))
        if (!info) throw new SkillBoundaryError(404, 'Skill not found.')
        if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== root.uid) throw outside()
        await check()
        const source = await openDirectory(join(root.path, slug))
        try { await listRealFiles(source, '') } finally { await source.handle.close() }
        const deleted = `.rerun-skill-deleted-${randomBytes(12).toString('hex')}`
        await renameSkillEntry(root.path, root.identity, slug, info, deleted)
        await removeOwnedDirectory(root.pinned, deleted, info, root.uid)
    })
}

function octal(value: number, width: number): string {
    return value.toString(8).padStart(width, '0')
}

function tarHeader(name: string, size: number, type: '0' | '5'): Buffer {
    const header = Buffer.alloc(512, 0)
    const prefix = name.length > 100 ? name.slice(0, name.lastIndexOf('/')) : ''
    const base = prefix ? name.slice(prefix.length + 1) : name
    if (Buffer.byteLength(base, 'utf8') > 100 || Buffer.byteLength(prefix, 'utf8') > 155) throw new SkillBoundaryError(413, 'A bundled file name is too long to export safely.')
    header.write(base, 0, 100, 'utf8')
    header.write(`${octal(type === '5' ? 0o755 : 0o644, 7)}\0`, 100)
    header.write(`${octal(0, 7)}\0`, 108)
    header.write(`${octal(0, 7)}\0`, 116)
    header.write(`${octal(size, 11)}\0`, 124)
    header.write(`${octal(0, 11)}\0`, 136)
    header.write('        ', 148)
    header.write(type, 156)
    if (prefix) header.write(prefix, 345, 155, 'utf8')
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${octal(sum, 6)}\0 `, 148)
    return header
}

async function packDirectory(dir: PinnedDir, archiveName: string, out: Buffer[], budget = treeBudget(), depth = 0): Promise<void> {
    out.push(tarHeader(archiveName, 0, '5'))
    const entries = (await readdir(dir.pinned)).sort((a, b) => a.localeCompare(b))
    visitTree(budget, depth, entries.length)
    for (const entry of entries) {
        if (reserved(entry)) continue
        const info = await statAt(join(dir.pinned, entry))
        if (!info || info.isSymbolicLink() || info.uid !== dir.uid) continue
        const name = `${archiveName}/${entry}`
        if (info.isDirectory()) {
            const handle = await openPinned(dir.pinned, entry, openFlags(true))
            try {
                const child: PinnedDir = { handle, pinned: await pinnedDirectory(handle), path: join(dir.path, entry), identity: identityOf(await handle.stat({ bigint: true })), uid: dir.uid }
                if (!same(child.identity, info)) throw outside()
                await packDirectory(child, name, out, budget, depth + 1)
            } finally { await handle.close() }
        } else if (info.isFile() && info.nlink === BigInt(1)) {
            countFile(budget, info.size, entry !== MANIFEST || depth !== 0)
            const snapshot = await readSnapshot(dir, entry)
            if (!snapshot || !sameVersion(snapshot.info, info)) throw new SkillBoundaryError(409, 'This skill changed during export.')
            const bytes = snapshot.bytes
            out.push(tarHeader(name, bytes.length, '0'), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512, 0))
        }
    }
}

export async function archiveSkillFolder(skillsRoot: string, slug: string): Promise<Buffer> {
    assertSlug(slug)
    return withPublication(skillsRoot, {}, async () => {
        const skill = await openDirectory(join(skillsRoot, slug))
        try {
            const chunks: Buffer[] = []
            await packDirectory(skill, slug, chunks)
            chunks.push(Buffer.alloc(1024, 0))
            return gzipSync(Buffer.concat(chunks))
        } finally { await skill.handle.close() }
    })
}
