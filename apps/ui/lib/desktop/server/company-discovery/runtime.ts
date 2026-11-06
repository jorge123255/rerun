import {
    applyCompanyDiscoveryEvent,
    DESKTOP_COMPANY_DISCOVERY_LIMITS,
    companyChatIdSchema,
    companyDiscoveryEventSchema,
    companyDiscoveryIdSchema,
    companyDiscoverySnapshotSchema,
    companyRunIdSchema,
    companyWorkspaceIdSchema,
    emptyCompanyDiscoverySnapshot,
    readCompanyDiscoveryTarget,
    toForemanDiscoveryEvent,
    type CompanyDiscoveryEvent,
    type CompanyDiscoverySource,
    type DesktopCompanyDiscoverySnapshot,
    type DesktopForemanDiscoveryEvent,
} from '@rerun/contracts'
import { CompanyDiscoveryError, type CompanyDiscoveryAuthority, type CompanyDiscoveryOwner, type CompanyDiscoveryRunner } from './authority'
import type { CompanyDiscoveryStore, StoredSnapshot } from './store'

export type CompanyDiscoveryRead =
    | { state: 'present'; snapshot: DesktopCompanyDiscoverySnapshot; owner: CompanyDiscoveryOwner | 'unknown' }
    | { state: 'absent' }
    | { state: 'unknown'; discoveryId: string }

export type CompanyDiscoveryBegin = {
    workspaceId: string
    chatId: string
    runId: string
    discoveryId: string
    url: string
    signal?: AbortSignal
    emitForeman?: (event: DesktopForemanDiscoveryEvent) => void
}

type Deps = {
    store: CompanyDiscoveryStore
    authority: CompanyDiscoveryAuthority | null
    run: CompanyDiscoveryRunner | null
    published?: (snapshot: DesktopCompanyDiscoverySnapshot, signal: AbortSignal) => Promise<void>
    now?: () => Date
}

function present(row: StoredSnapshot | null): DesktopCompanyDiscoverySnapshot | null {
    return row?.state === 'present' ? row.snapshot : null
}

