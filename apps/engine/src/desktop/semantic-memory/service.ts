import {
    DESKTOP_SEMANTIC_BATCH_MAX,
    DESKTOP_SEMANTIC_DEADLINE_MS,
    DESKTOP_SEMANTIC_DETAIL,
    DESKTOP_SEMANTIC_NOTE_MAX,
    DESKTOP_SEMANTIC_NOTES_MAX,
    DESKTOP_SEMANTIC_PENDING_MAX,
    DESKTOP_SEMANTIC_RETRIES_MAX,
    desktopSemanticIndexStatusSchema,
    desktopSemanticRecallRequestSchema,
    desktopSemanticRecallResultSchema,
    type DesktopSemanticBackendIdentity,
    type DesktopSemanticCanonicalNote,
    type DesktopSemanticEmbeddingPort,
    type DesktopSemanticIndexStatus,
    type DesktopSemanticIndexStore,
    type DesktopSemanticMutationResult,
    type DesktopSemanticNotesPort,
    type DesktopSemanticOwnerIndex,
    type DesktopSemanticOwnerPort,
    type DesktopSemanticPendingWork,
    type DesktopSemanticRecallRequest,
    type DesktopSemanticRecallResult,
    type DesktopSemanticReinforceMode,
} from '@rerun/contracts'
import { desktopSemanticBackendFingerprint, desktopSemanticContentFingerprint, desktopSemanticLocalId } from './identity.js'
import { copyDesktopSemanticOwnerIndex, DesktopSemanticStorageError, emptyDesktopSemanticOwnerIndex } from './index-store.js'
import { rankDesktopSemanticNotes } from './recall.js'
import { desktopSemanticCosine, desktopSemanticVector } from './vectors.js'

export class DesktopSemanticRequestError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DesktopSemanticRequestError'
    }
}

export type DesktopSemanticMemoryDeps = {
    owners: DesktopSemanticOwnerPort
    notes: DesktopSemanticNotesPort
    embedding: DesktopSemanticEmbeddingPort
    store: DesktopSemanticIndexStore
    // Root applies full or touch to the existing memory index. Panel searches pass none and never call this.
    onReinforce?: (localAgentId: string, noteIds: readonly string[], mode: Exclude<DesktopSemanticReinforceMode, 'none'>) => Promise<void>
}

type PreparedNotes = { notes: DesktopSemanticCanonicalNote[]; omitted: number }
type Snapshot = { job: DesktopSemanticPendingWork; content: string }

function unavailable(detail: string): DesktopSemanticRecallResult {
    return desktopSemanticRecallResultSchema.parse({
        mode: 'unavailable',
        detail,
        memories: [],
        index: { mode: 'unavailable', backend: null, indexed: 0, pending: 0, omitted: 0, detail },
    })
}

function prepareNotes(notes: readonly DesktopSemanticCanonicalNote[]): PreparedNotes {
    const sorted = notes.filter(note => desktopSemanticLocalId(note.id)).sort((left, right) => left.id.localeCompare(right.id))
    const usable = sorted.filter(note => note.content.length >= 1 && note.content.length <= DESKTOP_SEMANTIC_NOTE_MAX)
    return {
        notes: usable.slice(0, DESKTOP_SEMANTIC_NOTES_MAX),
        omitted: sorted.length - Math.min(usable.length, DESKTOP_SEMANTIC_NOTES_MAX),
    }
}

