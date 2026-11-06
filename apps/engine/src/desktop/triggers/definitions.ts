import { lstat, mkdir, readdir, unlink, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import matter from 'gray-matter'
import { triggerFile, triggersDir } from '../../config/paths.js'
import { readTrigger } from '../../triggers/loader.js'
import { withKeyedLock } from '../../lib/lock.js'
import { DESKTOP_TRIGGER_SLUG_RE } from '@rerun/contracts'
import { desktopTriggerDefinitionRevision } from './lifecycle.js'
import type { DesktopTriggerRecord } from './types.js'

async function safeRoot(id: string) {
    await mkdir(triggersDir(id), { recursive: true, mode: 0o700 })
    const root = await lstat(triggersDir(id))
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Unsafe trigger directory')
}
export async function readDesktopTriggerDefinition(id: string, slug: string): Promise<DesktopTriggerRecord | null> {
    if (!DESKTOP_TRIGGER_SLUG_RE.test(slug)) throw new Error('Invalid trigger slug')
    try {
        const root = await lstat(triggersDir(id))
        if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Unsafe trigger directory')
        const file = await lstat(triggerFile(id, slug))
        if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 262144) throw new Error('Unsafe trigger file')
        return await readTrigger(id, slug)
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export async function listDesktopTriggerDefinitions(id: string) {
    let entries: string[]
    try {
        const root = await lstat(triggersDir(id))
        if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Unsafe trigger directory')
        entries = await readdir(triggersDir(id))
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const records = await Promise.all(entries.filter(name => name.endsWith('.md') && DESKTOP_TRIGGER_SLUG_RE.test(name.slice(0, -3))).map(name => readDesktopTriggerDefinition(id, name.slice(0, -3))))
    return records.filter((row): row is DesktopTriggerRecord => row !== null)
}
export async function replaceDesktopTriggerDefinition(id: string, slug: string, expected: DesktopTriggerRecord | null, next: DesktopTriggerRecord | null, admission?: () => Promise<void>) {
    return withKeyedLock(`trigger:${id}:${slug}`, async () => {
        await safeRoot(id)
        const current = await readDesktopTriggerDefinition(id, slug)
        if (desktopTriggerDefinitionRevision(current) !== desktopTriggerDefinitionRevision(expected)) throw new Error('Trigger definition changed')
        if (!next) { await admission?.(); if (current) await unlink(triggerFile(id, slug)); return null }
        const record = { ...next, fireCount: current?.fireCount ?? next.fireCount, lastFiredAt: current?.lastFiredAt ?? next.lastFiredAt }
        const { body, connectionId, slug: _slug, ...frontmatter } = record
        const path = triggerFile(id, slug), temporary = `${path}.${randomUUID()}.tmp`
        try {
            await writeFile(temporary, matter.stringify(`\n${body.trim()}\n`, { ...frontmatter, connection: connectionId }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
            await admission?.()
            await rename(temporary, path)
        } finally { await rm(temporary, { force: true }).catch(() => {}) }
        return readDesktopTriggerDefinition(id, slug)
    })
}