export function createCompanyDiscoveryRuntime(deps: Deps) {
    const now = () => (deps.now ?? (() => new Date()))().toISOString()
    const inflight = new Map<string, Promise<void>>()
    const stops = new Map<string, AbortController>()
    let closed = false

    function assertOpen() {
        if (closed) throw new CompanyDiscoveryError('closed', 'Company discovery is closed.')
    }

    async function assertCaller(input: { workspaceId: string; chatId: string }) {
        assertOpen()
        if (!deps.authority) throw new CompanyDiscoveryError('authority_unbound', 'Company discovery authority is unbound.')
        const workspaceId = companyWorkspaceIdSchema.parse(input.workspaceId)
        const chatId = companyChatIdSchema.parse(input.chatId)
        if ((await deps.authority.currentWorkspaceId()) !== workspaceId) throw new CompanyDiscoveryError('stale_workspace', 'That workspace is not the open workspace.')
        const owner = await deps.authority.owner({ workspaceId, chatId })
        if (owner === 'deleted') throw new CompanyDiscoveryError('owner_deleted', 'That chat has been deleted.')
        if (owner === 'disabled') throw new CompanyDiscoveryError('owner_disabled', 'That chat is disabled.')
        if (owner === 'replaced') throw new CompanyDiscoveryError('owner_replaced', 'That chat was replaced.')
        return { workspaceId, chatId }
    }

    async function assertCurrent(snapshot: DesktopCompanyDiscoverySnapshot, signal: AbortSignal) {
        signal.throwIfAborted()
        await assertCaller(snapshot)
        await deps.authority!.assertRun(snapshot, signal)
        signal.throwIfAborted()
    }

    // The local SQLite driver opens a second connection for ordinary client reads. Never
    // await run/network authority under its write lock: a Foreman poll can synchronously
    // wait for that lock and prevent the authority response from resuming this writer.
    // Async authority is checked immediately before admission and again after commit;
    // only synchronous lifetime checks may run inside a database transaction.
    function assertWriting(signal: AbortSignal) {
        assertOpen()
        signal.throwIfAborted()
    }

    async function apply(snapshot: DesktopCompanyDiscoverySnapshot, event: CompanyDiscoveryEvent, signal: AbortSignal): Promise<boolean> {
        await assertCurrent(snapshot, signal)
        const parsed = companyDiscoveryEventSchema.parse(event)
        const applied = await deps.store.transaction(async tx => {
            assertWriting(signal)
            const row = await tx.byId(snapshot.workspaceId, snapshot.chatId, snapshot.discoveryId)
            const current = present(row)
            if (!current || current.status !== 'running') return null
            const next = applyCompanyDiscoveryEvent(current, parsed, now())
            if (!next) return null
            if (parsed.type === 'settled') {
                const inserted = await tx.insertRevision(snapshot.discoveryId, parsed.source, parsed.revision, { status: parsed.status, reason: parsed.reason, payload: parsed.payload, provenance: parsed.provenance })
                if (!inserted) return null
            }
            assertWriting(signal)
            await tx.put(next)
            return next
        })
        if (!applied) return false
        await assertCurrent(snapshot, signal)
        await deps.published?.(applied, signal)
        return true
    }

    async function finish(snapshot: DesktopCompanyDiscoverySnapshot, status: 'stopped' | 'failed') {
        await deps.store.transaction(async tx => {
            const current = present(await tx.byId(snapshot.workspaceId, snapshot.chatId, snapshot.discoveryId))
            if (!current || current.status !== 'running') return
            await tx.put({
                ...current,
                status,
                pending: [],
                updatedAt: now(),
                board: { ...current.board, entries: current.board.entries.filter(entry => entry.type !== 'teaser') },
            })
        })
    }

    async function runCollect(snapshot: DesktopCompanyDiscoverySnapshot, parent: AbortSignal, emitForeman?: (event: DesktopForemanDiscoveryEvent) => void) {
        if (!deps.run) throw new CompanyDiscoveryError('fetch_authority_unbound', 'Company discovery fetch authority is unbound.')
        const local = new AbortController()
        const signal = AbortSignal.any([parent, local.signal])
        stops.set(snapshot.discoveryId, local)
        const revisions = Object.fromEntries(snapshot.revisions.map(row => [row.source, row.revision])) as Partial<Record<CompanyDiscoverySource, number>>
        let queue = Promise.resolve()
        const work = (async () => {
            try {
                await assertCurrent(snapshot, signal)
                await deps.run!({
                    assertCurrent: () => assertCurrent(snapshot, signal),
                    url: snapshot.url,
                    signal,
                    now: deps.now ?? (() => new Date()),
                    revisions,
                    emit: event => {
                        queue = queue.then(() => apply(snapshot, event, signal)).then(applied => {
                            if (!applied || signal.aborted || !emitForeman) return
                            const projected = toForemanDiscoveryEvent(event)
                            if (projected) emitForeman(projected)
                        })
                        void queue.catch(() => {})
                    },
                })
                await queue
                if (signal.aborted) {
                    await finish(snapshot, 'stopped')
                    throw new CompanyDiscoveryError('cancelled', 'Discovery was stopped.')
                }
            } catch (error) {
                await queue.catch(() => {})
                if (signal.aborted || (error instanceof CompanyDiscoveryError && error.code === 'cancelled')) {
                    await finish(snapshot, 'stopped')
                    throw error instanceof CompanyDiscoveryError ? error : new CompanyDiscoveryError('cancelled', 'Discovery was stopped.')
                }
                await finish(snapshot, 'failed')
                throw error
            } finally {
                stops.delete(snapshot.discoveryId)
                inflight.delete(snapshot.discoveryId)
            }
        })()
        inflight.set(snapshot.discoveryId, work)
        await work
    }

    async function begin(input: CompanyDiscoveryBegin): Promise<DesktopCompanyDiscoverySnapshot> {
        const { workspaceId, chatId } = await assertCaller(input)
        if (!deps.run) throw new CompanyDiscoveryError('fetch_authority_unbound', 'Company discovery fetch authority is unbound.')
        const runId = companyRunIdSchema.parse(input.runId)
        const discoveryId = companyDiscoveryIdSchema.parse(input.discoveryId)
        let target: { url: string; domain: string }
        try { target = readCompanyDiscoveryTarget(input.url) } catch { throw new CompanyDiscoveryError('private_target', 'Only a public web address can be read.') }
        const existingWork = inflight.get(discoveryId)
        if (existingWork) {
            await existingWork.catch(() => {})
            const row = present(await deps.store.transaction(tx => tx.byId(workspaceId, chatId, discoveryId)))
            if (row) return row
        }
        const signal = input.signal ?? new AbortController().signal
        await deps.authority!.assertRun({ workspaceId, chatId, runId, discoveryId }, signal)
        const created = await deps.store.transaction(async tx => {
            assertWriting(signal)
            const byRun = await tx.byRun(workspaceId, chatId, runId)
            if (byRun?.state === 'unknown') throw new CompanyDiscoveryError('conflict', 'The saved discovery for this run cannot be read.')
            if (byRun?.state === 'present') {
                if (byRun.snapshot.discoveryId !== discoveryId || byRun.snapshot.url !== target.url) throw new CompanyDiscoveryError('conflict', 'That run belongs to another discovery request.')
                return { snapshot: byRun.snapshot, fresh: false }
            }
            const byId = await tx.byId(workspaceId, chatId, discoveryId)
            if (byId) throw new CompanyDiscoveryError('stale_run', 'That discovery belongs to another run.')
            const snapshot = companyDiscoverySnapshotSchema.parse(emptyCompanyDiscoverySnapshot({ discoveryId, workspaceId, chatId, runId, url: target.url, domain: target.domain, startedAt: now() }))
            assertWriting(signal)
            const inserted = await tx.insert(snapshot)
            if (inserted === 'exists') {
                const again = present(await tx.byRun(workspaceId, chatId, runId))
                if (!again) throw new CompanyDiscoveryError('conflict', 'That discovery was saved by another writer.')
                return { snapshot: again, fresh: false }
            }
            return { snapshot, fresh: true }
        })
        if (!created.fresh) return created.snapshot
        await runCollect(created.snapshot, signal, input.emitForeman)
        const saved = present(await deps.store.transaction(tx => tx.byId(workspaceId, chatId, discoveryId)))
        if (!saved) throw new CompanyDiscoveryError('not_found', 'Discovery did not remain saved.')
        return saved
    }

    return {
        begin,
        async read(input: { workspaceId: string; chatId: string; discoveryId?: string }): Promise<CompanyDiscoveryRead> {
            const workspaceId = companyWorkspaceIdSchema.parse(input.workspaceId)
            const chatId = companyChatIdSchema.parse(input.chatId)
            const row = await deps.store.transaction(tx => input.discoveryId ? tx.byId(workspaceId, chatId, companyDiscoveryIdSchema.parse(input.discoveryId)) : tx.latest(workspaceId, chatId))
            if (!row) return { state: 'absent' }
            if (row.state === 'unknown') return { state: 'unknown', discoveryId: row.discoveryId }
            let owner: CompanyDiscoveryOwner | 'unknown' = 'unknown'
            if (deps.authority) {
                try { owner = (await deps.authority.currentWorkspaceId()) === workspaceId ? await deps.authority.owner({ workspaceId, chatId }) : 'replaced' } catch { owner = 'unknown' }
            }
            return { state: 'present', snapshot: row.snapshot, owner }
        },
        async stop(input: { workspaceId: string; chatId: string; discoveryId: string }) {
            const { workspaceId, chatId } = await assertCaller(input)
            const discoveryId = companyDiscoveryIdSchema.parse(input.discoveryId)
            const row = await deps.store.transaction(tx => tx.byId(workspaceId, chatId, discoveryId))
            if (!row) throw new CompanyDiscoveryError('not_found', 'That discovery is not in this chat.')
            if (row.state === 'unknown') throw new CompanyDiscoveryError('conflict', 'That discovery cannot be read.')
            stops.get(discoveryId)?.abort()
            const work = inflight.get(discoveryId)
            if (work) await work.catch(() => {})
            else if (row.snapshot.status === 'running') await finish(row.snapshot, 'stopped')
        },
        async retry(input: { workspaceId: string; chatId: string; discoveryId: string; runId: string; requestId: string; signal?: AbortSignal; emitForeman?: (event: DesktopForemanDiscoveryEvent) => void }) {
            const { workspaceId, chatId } = await assertCaller(input)
            if (!deps.run) throw new CompanyDiscoveryError('fetch_authority_unbound', 'Company discovery fetch authority is unbound.')
            const discoveryId = companyDiscoveryIdSchema.parse(input.discoveryId)
            const runId = companyRunIdSchema.parse(input.runId)
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) throw new CompanyDiscoveryError('conflict', 'Retry needs a new request id.')
            const signal = input.signal ?? new AbortController().signal
            const prior = await deps.store.transaction(tx => tx.byId(workspaceId, chatId, discoveryId))
            if (!prior) throw new CompanyDiscoveryError('not_found', 'That discovery is not in this chat.')
            if (prior.state === 'unknown') throw new CompanyDiscoveryError('conflict', 'That discovery cannot be read.')
            if (prior.snapshot.runId !== runId) throw new CompanyDiscoveryError('stale_run', 'That discovery belongs to another run.')
            // Immutable retry receipts remain readable when the old run is no longer live.
            if (prior.snapshot.retries.includes(input.requestId)) return prior.snapshot
            await assertCurrent(prior.snapshot, signal)
            const prepared = await deps.store.transaction(async tx => {
                assertWriting(signal)
                const row = await tx.byId(workspaceId, chatId, discoveryId)
                if (!row) throw new CompanyDiscoveryError('not_found', 'That discovery is not in this chat.')
                if (row.state === 'unknown') throw new CompanyDiscoveryError('conflict', 'That discovery cannot be read.')
                if (row.snapshot.runId !== runId) throw new CompanyDiscoveryError('stale_run', 'That discovery belongs to another run.')
                if (row.snapshot.retries.includes(input.requestId)) return { snapshot: row.snapshot, fresh: false }
                if (row.snapshot.retries.length >= DESKTOP_COMPANY_DISCOVERY_LIMITS.maxRetries) throw new CompanyDiscoveryError('conflict', 'This discovery reached its retry limit. Start a new discovery.')
                if (row.snapshot.status === 'running' || inflight.has(discoveryId)) throw new CompanyDiscoveryError('conflict', 'Discovery is already running.')
                const snapshot: DesktopCompanyDiscoverySnapshot = { ...row.snapshot, status: 'running', attempt: row.snapshot.attempt + 1, retries: [...row.snapshot.retries, input.requestId], updatedAt: now() }
                assertWriting(signal)
                await tx.put(snapshot)
                return { snapshot, fresh: true }
            })
            if (!prepared.fresh) return prepared.snapshot
            await runCollect(prepared.snapshot, signal, input.emitForeman)
            const saved = present(await deps.store.transaction(tx => tx.byId(workspaceId, chatId, discoveryId)))
            if (!saved) throw new CompanyDiscoveryError('not_found', 'Discovery did not remain saved.')
            return saved
        },
        // Startup. Marks interrupted runs stopped. Does not fetch.
        async reconcile() {
            const rows = await deps.store.transaction(tx => tx.running())
            for (const row of rows) {
                if (row.state !== 'present' || inflight.has(row.snapshot.discoveryId)) continue
                await finish(row.snapshot, 'stopped')
            }
        },
        async close() {
            closed = true
            for (const stop of stops.values()) stop.abort()
            await Promise.all([...inflight.values()].map(work => work.catch(() => {})))
        },
        collectForForeman(input: { binding?: { workspaceId?: string; chatId?: string; runId?: string }; discoveryId?: string; url?: string; signal?: AbortSignal; emit?: (event: DesktopForemanDiscoveryEvent) => void }) {
            if (!input.binding?.workspaceId || !input.binding.chatId || !input.binding.runId || !input.discoveryId || !input.url || !input.signal || !input.emit) {
                throw new CompanyDiscoveryError('binding_unbound', 'Foreman did not pass the workspace, chat, run and discovery identity.')
            }
            return begin({ workspaceId: input.binding.workspaceId, chatId: input.binding.chatId, runId: input.binding.runId, discoveryId: input.discoveryId, url: input.url, signal: input.signal, emitForeman: input.emit })
        },
    }
}

export type CompanyDiscoveryRuntime = ReturnType<typeof createCompanyDiscoveryRuntime>