export function createDesktopSemanticMemory(deps: DesktopSemanticMemoryDeps) {
    const chains = new Map<string, Promise<unknown>>()
    const controllers = new Map<string, AbortController>()
    const draining = new Set<string>()
    const again = new Set<string>()
    const inflight = new Set<Promise<void>>()
    const storageLimited = new Set<string>()
    let closed = false

    function lock<T>(ownerId: string, work: () => Promise<T>): Promise<T> {
        const previous = chains.get(ownerId) ?? Promise.resolve()
        const next = previous.then(work, work)
        chains.set(ownerId, next.then(() => undefined, () => undefined))
        return next
    }

    async function readIndex(ownerId: string): Promise<DesktopSemanticOwnerIndex> {
        return copyDesktopSemanticOwnerIndex(await deps.store.read(ownerId) ?? emptyDesktopSemanticOwnerIndex())
    }

    async function safeWrite(ownerId: string, index: DesktopSemanticOwnerIndex): Promise<boolean> {
        try {
            await deps.store.write(ownerId, index)
            storageLimited.delete(ownerId)
            return true
        } catch (error) {
            if (error instanceof DesktopSemanticStorageError) {
                storageLimited.add(ownerId)
                return false
            }
            throw error
        }
    }

    async function currentOwner(ownerId: string): Promise<boolean> {
        if (!desktopSemanticLocalId(ownerId) || closed) return false
        const owner = await deps.owners.requireCurrentOwner(ownerId)
        return owner?.localAgentId === ownerId
    }

    function track(work: Promise<void>) {
        inflight.add(work)
        void work.finally(() => inflight.delete(work))
    }

    function kick(ownerId: string) {
        if (closed) return
        if (draining.has(ownerId)) {
            again.add(ownerId)
            return
        }
        track(drain(ownerId))
    }

    async function takeBatch(ownerId: string): Promise<Snapshot[]> {
        const identity = deps.embedding.identity()
        if (!identity) return []
        const index = await readIndex(ownerId)
        if (index.invalid) return []
        const backend = desktopSemanticBackendFingerprint(identity)
        const generation = await deps.notes.generation(ownerId)
        const ready: Snapshot[] = []
        const pending: DesktopSemanticPendingWork[] = []
        for (const job of index.pending) {
            const note = job.revoke === index.revoke ? await deps.notes.readNote(ownerId, job.noteId) : null
            if (!note || desktopSemanticContentFingerprint(note.content) !== job.contentFingerprint || generation !== job.generation || job.backendFingerprint !== backend) continue
            if (job.attempts >= DESKTOP_SEMANTIC_RETRIES_MAX || ready.length >= DESKTOP_SEMANTIC_BATCH_MAX) pending.push(job)
            else ready.push({ job, content: note.content })
        }
        if (pending.length + ready.length !== index.pending.length) {
            index.pending = [...pending, ...ready.map(item => item.job)]
            await safeWrite(ownerId, index)
        }
        return ready
    }

    async function publishBatch(ownerId: string, batch: Snapshot[], embedded: Awaited<ReturnType<DesktopSemanticEmbeddingPort['embed']>>, revoke: number, signal: AbortSignal) {
        if (closed || signal.aborted) return
        const index = await readIndex(ownerId)
        if (index.revoke !== revoke) return
        if (!embedded.ok) {
            for (const item of batch) {
                const job = index.pending.find(candidate => candidate.noteId === item.job.noteId && candidate.contentFingerprint === item.job.contentFingerprint && candidate.revoke === item.job.revoke)
                if (job) job.attempts += 1
            }
            await safeWrite(ownerId, index)
            return
        }
        const identity = deps.embedding.identity()
        if (!identity || desktopSemanticBackendFingerprint(identity) !== desktopSemanticBackendFingerprint(embedded.identity)) {
            for (const item of batch) {
                const job = index.pending.find(candidate => candidate.noteId === item.job.noteId && candidate.contentFingerprint === item.job.contentFingerprint && candidate.revoke === item.job.revoke)
                if (job) job.attempts += 1
            }
            await safeWrite(ownerId, index)
            return
        }
        const generation = await deps.notes.generation(ownerId)
        for (let indexInBatch = 0; indexInBatch < batch.length; indexInBatch += 1) {
            if (closed || signal.aborted) return
            const item = batch[indexInBatch]
            if (!item) continue
            const note = await deps.notes.readNote(ownerId, item.job.noteId)
            const fresh = await readIndex(ownerId)
            if (closed || signal.aborted || fresh.revoke !== revoke || generation !== await deps.notes.generation(ownerId)) return
            const fingerprint = note ? desktopSemanticContentFingerprint(note.content) : ''
            const vector = desktopSemanticVector(embedded.vectors[indexInBatch], identity.dimensions)
            const matches = note !== null && note.id === item.job.noteId && fingerprint === item.job.contentFingerprint && item.job.generation === generation && vector !== null
            if (!matches || !vector || !note) {
                fresh.pending = fresh.pending.filter(candidate => !(candidate.noteId === item.job.noteId && candidate.contentFingerprint === item.job.contentFingerprint && candidate.revoke === revoke))
                await safeWrite(ownerId, fresh)
                continue
            }
            fresh.records = fresh.records.filter(record => record.noteId !== note.id)
            fresh.records.push({
                noteId: note.id,
                contentFingerprint: fingerprint,
                backendFingerprint: desktopSemanticBackendFingerprint(identity),
                dimensions: identity.dimensions,
                vector,
            })
            fresh.pending = fresh.pending.filter(candidate => candidate.noteId !== note.id)
            fresh.generation = generation
            if (!await safeWrite(ownerId, fresh)) return
        }
    }

    async function drain(ownerId: string): Promise<void> {
        if (closed || draining.has(ownerId)) return
        draining.add(ownerId)
        const controller = new AbortController()
        controllers.set(ownerId, controller)
        try {
            while (!closed && !controller.signal.aborted) {
                const batch = await lock(ownerId, () => takeBatch(ownerId))
                if (!batch.length || closed || controller.signal.aborted) break
                const embedded = await deps.embedding.embed(batch.map(item => item.content), controller.signal, DESKTOP_SEMANTIC_DEADLINE_MS)
                await lock(ownerId, () => publishBatch(ownerId, batch, embedded, batch[0]?.job.revoke ?? -1, controller.signal))
                if (!embedded.ok) break
            }
        } catch {
            // Leave the pending rows. A failed embed does not roll back the canonical note.
        } finally {
            if (controllers.get(ownerId) === controller) controllers.delete(ownerId)
            draining.delete(ownerId)
            if (again.delete(ownerId) && !closed) track(drain(ownerId))
        }
    }

    async function schedule(ownerId: string, noteId: string): Promise<DesktopSemanticMutationResult> {
        return lock(ownerId, async () => {
            if (closed) return { accepted: false, reason: 'cancelled' }
            if (!await currentOwner(ownerId) || !desktopSemanticLocalId(noteId)) return { accepted: false, reason: 'owner' }
            const note = await deps.notes.readNote(ownerId, noteId)
            if (!note || note.id !== noteId) return { accepted: false, reason: 'missing' }
            if (note.content.length < 1 || note.content.length > DESKTOP_SEMANTIC_NOTE_MAX) return { accepted: false, reason: 'bounds' }
            const identity = deps.embedding.identity()
            if (!identity) return { accepted: false, reason: 'unconfigured' }
            const fingerprint = desktopSemanticContentFingerprint(note.content)
            const backend = desktopSemanticBackendFingerprint(identity)
            const generation = await deps.notes.generation(ownerId)
            const index = await readIndex(ownerId)
            const current = index.records.some(record => record.noteId === noteId && record.contentFingerprint === fingerprint && record.backendFingerprint === backend && record.dimensions === identity.dimensions)
            index.pending = index.pending.filter(job => job.noteId !== noteId)
            if (!current) {
                if (index.pending.length >= DESKTOP_SEMANTIC_PENDING_MAX) return { accepted: false, reason: 'pending-full' }
                index.pending.push({ noteId, contentFingerprint: fingerprint, generation, revoke: index.revoke, attempts: 0, backendFingerprint: backend })
            }
            index.generation = generation
            if (!await safeWrite(ownerId, index)) return { accepted: false, reason: 'bounds' }
            return { accepted: true, reason: current ? 'current' : 'queued' }
        })
    }

    function usableRecords(index: DesktopSemanticOwnerIndex, identity: DesktopSemanticBackendIdentity, notes: readonly DesktopSemanticCanonicalNote[]) {
        const backend = desktopSemanticBackendFingerprint(identity)
        const fingerprints = new Map(notes.map(note => [note.id, desktopSemanticContentFingerprint(note.content)]))
        return index.records.filter(record => fingerprints.get(record.noteId) === record.contentFingerprint && record.backendFingerprint === backend && record.dimensions === identity.dimensions && desktopSemanticVector(record.vector, identity.dimensions))
    }

    async function statusOf(ownerId: string, prepared: PreparedNotes, index: DesktopSemanticOwnerIndex): Promise<DesktopSemanticIndexStatus> {
        const identity = deps.embedding.identity()
        const pending = Math.min(index.pending.length, DESKTOP_SEMANTIC_PENDING_MAX)
        const omitted = prepared.omitted
        if (index.invalid) {
            return desktopSemanticIndexStatusSchema.parse({ mode: 'invalid', backend: identity, indexed: 0, pending, omitted, detail: DESKTOP_SEMANTIC_DETAIL.invalid })
        }
        if (!identity) {
            return desktopSemanticIndexStatusSchema.parse({ mode: 'keyword-only', backend: null, indexed: 0, pending, omitted, detail: DESKTOP_SEMANTIC_DETAIL.unconfigured })
        }
        const usable = usableRecords(index, identity, prepared.notes)
        const staleBackend = usable.length === 0 && index.records.some(record => record.backendFingerprint !== desktopSemanticBackendFingerprint(identity))
        const detail = storageLimited.has(ownerId) ? DESKTOP_SEMANTIC_DETAIL.storage : staleBackend ? DESKTOP_SEMANTIC_DETAIL.changed : usable.length === 0 && pending > 0 ? DESKTOP_SEMANTIC_DETAIL.pending : usable.length === 0 ? DESKTOP_SEMANTIC_DETAIL.empty : usable.length < prepared.notes.length || pending > 0 || omitted > 0 ? DESKTOP_SEMANTIC_DETAIL.partial : DESKTOP_SEMANTIC_DETAIL.semantic
        const mode = usable.length === 0 && pending > 0 ? 'rebuilding' : usable.length === 0 ? 'keyword-only' : usable.length < prepared.notes.length || pending > 0 || omitted > 0 ? 'partial' : 'ready'
        return desktopSemanticIndexStatusSchema.parse({ mode, backend: identity, indexed: Math.min(usable.length, DESKTOP_SEMANTIC_NOTES_MAX), pending, omitted, detail })
    }

    async function rebuild(ownerId: string, resetAttempts: boolean): Promise<DesktopSemanticMutationResult> {
        const result = await lock(ownerId, async () => {
            if (closed) return { accepted: false, reason: 'cancelled' as const }
            if (!await currentOwner(ownerId)) return { accepted: false, reason: 'owner' as const }
            const prepared = prepareNotes(await deps.notes.listNotes(ownerId))
            const generation = await deps.notes.generation(ownerId)
            const identity = deps.embedding.identity()
            const index = await readIndex(ownerId)
            const backend = identity ? desktopSemanticBackendFingerprint(identity) : ''
            const live = new Map(prepared.notes.map(note => [note.id, desktopSemanticContentFingerprint(note.content)]))
            index.records = identity ? index.records.filter(record => live.get(record.noteId) === record.contentFingerprint && record.backendFingerprint === backend && record.dimensions === identity.dimensions && desktopSemanticVector(record.vector, identity.dimensions)) : []
            index.pending = index.pending.flatMap(job => {
                if (live.get(job.noteId) !== job.contentFingerprint || job.generation !== generation || job.revoke !== index.revoke || job.backendFingerprint !== backend) return []
                return [resetAttempts ? { ...job, attempts: 0 } : job]
            })
            if (identity) {
                for (const note of prepared.notes) {
                    const fingerprint = live.get(note.id)
                    if (!fingerprint) continue
                    const recorded = index.records.some(record => record.noteId === note.id && record.contentFingerprint === fingerprint)
                    const queued = index.pending.some(job => job.noteId === note.id && job.contentFingerprint === fingerprint)
                    if (recorded || queued || index.pending.length >= DESKTOP_SEMANTIC_PENDING_MAX) continue
                    index.pending.push({ noteId: note.id, contentFingerprint: fingerprint, generation, revoke: index.revoke, attempts: 0, backendFingerprint: backend })
                }
            }
            index.generation = generation
            index.invalid = false
            if (!await safeWrite(ownerId, index)) return { accepted: false, reason: 'bounds' as const }
            return { accepted: true, reason: identity && index.pending.length > 0 ? 'queued' as const : 'current' as const }
        })
        if (result.reason === 'queued') kick(ownerId)
        return result
    }

    return {
        async recall(localAgentId: string, input: unknown): Promise<DesktopSemanticRecallResult> {
            const parsed = desktopSemanticRecallRequestSchema.safeParse(input)
            if (!parsed.success) throw new DesktopSemanticRequestError('Enter a search query and a valid result limit.')
            const request: DesktopSemanticRecallRequest = parsed.data
            if (!await currentOwner(localAgentId)) return unavailable(DESKTOP_SEMANTIC_DETAIL.owner)
            try {
                const prepared = prepareNotes(await deps.notes.listNotes(localAgentId))
                const index = await readIndex(localAgentId)
                const identity = deps.embedding.identity()
                const status = await statusOf(localAgentId, prepared, index)
                const usable = identity && !index.invalid ? usableRecords(index, identity, prepared.notes) : []
                const foreignBackend = identity ? index.records.some(record => record.backendFingerprint !== desktopSemanticBackendFingerprint(identity)) : false
                let mode: DesktopSemanticRecallResult['mode'] = 'keyword-only'
                let detail: string = !identity ? DESKTOP_SEMANTIC_DETAIL.unconfigured : index.invalid ? DESKTOP_SEMANTIC_DETAIL.invalid : usable.length === 0 && foreignBackend ? DESKTOP_SEMANTIC_DETAIL.changed : usable.length === 0 && index.pending.length > 0 ? DESKTOP_SEMANTIC_DETAIL.pending : DESKTOP_SEMANTIC_DETAIL.empty
                const similarities = new Map<string, number>()
                if (identity && !index.invalid && usable.length > 0) {
                    const controller = new AbortController()
                    const embedded = await deps.embedding.embed([request.query], controller.signal, DESKTOP_SEMANTIC_DEADLINE_MS)
                    if (!embedded.ok) detail = DESKTOP_SEMANTIC_DETAIL[embedded.reason]
                    else {
                        const queryVector = desktopSemanticVector(embedded.vectors[0], identity.dimensions)
                        if (!queryVector) detail = DESKTOP_SEMANTIC_DETAIL.invalid
                        else {
                            for (const record of usable) {
                                const similarity = desktopSemanticCosine(queryVector, record.vector)
                                if (similarity !== null) similarities.set(record.noteId, similarity)
                            }
                            const covered = prepared.notes.every(note => usable.some(record => record.noteId === note.id))
                            mode = covered && prepared.omitted === 0 ? 'semantic' : 'partial'
                            detail = mode === 'semantic' ? DESKTOP_SEMANTIC_DETAIL.semantic : DESKTOP_SEMANTIC_DETAIL.partial
                        }
                    }
                }
                const ranked = rankDesktopSemanticNotes(prepared.notes, similarities, request.query, request.limit, request.includeDormant)
                const memories = []
                for (const hit of ranked) {
                    const current = await deps.notes.readNote(localAgentId, hit.id)
                    if (!current || current.id !== hit.id || current.content !== hit.content) continue
                    memories.push({ ...hit, tags: [...current.tags] })
                }
                if (request.reinforce !== 'none' && memories.length > 0) {
                    if (!deps.onReinforce) detail = 'Matches are shown. Reinforcement was not applied.'
                    else {
                        try { await deps.onReinforce(localAgentId, memories.map(memory => memory.id), request.reinforce) }
                        catch { detail = 'Matches are shown. Reinforcement was not applied.' }
                    }
                }
                return desktopSemanticRecallResultSchema.parse({ mode, detail, memories, index: status })
            } catch (error) {
                if (error instanceof DesktopSemanticRequestError) throw error
                return unavailable(DESKTOP_SEMANTIC_DETAIL.unavailable)
            }
        },
        async status(localAgentId: string): Promise<DesktopSemanticIndexStatus> {
            if (!await currentOwner(localAgentId)) return unavailable(DESKTOP_SEMANTIC_DETAIL.owner).index
            try {
                const prepared = prepareNotes(await deps.notes.listNotes(localAgentId))
                return statusOf(localAgentId, prepared, await readIndex(localAgentId))
            } catch {
                return unavailable(DESKTOP_SEMANTIC_DETAIL.unavailable).index
            }
        },
        async noteAdded(localAgentId: string, noteId: string) {
            const result = await schedule(localAgentId, noteId)
            if (result.reason === 'queued') kick(localAgentId)
            return result
        },
        async noteUpdated(localAgentId: string, noteId: string) {
            const result = await schedule(localAgentId, noteId)
            if (result.reason === 'queued') kick(localAgentId)
            return result
        },
        async noteDeleted(localAgentId: string, noteId: string): Promise<DesktopSemanticMutationResult> {
            controllers.get(localAgentId)?.abort()
            return lock(localAgentId, async () => {
                if (!await currentOwner(localAgentId)) return { accepted: false, reason: 'owner' }
                const index = await readIndex(localAgentId)
                index.revoke += 1
                index.records = index.records.filter(record => record.noteId !== noteId)
                index.pending = index.pending.filter(job => job.noteId !== noteId)
                if (!await safeWrite(localAgentId, index)) return { accepted: false, reason: 'bounds' }
                return { accepted: true, reason: 'deleted' }
            })
        },
        async notesCleared(localAgentId: string): Promise<DesktopSemanticMutationResult> {
            controllers.get(localAgentId)?.abort()
            return lock(localAgentId, async () => {
                if (!await currentOwner(localAgentId)) return { accepted: false, reason: 'owner' }
                const previous = await readIndex(localAgentId)
                const next = emptyDesktopSemanticOwnerIndex()
                next.revoke = previous.revoke + 1
                next.generation = await deps.notes.generation(localAgentId)
                if (!await safeWrite(localAgentId, next)) return { accepted: false, reason: 'bounds' }
                return { accepted: true, reason: 'cleared' }
            })
        },
        reconcile(localAgentId: string) {
            return rebuild(localAgentId, false)
        },
        retry(localAgentId: string) {
            return rebuild(localAgentId, true)
        },
        async cancel(localAgentId: string): Promise<DesktopSemanticMutationResult> {
            controllers.get(localAgentId)?.abort()
            return lock(localAgentId, async () => {
                if (!await currentOwner(localAgentId)) return { accepted: false, reason: 'owner' }
                const index = await readIndex(localAgentId)
                index.revoke += 1
                if (!await safeWrite(localAgentId, index)) return { accepted: false, reason: 'bounds' }
                return { accepted: true, reason: 'cancelled' }
            })
        },
        async shutdown() {
            closed = true
            for (const controller of controllers.values()) controller.abort()
            for (const ownerId of await deps.store.listOwnerIds()) {
                await lock(ownerId, async () => {
                    const index = await readIndex(ownerId)
                    index.revoke += 1
                    await safeWrite(ownerId, index)
                })
            }
            await Promise.all([...chains.values()])
        },
        async settled() {
            for (let attempt = 0; attempt < 8; attempt += 1) {
                const pending = [...inflight, ...chains.values()]
                if (pending.length === 0 && draining.size === 0) return
                await Promise.all(pending)
            }
        },
    }
}
