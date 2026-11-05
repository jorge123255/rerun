'use client'

import { desktopCoworkerMentionFieldsOf, type DesktopCoworkerMentionFields } from '@rerun/contracts'
import { reconcileDesktopCoworkerMentions } from './coworker-mentions'

import { desktopAttachmentFieldsOf, desktopAttachmentSelectionsOf as desktopAttachmentPathsOf, type DesktopAttachmentFields } from '@rerun/contracts'
import { flushTabWrites, pendingTabWrite } from './tab-writes'
import { desktopComposerDraftSchema as savedSchema, type DesktopComposerDraft as Saved } from './composer-draft'

export type ComposerValue = DesktopAttachmentFields & DesktopCoworkerMentionFields & { text: string }
export type DraftState = ComposerValue & { loaded: boolean; saving: boolean; version: number; error?: string; conflict: boolean; attachmentRejected?: boolean }
type Attempt = { tabUid: string; baseRevision: number; requestId: string; text: string } & DesktopAttachmentFields & DesktopCoworkerMentionFields
type Record = {
    agentId: string; uid: string; state: DraftState; saved: Saved; dirty: boolean; forgotten: boolean;
    listeners: Set<() => void>; work?: Promise<void>; attempt?: Attempt;
}
const records = new Map<string, Record>()
const admissions = new Set<Promise<void>>()
const shutdownListeners = new Set<() => void>()
let quitting = false
export const isDesktopQuitting = () => quitting
export function subscribeDraftShutdown(listener: () => void) { shutdownListeners.add(listener); return () => { shutdownListeners.delete(listener) } }
export function cancelDraftShutdown() { quitting = false; for (const listener of shutdownListeners) listener() }
const empty = (): DraftState => ({ text: '', loaded: false, saving: false, version: 0, conflict: false })
const pathsOf = (value: ComposerValue | Saved) => desktopAttachmentPathsOf(value as DesktopAttachmentFields)
const same = (a: ComposerValue | Saved, b: ComposerValue | Saved) => a.text === b.text && JSON.stringify(pathsOf(a)) === JSON.stringify(pathsOf(b)) && JSON.stringify(a.coworkerMentions ?? []) === JSON.stringify(b.coworkerMentions ?? [])
const url = (r: Record) => `/api/desktop/agents/${encodeURIComponent(r.agentId)}/draft`
function publish(r: Record, patch: Partial<DraftState>) {
    r.state = { ...r.state, ...patch }
    for (const listener of r.listeners) listener()
}
function fail(r: Record, error: unknown) {
    if (!r.forgotten) publish(r, { saving: false, error: error instanceof Error ? error.message : 'Could not save this draft. Try again.' })
}

export function desktopDraftRecord(agentId: string, uid: string) {
    const key = JSON.stringify([agentId, uid])
    let record = records.get(key)
    if (!record) {
        record = { agentId, uid, state: empty(), saved: { revision: 0, text: '' }, dirty: false, forgotten: false, listeners: new Set() }
        records.set(key, record)
    }
    return record
}

async function read(r: Record) {
    await pendingTabWrite(r.agentId)
    if (r.forgotten) return
    const response = await fetch(`${url(r)}?${new URLSearchParams({ tabUid: r.uid })}`, { cache: 'no-store' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || 'Could not restore this draft. Try again.')
    const saved = savedSchema.parse(body.draft)
    if (r.forgotten) return
    r.saved = saved
    // A local edit made while restoring is newer than the read, even if its text is empty.
    const fields = desktopAttachmentFieldsOf(pathsOf(saved))
    publish(r, r.dirty
        ? { loaded: true, error: undefined, conflict: false }
        : { text: saved.text, coworkerMentions: saved.coworkerMentions, ...fields, attachmentPath: fields.attachmentPath, attachmentPaths: fields.attachmentPaths, attachmentItems: fields.attachmentItems, loaded: true, error: undefined, conflict: false })
}

async function drain(r: Record) {
    if (!r.state.loaded) await read(r)
    while (!r.forgotten && r.dirty && !r.state.conflict) {
        await pendingTabWrite(r.agentId)
        if (r.forgotten) return
        const version = r.state.version
        const attempt = r.attempt ?? { tabUid: r.uid, baseRevision: r.saved.revision, requestId: crypto.randomUUID(), text: r.state.text, ...desktopCoworkerMentionFieldsOf(r.state.coworkerMentions), ...desktopAttachmentFieldsOf(pathsOf(r.state)) }
        r.attempt = attempt
        publish(r, { saving: true, error: undefined, attachmentRejected: false })
        const response = await fetch(url(r), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(attempt) })
        const body = await response.json()
        if (r.forgotten) return
        if (!response.ok && body.code === 'draft_attachment_rejected') {
            // This typed refusal is issued before acceptance. Other HTTP errors (including
            // a lost/invalid response) must retain the immutable attempt for exact replay.
            r.attempt = undefined
            publish(r, { saving: false, attachmentRejected: true, error: body.error || 'Remove or replace the unavailable attachment, then try again.' })
            return
        }
        if (response.status === 409) {
            r.saved = savedSchema.parse(body.draft)
            r.attempt = undefined
            publish(r, { saving: false, conflict: true, error: 'This draft changed in another view. Choose which version to keep.' })
            return
        }
        if (!response.ok) throw new Error(body.error || 'Could not save this draft. Try again.')
        r.saved = savedSchema.parse(body.draft)
        r.attempt = undefined
        if (r.state.version === version && same(r.state, attempt)) r.dirty = false
        // A replay may acknowledge an operation followed by another writer. Never overwrite it.
        if (!same(r.saved, attempt)) {
            r.dirty = true
            publish(r, { saving: false, conflict: true, error: 'This draft changed in another view. Choose which version to keep.' })
            return
        }
        publish(r, { saving: r.dirty, error: undefined })
    }
}

