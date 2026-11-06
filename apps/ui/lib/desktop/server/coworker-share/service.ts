import 'server-only'
import { createHash } from 'node:crypto'
import { readPortableArchive, type PortablePackageMemberBytes } from '../../../../../engine/src/desktop/templates/portable-package'
import { createDesktopCoworkerSharePlan, createDesktopCoworkerSnapshot } from '../../../../../engine/src/desktop/coworker-share/snapshot'
import { desktopCoworkerShareExportInputSchema, desktopCoworkerShareImportInputSchema, desktopCoworkerShareReviewInputSchema, desktopCoworkerShareRevokeInputSchema, desktopCoworkerShareSourceSchema, type DesktopCoworkerShareSource, type DesktopCoworkerSnapshotManifest } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import type { DesktopCoworkerShareStore } from './store'

export type DesktopCoworkerShareInstallAuthority = {
    unavailable?: { memories?: string; database?: string; files?: string }
    /** Root binds the canonical template installer; this exact request must remain idempotent. */
    install(input: { manifest: DesktopCoworkerSnapshotManifest; members: PortablePackageMemberBytes[]; targetWorkspaceId: number; requestId: string; archiveBytes: Buffer }): Promise<string>
    recoverImport?: (input: { snapshotId: string; targetWorkspaceId: number; requestId: string }) => Promise<string>
    assertCurrent?: (input: { operation: 'read' | 'export' | 'import' | 'revoke'; workspaceId?: number; agentId?: string }) => Promise<void>
}
type Snapshot = Awaited<ReturnType<typeof createDesktopCoworkerSnapshot>>
const REVIEW_LIMITS = { maxEntries: 8, maxBytes: 320 * 1024 * 1024, ttlMs: 10 * 60 * 1000 }
type ReviewLimits = typeof REVIEW_LIMITS
type Review = { work: Promise<Snapshot>; bytes: number; users: number; expiresAt: number; timer?: ReturnType<typeof setTimeout> }
type ShareState = { reviews: Map<string, Review>; imports: Map<string,Promise<{ status: 'imported' | 'uncertain'; importedAgentId?: string; recoverable?: true; reason?: string }>> }
const STATE = Symbol.for('rerun.desktop.coworker-share.service.v2')
const states = () => ((globalThis as unknown as Record<symbol, WeakMap<object, ShareState>>)[STATE] ??= new WeakMap())
const unknown = () => ({ status: 'uncertain' as const, recoverable: true as const, reason: 'Import acknowledgement is unknown. Retry the original saved attempt; no rollback is claimed.' })

