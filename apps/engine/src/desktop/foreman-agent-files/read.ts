import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { FOREMAN_AGENT_FILE_COPY, FOREMAN_AGENT_FILE_READ_BYTES, foremanAgentVisiblePath } from './contract.js'
import { openWithoutLinks } from '../open-without-links.js'
import { containedCoworkerWorkspace, deny, ForemanAgentFileError } from './policy.js'

const LIST_LIMIT = 512
const SEARCH_LIMIT = 128

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
    const { root, full } = await visible(coworkerId, input)
    const handle = await openWithoutLinks(full).catch(() => deny(FOREMAN_AGENT_FILE_COPY.unavailable))
    try {
        const info = await handle.stat()
        if (!info.isFile()) deny(FOREMAN_AGENT_FILE_COPY.unavailable)
        if (info.size > FOREMAN_AGENT_FILE_READ_BYTES) deny(FOREMAN_AGENT_FILE_COPY.text)
        return textOf(await readFile(handle))
    } finally {
        await handle.close()
    }
}

async function visibleChildren(root: string, directory: string, signal: AbortSignal): Promise<{ name: string; directory: boolean }[]> {
    const handle = await openWithoutLinks(directory, true).catch(() => deny(FOREMAN_AGENT_FILE_COPY.unavailable))
    try {
        if (!(await handle.stat()).isDirectory()) deny(FOREMAN_AGENT_FILE_COPY.unavailable)
        const names = (await readdir(handle)).filter(name => !name.startsWith('.') && name !== 'node_modules' && !name.toLowerCase().startsWith('.rerun')).slice(0, LIST_LIMIT + 1)
        const entries: { name: string; directory: boolean }[] = []
        for (const name of names) {
            signal.throwIfAborted()
            try { foremanAgentVisiblePath(name) } catch { continue }
            const child = join(directory, name)
            if (relative(root, child).startsWith('..')) continue
            const opened = await openWithoutLinks(child).catch(() => null)
            if (!opened) continue
            try {
                const info = await opened.stat()
                if (info.isDirectory()) entries.push({ name, directory: true })
                else if (info.isFile()) entries.push({ name, directory: false })
            } finally { await opened.close() }
        }
        return entries
    } finally {
        await handle.close()
    }
}

export async function listCoworkerVisible(coworkerId: string, input: string, signal: AbortSignal): Promise<{ entries: { name: string; directory: boolean }[]; truncated: boolean }> {
    const located = await visible(coworkerId, input || '.')
    const entries = await visibleChildren(located.root, located.full, signal)
    return { entries: entries.slice(0, LIST_LIMIT), truncated: entries.length > LIST_LIMIT }
}

export async function searchCoworkerVisibleText(coworkerId: string, input: string, pattern: string, maxResults: number, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (!pattern || pattern.length > 256) deny(FOREMAN_AGENT_FILE_COPY.path)
    const { root, full } = await visible(coworkerId, input || '.')
    const needle = pattern.toLowerCase()
    const hits: string[] = []
    const queue = [full]
    let scanned = 0
    while (queue.length && hits.length < maxResults && scanned < SEARCH_LIMIT) {
        signal.throwIfAborted()
        const current = queue.shift()!
        const children = await visibleChildren(root, current, signal).catch(error => {
            if (current === full) throw error
            return [] as { name: string; directory: boolean }[]
        })
        for (const entry of children) {
            const child = join(current, entry.name)
            if (entry.directory) queue.push(child)
            else if (hits.length < maxResults && scanned < SEARCH_LIMIT) {
                scanned += 1
                const file = await openWithoutLinks(child).catch(() => null)
                if (!file) continue
                let text = ''
                try {
                    const info = await file.stat()
                    if (info.isFile() && info.size <= FOREMAN_AGENT_FILE_READ_BYTES) text = textOf(await readFile(file))
                } catch { text = '' } finally { await file.close() }
                if (!text) continue
                text.split('\n').forEach((line, index) => {
                    if (hits.length < maxResults && line.toLowerCase().includes(needle)) hits.push(`${relative(root, child).split(sep).join('/')}:${index + 1}:${line.slice(0, 240)}`)
                })
            }
        }
    }
    return hits.join('\n') || 'No matches.'
}
