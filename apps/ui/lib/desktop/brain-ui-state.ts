'use client'

import { brainUiKeySchema, brainUiListSchema, brainUiRecordSchema, brainUiValueSchema, BRAIN_UI_TOTAL_MAX_BYTES, type BrainUiRecord, type BrainUiWrite } from './brain-ui-state-schema'
import { holdDraftAdmission, subscribeDraftShutdown } from './draft-writes'

type Cached = { record: BrainUiRecord; desired: string | null; work?: Promise<void>; pending?: BrainUiWrite; error?: Error; conflict?: boolean }
const records = new Map<string, Cached>()
const recordLoads = new Map<string, Promise<Cached>>()
let loaded = false
let hydration: Promise<void> | undefined
let shutdownHooked = false
const endpoint = '/api/desktop/brain/ui-state'

async function request(method: 'GET' | 'PUT', input?: BrainUiWrite, key?: string): Promise<unknown> {
    const signal = AbortSignal.timeout(20_000)
    const response = await fetch(key === undefined ? endpoint : `${endpoint}?${new URLSearchParams({ key })}`, { method, cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal,
        ...(input && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) })
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Could not read the saved Brain drafts.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        for (;;) {
            signal.throwIfAborted()
            const item = await reader.read()
            signal.throwIfAborted()
            if (item.done) break
            size += item.value.byteLength
            if (size > BRAIN_UI_TOTAL_MAX_BYTES * 2 + 131_072) throw new Error('The saved Brain drafts are too large to open.')
            chunks.push(item.value)
        }
        const joined = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
        const data: unknown = JSON.parse(new TextDecoder().decode(joined))
        if (response.status === 409) {
            const value = data as { record?: unknown }
            const record = brainUiRecordSchema.parse(value.record)
            const error = new Error('This Brain draft changed in another window. Close and reopen the app before editing it.') as Error & { record: BrainUiRecord }
            error.record = record
            throw error
        }
        if (!response.ok) throw new Error('Could not save or restore Brain drafts. Try again.')
        return data
    } finally { void reader.cancel().catch(() => {}) }
}
export function hydrateBrainUiState(): Promise<void> {
    if (loaded) return Promise.resolve()
    if (hydration) return hydration
    const work = (async () => {
        const list = brainUiListSchema.parse(await request('GET'))
        const keys = new Set<string>()
        let bytes = 0
        for (const record of list.records) {
            if (keys.has(record.key)) throw new Error('Duplicate saved Brain draft.')
            keys.add(record.key)
            bytes += new TextEncoder().encode(record.value ?? '').length
        }
        if (bytes > BRAIN_UI_TOTAL_MAX_BYTES) throw new Error('The saved Brain drafts are too large to open.')
        for (const record of list.records) records.set(record.key, { record, desired: record.value })
        loaded = true
        if (!shutdownHooked) { shutdownHooked = true; subscribeDraftShutdown(() => { void flushBrainUiState() }) }
    })()
    hydration = work
    void work.catch(() => { if (hydration === work) hydration = undefined })
    return work
}
export function readBrainUiState(key: string): unknown | null {
    brainUiKeySchema.parse(key)
    if (!loaded) throw new Error('Brain drafts are still being restored.')
    const value = records.get(key)?.record.value
    return value === null || value === undefined ? null : JSON.parse(value)
}
async function cachedRecord(key: string): Promise<Cached> {
    const known = records.get(key)
    if (known) return known
    const loading = recordLoads.get(key)
    if (loading) return loading
    const work = (async () => {
        const record = brainUiRecordSchema.parse(await request('GET', undefined, key))
        if (record.key !== key) throw new Error('The saved Brain draft identity could not be confirmed.')
        const cached: Cached = { record, desired: record.value }
        records.set(key, cached)
        // Hydration said this key was absent. A value created since then belongs to another
        // writer: learning its revision must not authorize overwriting that unseen draft.
        if (record.value !== null) {
            cached.conflict = true
            cached.error = new Error('This Brain draft changed in another window. Reopen the app to review it.')
            throw cached.error
        }
        return cached
    })()
    recordLoads.set(key, work)
    try { return await work } finally { if (recordLoads.get(key) === work) recordLoads.delete(key) }
}
async function sendPending(cached: Cached) {
    const pending = cached.pending
    if (!pending) return
    try {
        const saved = brainUiRecordSchema.parse(await request('PUT', pending))
        if (saved.key !== pending.key || saved.revision < pending.baseRevision + 1 || saved.value !== pending.value) {
            cached.conflict = true
            throw new Error('This saved Brain draft changed before its update was confirmed. Reopen the app to review it.')
        }
        cached.record = saved
        cached.pending = undefined
        cached.error = undefined
    } catch (cause) {
        if (cause instanceof Error && 'record' in cause) cached.conflict = true
        cached.error = cause instanceof Error ? cause : new Error('Could not save this Brain draft.')
        throw cached.error
    }
}
export async function writeBrainUiState(key: string, value: unknown | null): Promise<void> {
    brainUiKeySchema.parse(key)
    const encoded = value === null ? null : JSON.stringify(value)
    const desired = brainUiValueSchema.parse(encoded)
    const release = holdDraftAdmission()
    await hydrateBrainUiState().catch(error => { release(); throw error })
    let target: Cached
    try { target = await cachedRecord(key) } catch (error) { release(); throw error }
    target.desired = desired
    const previous = target.work
    const work = (async () => {
        if (previous) await previous.catch(() => {})
        if (target.conflict) throw target.error ?? new Error('This Brain draft changed in another window.')
        // A lost persistence ACK is retried with the exact same CAS payload before any newer save.
        await sendPending(target)
        if (target.record.value === desired) return
        target.pending = { key, baseRevision: target.record.revision, requestId: crypto.randomUUID(), value: desired }
        await sendPending(target)
    })().catch(cause => { target.error = cause instanceof Error ? cause : new Error('Could not save this Brain draft.'); throw target.error })
    target.work = work
    try { await work } finally { release(); if (target.work === work) target.work = undefined }
}
export async function flushBrainUiState(): Promise<boolean> {
    if (!loaded) return records.size === 0
    await Promise.allSettled([...records.values()].map(async cached => {
        if (cached.work) await cached.work
        else if (cached.pending || cached.record.value !== cached.desired) await writeBrainUiState(cached.record.key, cached.desired === null ? null : JSON.parse(cached.desired))
    }))
    return ![...records.values()].some(cached => cached.work || cached.pending || cached.error || cached.record.value !== cached.desired)
}
