import { constants, type BigIntStats } from 'node:fs'
import { open, opendir, type FileHandle } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { FOREMAN_AGENT_FILE_COPY, FOREMAN_AGENT_FILE_READ_BYTES, foremanAgentVisiblePath } from './contract.js'
import { openWithoutLinks } from '../open-without-links.js'
import { containedCoworkerWorkspace, deny, ForemanAgentFileError } from './policy.js'

const LIST_LIMIT = 512
const LIST_SCAN_LIMIT = LIST_LIMIT * 2
const SEARCH_LIMIT = 128
const SEARCH_DIRECTORY_LIMIT = 32
type VisibleDirectory = { entries: { name: string; directory: boolean }[]; truncated: boolean }
const version = (info: BigIntStats) => [info.dev, info.ino, info.uid, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':')
const ownedFile = (info: BigIntStats) => info.isFile() && info.nlink === 1n && (typeof process.getuid !== 'function' || info.uid === BigInt(process.getuid()))

async function readOpenedText(handle: FileHandle, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const before = await handle.stat({ bigint: true })
    if (!ownedFile(before)) deny(FOREMAN_AGENT_FILE_COPY.unavailable)
    if (before.size > BigInt(FOREMAN_AGENT_FILE_READ_BYTES)) deny(FOREMAN_AGENT_FILE_COPY.text)
    // Read only the admitted size plus one byte; growth never allocates unbounded data.
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let used = 0
    while (used < bytes.length) {
        signal.throwIfAborted()
        const read = await handle.read(bytes, used, bytes.length - used, used)
        if (!read.bytesRead) break
        used += read.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    signal.throwIfAborted()
    if (!ownedFile(after) || used !== Number(before.size) || version(after) !== version(before)) deny(FOREMAN_AGENT_FILE_COPY.unavailable)
    return textOf(bytes.subarray(0, used))
}

async function pinnedDirectory(handle: FileHandle): Promise<string> {
    const info = await handle.stat({ bigint: true })
    if (!info.isDirectory() || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) deny(FOREMAN_AGENT_FILE_COPY.unavailable)
    return process.platform === 'darwin' ? `/.vol/${info.dev}/${info.ino}` : `/proc/self/fd/${handle.fd}`
}

function textOf(bytes: Buffer): string {
    if (bytes.includes(0) || bytes.byteLength > FOREMAN_AGENT_FILE_READ_BYTES) throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.text)
    try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        if (Buffer.byteLength(text, 'utf8') !== bytes.byteLength) throw new Error('unaligned')
        return text
    } catch (error) {
        if (error instanceof ForemanAgentFileError) throw error
        throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.text)
    }
}

async function visible(coworkerId: string, input: string): Promise<{ root: string; path: string; full: string }> {
    const path = input === '.' ? '.' : foremanAgentVisiblePath(input)
    const root = await containedCoworkerWorkspace(coworkerId)
    if (path === '.') return { root, path, full: root }
    const full = join(root, path)
    if (relative(root, full).split(sep).join('/') !== path) throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.path)
    return { root, path, full }
}

export async function readCoworkerVisibleText(coworkerId: string, input: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const { full } = await visible(coworkerId, input)
    const handle = await openWithoutLinks(full).catch(() => deny(FOREMAN_AGENT_FILE_COPY.unavailable))
    try {
        return await readOpenedText(handle, signal)
    } finally {
        await handle.close()
    }
}

async function visibleChildren(root: string, directory: string, signal: AbortSignal): Promise<VisibleDirectory> {
    signal.throwIfAborted()
    const handle = await openWithoutLinks(directory, true).catch(() => deny(FOREMAN_AGENT_FILE_COPY.unavailable))
    try {
        const pinned = await pinnedDirectory(handle)
        const names: string[] = []
        let scanned = 0
        let truncated = false
        for await (const { name } of await opendir(pinned)) {
            signal.throwIfAborted()
            if (++scanned > LIST_SCAN_LIMIT) { truncated = true; break }
            if (!name.startsWith('.') && name !== 'node_modules') names.push(name)
        }
        const entries: { name: string; directory: boolean }[] = []
        for (const name of names.sort((a, b) => a.localeCompare(b))) {
            signal.throwIfAborted()
            try { foremanAgentVisiblePath(name) } catch { continue }
            const child = join(directory, name)
            if (relative(root, child).startsWith('..')) continue
            // Only the final child is untrusted: its parent is the held directory inode.
            const opened = await open(join(pinned, name), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch(() => null)
            if (!opened) continue
            try {
                const info = await opened.stat({ bigint: true })
                if (info.isDirectory()) entries.push({ name, directory: true })
                else if (ownedFile(info)) entries.push({ name, directory: false })
            } finally { await opened.close() }
            if (entries.length > LIST_LIMIT) { truncated = true; break }
        }
        signal.throwIfAborted()
        return { entries: entries.slice(0, LIST_LIMIT), truncated }
    } finally {
        await handle.close()
    }
}

export async function listCoworkerVisible(coworkerId: string, input: string, signal: AbortSignal): Promise<VisibleDirectory> {
    const located = await visible(coworkerId, input || '.')
    return visibleChildren(located.root, located.full, signal)
}

export async function searchCoworkerVisibleText(coworkerId: string, input: string, pattern: string, maxResults: number, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (!pattern || pattern.length > 256) deny(FOREMAN_AGENT_FILE_COPY.path)
    const { root, full } = await visible(coworkerId, input || '.')
    const needle = pattern.toLowerCase()
    const hits: string[] = []
    const queue = [full]
    let scanned = 0
    let truncated = false
    for (let index = 0; index < queue.length; index++) {
        if (hits.length >= maxResults || scanned >= SEARCH_LIMIT) { truncated = true; break }
        signal.throwIfAborted()
        const current = queue[index]!
        const listing = await visibleChildren(root, current, signal).catch(error => {
            signal.throwIfAborted()
            if (current === full) throw error
            return { entries: [], truncated: false }
        })
        truncated ||= listing.truncated
        for (const entry of listing.entries) {
            if (hits.length >= maxResults || scanned >= SEARCH_LIMIT) { truncated = true; break }
            const child = join(current, entry.name)
            if (entry.directory) {
                if (queue.length < SEARCH_DIRECTORY_LIMIT) queue.push(child)
                else truncated = true
                continue
            }
            scanned += 1
            const file = await openWithoutLinks(child).catch(() => null)
            if (!file) continue
            let text = ''
            try {
                text = await readOpenedText(file, signal)
            } catch { signal.throwIfAborted(); text = '' } finally { await file.close() }
            const lines = text.split('\n')
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                const line = lines[lineIndex]!
                if (!line.toLowerCase().includes(needle)) continue
                if (hits.length >= maxResults) { truncated = true; break }
                hits.push(`${relative(root, child).split(sep).join('/')}:${lineIndex + 1}:${line.slice(0, 240)}`)
            }
        }
    }
    signal.throwIfAborted()
    const result = hits.join('\n') || (truncated ? 'No matches in the scanned files.' : 'No matches.')
    return truncated ? `${result}\n(search limit reached)` : result
}