export function createDesktopCoworkerShareService(store: DesktopCoworkerShareStore, authority: DesktopCoworkerShareInstallAuthority, options: { reviewLimits?: Partial<ReviewLimits> } = {}) {
    const limits = { ...REVIEW_LIMITS, ...options.reviewLimits }
    for (const key of ['maxEntries','maxBytes','ttlMs'] as const) if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > REVIEW_LIMITS[key]) throw new Error('Invalid share review retention limit.')
    const state: ShareState = states().get(store.coordinationKey) ?? { reviews: new Map(), imports: new Map() }
    states().set(store.coordinationKey,state)
    const reviews = state.reviews
    const dropReview = (id: string, review: Review) => {
        if (reviews.get(id) !== review) return
        reviews.delete(id)
        if (review.timer) clearTimeout(review.timer)
    }
    const expireReview = (id: string, review: Review) => {
        if (reviews.get(id) !== review || review.users > 0) return
        if (review.expiresAt <= Date.now()) { dropReview(id,review); return }
        if (review.timer) clearTimeout(review.timer)
        review.timer = setTimeout(() => expireReview(id,review),review.expiresAt - Date.now())
        review.timer.unref?.()
    }
    const pruneReviews = () => { for (const [id,review] of reviews) if (review.users === 0 && review.expiresAt <= Date.now()) dropReview(id,review) }
    const retainedBytes = () => [...reviews.values()].reduce((total,review) => total + review.bytes,0)
    const newReview = (id: string, source: DesktopCoworkerShareSource, include: Parameters<typeof createDesktopCoworkerSnapshot>[1], workspaceId: number): Review => {
        pruneReviews()
        // Reserve the build's source/copy/archive allowance before starting another pack.
        // Completed reviews are never evicted to admit new work; the user can export them
        // or review again after expiry. Active exports keep their exact bytes pinned.
        const sourceBytes = source.members.reduce((total,member) => total + member.bytes.byteLength,0)
        const metadataBytes = Buffer.byteLength(JSON.stringify({ ...source,members: source.members.map(({ bytes, ...member }) => ({ ...member,bytes: bytes.byteLength })) }))
        const reserved = 2 * (sourceBytes + metadataBytes + source.members.length * 2048) + 1024
        if (reserved > limits.maxBytes) throw new DesktopHttpError(413,'This coworker is too large to keep safely for review. Choose fewer files.')
        if (reviews.size >= limits.maxEntries || retainedBytes() + reserved > limits.maxBytes) throw new DesktopHttpError(409,'Finish an open share review before starting another, or review again after it expires.')
        const work = Promise.resolve().then(() => createDesktopCoworkerSnapshot(source,include,workspaceId)).then(snapshot => {
            const bytes = snapshot.archiveBytes.byteLength + snapshot.members.reduce((total,member) => total + member.bytes.byteLength,0) + Buffer.byteLength(JSON.stringify(snapshot.manifest))
            if (bytes > limits.maxBytes || retainedBytes() - review.bytes + bytes > limits.maxBytes) throw new DesktopHttpError(413,'This coworker is too large to keep safely for review. Choose fewer files.')
            review.bytes = bytes
            return snapshot
        })
        const review: Review = { work,bytes: reserved,users: 1,expiresAt: Date.now() + limits.ttlMs }
        reviews.set(id,review)
        void work.catch(() => dropReview(id,review)).finally(() => { review.users--; expireReview(id,review) })
        return review
    }
    const reviewIdOf = (input: { workspaceId: number; agentId: string; sourceRevision: string; include: unknown }) => createHash('sha256').update(JSON.stringify([input.workspaceId,input.agentId,input.sourceRevision,input.include])).digest('hex')
    const guard = (operation: 'read' | 'export' | 'import' | 'revoke', workspaceId?: number, agentId?: string) => authority.assertCurrent?.({ operation, workspaceId, agentId }) ?? Promise.resolve()
    const summary = (snapshot: Snapshot, reused: boolean) => ({ manifest: snapshot.manifest, archiveSha256: snapshot.archiveSha256, archiveBytes: snapshot.archiveBytes.length, reused })
    const saved = async (snapshotId: string): Promise<Snapshot | null> => {
        const manifest = await store.readManifest(snapshotId)
        if (!manifest) return null
        const archive = await store.readArchive(snapshotId)
        const restored = await readPortableArchive(archive.bytes)
        if (restored.manifest.packageKey !== snapshotId || restored.manifest.contentDigest !== manifest.contentDigest) throw new DesktopHttpError(503,'The saved share bytes do not match their manifest.')
        return { ...restored, archiveBytes: archive.bytes, archiveSha256: archive.sha256 }
    }
    const sourceOf = async (source: DesktopCoworkerShareSource | (() => Promise<DesktopCoworkerShareSource>), input: { workspaceId: number; agentId: string; sourceRevision: string }) => {
        const current = desktopCoworkerShareSourceSchema.parse(typeof source === 'function' ? await source() : source)
        if (current.workspaceId !== input.workspaceId || current.agentId !== input.agentId || current.revision !== input.sourceRevision) throw new DesktopHttpError(409,'The coworker changed. Review the current content before exporting.')
        return current
    }
    const supported = (include: { memories: boolean; database: boolean; files: boolean }) => {
        for (const key of ['memories','database','files'] as const) if (include[key] && authority.unavailable?.[key]) throw new DesktopHttpError(409,authority.unavailable[key])
    }
    return {
        plan(source: DesktopCoworkerShareSource) { return { ...createDesktopCoworkerSharePlan(desktopCoworkerShareSourceSchema.parse(source)), sourceRevision: source.revision, ...(authority.unavailable ? { unavailable: authority.unavailable } : {}) } },
        async review(raw: unknown, source: DesktopCoworkerShareSource | (() => Promise<DesktopCoworkerShareSource>)) {
            const input = desktopCoworkerShareReviewInputSchema.parse(raw)
            supported(input.include)
            await guard('read',input.workspaceId,input.agentId)
            const current = await sourceOf(source,input), reviewId = reviewIdOf(input)
            const persisted = await saved(reviewId.slice(0,32))
            if (persisted) return { ...summary(persisted,true), reviewId }
            pruneReviews()
            const review = reviews.get(reviewId) ?? newReview(reviewId,current,input.include,input.workspaceId)
            review.users++
            try {
                const snapshot = await review.work
                await guard('read',input.workspaceId,input.agentId)
                return { ...summary(snapshot,false), reviewId }
            } finally { review.users--; expireReview(reviewId,review) }
        },
        async export(raw: unknown, source?: DesktopCoworkerShareSource | (() => Promise<DesktopCoworkerShareSource>)) {
            const input = desktopCoworkerShareExportInputSchema.parse(raw), reviewId = reviewIdOf(input)
            supported(input.include)
            if (input.reviewId !== reviewId) throw new DesktopHttpError(409,'Review the exact current content before exporting.')
            await guard('export',input.workspaceId,input.agentId)
            const existingReceipt = await store.receipt(input.requestId)
            if (existingReceipt && (existingReceipt.operation !== 'export' || existingReceipt.snapshotId !== reviewId.slice(0,32))) throw new DesktopHttpError(409,'This export request was already used for another operation.')
            pruneReviews()
            let review: Review | undefined
            try {
                let snapshot = await saved(reviewId.slice(0,32))
                if (!snapshot) {
                    if (!source) throw new DesktopHttpError(409,'Review the current coworker before exporting.')
                    await sourceOf(source,input)
                    pruneReviews()
                    review = reviews.get(reviewId)
                    if (!review) throw new DesktopHttpError(409,'This uncommitted review expired. Review the current content again.')
                    review.users++
                    snapshot = await review.work
                }
                if (snapshot.manifest.contentDigest !== input.expectedDigest) throw new DesktopHttpError(409,'The archive differs from the reviewed content.')
                if (!existingReceipt && source) await sourceOf(source,input)
                await guard('export',input.workspaceId,input.agentId)
                const result = await store.publishExport(input,snapshot)
                // A durable ACK releases these bytes. A failed or lost ACK keeps the same
                // pending review until its normal expiry; a durable replay reloads saved().
                const released = review ?? reviews.get(reviewId)
                if (released) dropReview(reviewId,released)
                return summary(snapshot,result.reused)
            } finally { if (review) { review.users--; expireReview(reviewId,review) } }
        },
        async preview(snapshotId: string) {
            await guard('read')
            const snapshot = await saved(snapshotId)
            if (!snapshot) throw new DesktopHttpError(404,'Local share not found.')
            await guard('read')
            return snapshot.manifest
        },
        async download(snapshotId: string) {
            await guard('read')
            const snapshot = await saved(snapshotId)
            if (!snapshot) throw new DesktopHttpError(404,'Local share not found.')
            await guard('read')
            return { bytes: snapshot.archiveBytes, sha256: snapshot.archiveSha256 }
        },
        async import(raw: unknown): Promise<{ status: 'imported' | 'uncertain'; importedAgentId?: string; recoverable?: true; reason?: string }> {
            const input = desktopCoworkerShareImportInputSchema.parse(raw)
            await guard('import',input.targetWorkspaceId)
            const snapshot = await saved(input.snapshotId)
            if (!snapshot || snapshot.manifest.contentDigest !== input.expectedDigest) throw new DesktopHttpError(409,'The reviewed share changed or is no longer available.')
            const reservation = await store.reserveImport(input)
            if (reservation.status === 'imported') return { status: 'imported', importedAgentId: reservation.importedAgentId }
            if (reservation.requestId !== input.requestId) return unknown()
            const slot = JSON.stringify([input.snapshotId,input.targetWorkspaceId])
            const inflight = state.imports.get(slot)
            if (inflight) return inflight
            if (!reservation.fresh && !authority.recoverImport) return unknown()
            const work = (async () => {
                try {
                    await guard('import',input.targetWorkspaceId)
                    const importedAgentId = !reservation.fresh && authority.recoverImport
                        ? await authority.recoverImport({ snapshotId: input.snapshotId,targetWorkspaceId: input.targetWorkspaceId,requestId: input.requestId })
                        : await authority.install({ manifest: snapshot.manifest,members: snapshot.members,archiveBytes: snapshot.archiveBytes,targetWorkspaceId: input.targetWorkspaceId,requestId: input.requestId })
                    if (!importedAgentId) throw new Error('No canonical import acknowledgement')
                    await guard('import',input.targetWorkspaceId)
                    const settled = await store.settleImport(input,importedAgentId)
                    return { status: 'imported' as const, importedAgentId: settled.importedAgentId }
                } catch {
                    const settled = await store.uncertainImport(input)
                    return settled.status === 'imported' ? { status: 'imported' as const, importedAgentId: settled.importedAgentId } : unknown()
                }
            })()
            state.imports.set(slot,work)
            void work.finally(() => { if (state.imports.get(slot) === work) state.imports.delete(slot) }).catch(() => {})
            return work
        },
        async revoke(raw: unknown) {
            const input = desktopCoworkerShareRevokeInputSchema.parse(raw)
            await guard('revoke')
            return store.revoke(input.snapshotId,input.expectedRevision,input.requestId)
        },
    }
}
export type DesktopCoworkerShareService = ReturnType<typeof createDesktopCoworkerShareService>
