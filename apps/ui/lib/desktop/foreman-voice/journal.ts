'use client'
import {
    foremanVoicePendingSchema, sameForemanVoiceTarget,
    type ForemanVoicePending, type ForemanVoiceTarget,
} from '@rerun/contracts'
export type PendingAudio = ForemanVoicePending & { blob: Blob | null }
export type ForemanAudioJournal = {
    read(target: ForemanVoiceTarget): Promise<PendingAudio | null>
    put(value: PendingAudio): Promise<void>; clear(attemptId: string): Promise<void>
}
type SavedAudio = PendingAudio & { sha256: string | null }
export function createForemanAudioJournal(): ForemanAudioJournal {
    async function digest(blob: Blob) {
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('')
    }
    async function open() {
        return new Promise<IDBDatabase>((resolve, reject) => {
            let failed = false
            const request = indexedDB.open('rerun-desktop-foreman-voice-pending', 1)
            request.onupgradeneeded = () => { request.result.createObjectStore('attempts', { keyPath: 'attemptId' }) }
            request.onsuccess = () => { if (failed) request.result.close(); else resolve(request.result) }
            request.onerror = () => { failed = true; reject(Error('Local recording storage is unavailable. Keep this view open.')) }
            request.onblocked = () => { failed = true; reject(Error('Close the other recording view before restoring this recording.')) }
        })
    }
    async function transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, complete: (value: T) => void, fail: (e: unknown) => void) => void) {
        const db = await open()
        try {
            return await new Promise<T>((resolve, reject) => {
                const tx = db.transaction('attempts', mode)
                let value: T
                tx.oncomplete = () => resolve(value)
                tx.onerror = () => reject(Error('Local recording was not saved. Keep this view open.'))
                tx.onabort = tx.onerror
                work(tx.objectStore('attempts'), v => { value = v }, e => { tx.abort(); reject(e) })
            })
        } finally { db.close() }
    }
    const metadata = (v: PendingAudio) => ({ target: v.target, attemptId: v.attemptId, format: v.format, durationMs: v.durationMs, levels: v.levels })
    return {
        async read(target) {
            const value = await transaction<SavedAudio | null>('readonly', (s, done, fail) => {
                const r = s.getAll()
                r.onerror = () => fail(r.error)
                r.onsuccess = () => {
                    try {
                        const found = (r.result as SavedAudio[]).find(v => sameForemanVoiceTarget(v.target, target))
                        if (!found) { done(null); return }
                        foremanVoicePendingSchema.parse(metadata(found)); done(found)
                    } catch (e) { fail(e) }
                }
            })
            if (value?.blob && (!(value.blob instanceof Blob) || value.blob.size > 2097152 || !value.sha256 || await digest(value.blob) !== value.sha256)) throw Error('Saved recording bytes changed.')
            return value
        },
        async put(value) {
            foremanVoicePendingSchema.parse(metadata(value))
            if (value.blob && value.blob.size > 2097152) throw Error('Recording exceeds its limit.')
            const sha256 = value.blob ? await digest(value.blob) : null
            return transaction<void>('readwrite', (s, done, fail) => {
                const r = s.getAll()
                r.onsuccess = () => {
                    const rows = r.result as SavedAudio[], old = rows.find(v => v.attemptId === value.attemptId)
                    if (old && (JSON.stringify(metadata(old)) !== JSON.stringify(metadata(value)) || old.sha256 !== sha256)) { fail(Error('Recording identity changed.')); return }
                    if (rows.some(v => v.attemptId !== value.attemptId && sameForemanVoiceTarget(v.target, value.target)) || !old && rows.length >= 8) { fail(Error('Review another saved recording before recording again.')); return }
                    s.put({ ...value, sha256 }); done()
                }
                r.onerror = () => fail(r.error)
            })
        },
        async clear(id) { return transaction<void>('readwrite', (s, done) => { s.delete(id); done() }) },
    }
}