export function saveDesktopDraft(r: Record): Promise<void> {
    if (r.forgotten || r.state.conflict) return Promise.resolve()
    if (r.work) return r.work
    const work = drain(r).catch(error => fail(r, error))
    r.work = work
    void work.finally(() => {
        if (r.work !== work) return
        r.work = undefined
        // An edit can arrive in the microtask between the final ACK and this cleanup.
        if (!r.forgotten && r.dirty && !r.state.error && !r.state.conflict) void saveDesktopDraft(r)
    })
    return work
}

export function updateDesktopDraft(r: Record, value: ComposerValue) {
    value = { ...value, coworkerMentions: value.coworkerMentions ?? reconcileDesktopCoworkerMentions(r.state.text, value.text, r.state.coworkerMentions ?? []) }
    if (r.forgotten || same(r.state, value)) return
    r.dirty = true
    const fields = desktopAttachmentFieldsOf(pathsOf(value))
    const correctedAttachments = r.state.attachmentRejected && JSON.stringify(pathsOf(r.state)) !== JSON.stringify(pathsOf(value))
    publish(r, { text: value.text, coworkerMentions: value.coworkerMentions, ...fields, attachmentPath: fields.attachmentPath, attachmentPaths: fields.attachmentPaths, attachmentItems: fields.attachmentItems, version: r.state.version + 1, saving: true,
        ...(correctedAttachments && { error: undefined, attachmentRejected: false }) })
    if (!r.state.error) void saveDesktopDraft(r)
}

export function clearDesktopDraft(r: Record, version: number) {
    if (r.state.version !== version || r.forgotten) return false
    updateDesktopDraft(r, { text: '' })
    return true
}

export async function reloadDesktopDraft(r: Record) {
    await r.work
    r.attempt = undefined
    r.dirty = false
    publish(r, { loaded: false, error: undefined, conflict: false, attachmentRejected: false })
    await saveDesktopDraft(r)
}

export function invalidateDesktopDraft(r: Record, error: string) {
    publish(r, { loaded: false, saving: false, error })
}

export async function keepDesktopDraft(r: Record) {
    await r.work
    // Refresh the comparison revision before an explicit choice to replace the saved version.
    r.attempt = undefined
    r.dirty = true
    publish(r, { loaded: false, error: undefined, conflict: false, attachmentRejected: false })
    await saveDesktopDraft(r)
}

export function forgetDesktopDraft(agentId: string, uid: string) {
    const key = JSON.stringify([agentId, uid]), r = records.get(key)
    if (!r) return
    r.forgotten = true
    records.delete(key)
}

export function forgetCoworkerDrafts(agentId: string) {
    for (const r of records.values()) if (r.agentId === agentId) forgetDesktopDraft(agentId, r.uid)
}

// Quit waits for acceptance bookkeeping as well as writes, so a sent draft cannot reappear
// merely because services stopped between its admission receipt and its clear operation.
export function holdDraftAdmission() {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    admissions.add(pending)
    return () => { admissions.delete(pending); release() }
}

export async function flushDesktopDrafts(): Promise<boolean> {
    quitting = true
    for (const listener of shutdownListeners) listener()
    while (true) {
        await Promise.all([...admissions])
        await flushTabWrites()
        const current = [...records.values()].filter(r => !r.forgotten)
        await Promise.all(current.map(r => r.work ?? (r.dirty && !r.state.error ? saveDesktopDraft(r) : Promise.resolve())))
        if (admissions.size) continue
        const latest = [...records.values()].filter(r => !r.forgotten)
        if (latest.some(r => r.work)) continue
        if (latest.some(r => r.state.error || r.state.conflict || r.dirty)) return false
        return true
    }
}
