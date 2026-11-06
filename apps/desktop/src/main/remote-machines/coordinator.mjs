import { randomUUID } from 'node:crypto'
import { command, fingerprint, sameOwner, sameIdentity, publicReceipt, publicFailure, LIMITS, VERSION, UUID, refusal, missing, emptyHealth } from './protocol.mjs'
import { remoteAddress } from './network.mjs'
const effectNames = ['freeze', 'flush', 'drain', 'close', 'bind_remote', 'bind_local', 'verify', 'publish', 'unfreeze']
const stamp = () => new Date().toISOString()
export function createRemoteMachineCoordinator({ store, custody, client, ports }) {
    let active = null
    const closed = new AbortController()
    const find = (state, requestId) => state.operations.find(op => op.receipt.requestId === requestId)
    const resultError = (error, op) => ({ ok: false, ...publicFailure(error), receipt: publicReceipt(op) })
    async function edit(requestId, change) {
        await store.mutate(state => {
            const op = find(state, requestId)
            if (!op) throw refusal('stale', 'This server request is no longer available.')
            change(op, state)
            op.receipt.updatedAt = stamp(); op.receipt.revision = randomUUID()
        })
        return find(await store.read(), requestId)
    }
    const context = (op, name) => ({ installId: op.receipt.installId, workspaceId: op.receipt.workspaceId,
        requestId: op.receipt.requestId, receiptId: op.receipt.receiptId, effectId: `${op.receipt.receiptId}:${op.receipt.effectGeneration}:${name}`, effectGeneration: op.receipt.effectGeneration,
        kind: op.receipt.kind, connectionId: op.receipt.connectionId,
        configurationRevision: op.receipt.configurationRevision,
        selectedBefore: op.selectedBefore, fromLaunchNonce: op.acceptedBy.launchNonce, ...(op.recoveredBy ? { recoveryActor: op.recoveredBy } : {}), target: op.target ?? null })
    function exactEffect(receipt, ctx) {
        if (!receipt || receipt.applied !== true || receipt.effectId !== ctx.effectId || receipt.requestId !== ctx.requestId
            || receipt.workspaceId !== ctx.workspaceId || receipt.installId !== ctx.installId
            || receipt.connectionId !== ctx.connectionId || receipt.configurationRevision !== ctx.configurationRevision || !receipt.value || typeof receipt.value !== 'object') throw refusal('uncertain', 'The lifecycle returned another server transition receipt.')
        if (Object.keys(receipt.value).some(k => !['saved', 'closed', 'lifetimeId', 'identity'].includes(k))) throw refusal('uncertain', 'The lifecycle returned unsupported transition metadata.')
        return receipt
    }
    async function effect(requestId, name, signal, recover) {
        let op = find(await store.read(), requestId)
        const ctx = context(op, name)
        if (!effectNames.includes(name)) throw missing('W1-R-LIFECYCLE')
        signal.throwIfAborted(); await ports.checkOperation(ctx, signal)
        if (op.effects[name]) {
            if (op.effects[name].state === 'applied' && !recover) return exactEffect(op.effects[name].receipt, ctx).value
            if (!recover) throw refusal('uncertain', 'This lifecycle acknowledgement needs explicit recovery.')
            const known = await ports.lookupEffect(ctx, signal)
            await ports.checkOperation(ctx, signal); signal.throwIfAborted()
            if (known?.state === 'applied') {
                const receipt = exactEffect(known.receipt, ctx)
                if (op.effects[name].state === 'applied' && fingerprint(op.effects[name].receipt) !== fingerprint(receipt)) throw refusal('uncertain', 'A saved lifecycle receipt changed identity.')
                await edit(requestId, current => { current.effects[name] = { state: 'applied', receipt } })
                return receipt.value
            }
            if (known?.state !== 'not_applied' || op.effects[name].state === 'applied') throw refusal('uncertain', 'The prior lifecycle effect is still uncertain. Keep this exact request for recovery.')
        }
        await edit(requestId, current => { current.effects[name] = { state: 'reserved' } })
        const receipt = exactEffect(await ports.effect(name, ctx, signal), ctx)
        await ports.checkOperation(ctx, signal); signal.throwIfAborted()
        await edit(requestId, current => { current.effects[name] = { state: 'applied', receipt } })
        return receipt.value
    }
    async function reserve(input) {
        const normalized = ['pair', 'replace'].includes(input.action) ? remoteAddress(input.address) : null
        if (normalized?.includes(input.apiKey) || input.apiKey && [input.connectionId, input.requestId, input.actor.installId, input.actor.launchNonce, input.actor.rendererEpoch].includes(input.apiKey)) throw refusal('invalid', 'Keep server credentials separate from public identity fields.')
        const keyTag = normalized ? custody.tag(input.actor, input.apiKey) : null
        const print = fingerprint([input.actor.installId, input.actor.workspaceId, input.action, input.connectionId, input.expectedRevision, normalized, keyTag, input.confirmation ?? null])
        let candidate = null
        if (normalized) {
            candidate = { connectionId: input.connectionId, revision: randomUUID(), workspaceId: input.actor.workspaceId,
                address: normalized, identity: null, tlsPin: null, health: emptyHealth(), sealedKey: null }
            candidate.sealedKey = await custody.seal(input.actor, candidate, input.apiKey)
        }
        await ports.checkActor(input.actor, active.controller.signal)
        let replay = false
        await store.mutate(state => {
            const previous = find(state, input.requestId)
            if (previous) { if (previous.fingerprint !== print) throw refusal('stale', 'This request ID belongs to another server change.'); replay = true; return }
            if (state.operations.some(op => op.receipt.requiresRecovery)) throw refusal('busy', 'Recover the current server change before starting another.')
            if (state.operations.length >= LIMITS.receipts) throw refusal('storage_full', 'Server recovery storage is full. Existing request identities were preserved.')
            if (input.action === 'pair' ? state.connection !== null : !state.connection || state.connection.connectionId !== input.connectionId || state.connection.revision !== input.expectedRevision) throw refusal('stale', 'The server changed. Refresh before continuing.')
            const now = stamp()
            state.operations.push({ fingerprint: print, acceptedBy: input.actor, selectedBefore: state.selected, target: input.action === 'remove' ? null : candidate?.identity ?? state.connection?.identity ?? null,
                candidate: candidate ?? (input.action === 'remove' ? null : structuredClone(state.connection)), effects: {}, history: [], proof: null, cancelRequested: false,
                receipt: { version: VERSION, receiptId: randomUUID(), requestId: input.requestId, installId: input.actor.installId,
                    workspaceId: input.actor.workspaceId, kind: input.action, connectionId: input.connectionId, configurationRevision: candidate?.revision ?? state.connection.revision, expectedRevision: input.expectedRevision,
                    revision: randomUUID(), phase: 'accepted', effectGeneration: 0, closeAttempted: false, requiresRecovery: true, reason: null, createdAt: now, updatedAt: now } })
        })
        return { op: find(await store.read(), input.requestId), replay }
    }
    async function currentConfiguration(op) {
        const state = await store.read(), saved = find(state, op.receipt.requestId)
        if (!saved || saved.fingerprint !== op.fingerprint || !sameOwner(saved.receipt, op.receipt)) throw refusal('stale', 'This server operation owner changed.')
        if (!saved.localCommitted && (op.receipt.kind === 'pair' ? state.connection !== null : state.connection?.connectionId !== op.receipt.connectionId || state.connection?.revision !== op.receipt.expectedRevision)) throw refusal('stale', 'This server configuration changed during the request.')
        return { state, op: saved }
    }
    async function perform(input, recovering, signal) {
        const requestId = input.requestId
        let op = find(await store.read(), requestId)
        const setPhase = phase => edit(requestId, current => { current.receipt.phase = phase })
        const check = async () => {
            signal.throwIfAborted()
            const current = await currentConfiguration(op)
            if (current.op.cancelRequested) throw refusal('cancelled', 'The server change was cancelled.')
            if (current.op.effects.freeze || current.op.receipt.closeAttempted) await ports.checkOperation(context(current.op, 'verify'), signal)
            else await ports.checkActor(input.actor, signal)
            signal.throwIfAborted()
        }
        try {
            await check()
            if (op.receipt.kind !== 'remove' && !op.proof) {
                await setPhase('target_starting')
                const proof = await custody.use(op.receipt, op.candidate, apiKey => client.probe({ address: op.candidate.address, apiKey,
                    expectedIdentity: ['select', 'health'].includes(op.receipt.kind) ? op.candidate.identity : null,
                    tlsPin: ['select', 'health'].includes(op.receipt.kind) ? op.candidate.tlsPin : null }, check, signal))
                await check()
                op = await edit(requestId, current => { current.proof = proof; current.target = proof.identity; Object.assign(current.candidate, proof); current.receipt.phase = 'identity_verified' })
            }
            const transition = op.receipt.kind === 'select' || (op.selectedBefore && ['replace', 'remove'].includes(op.receipt.kind))
            if (transition) {
                ports.assertAvailable?.(effectNames.filter(name => name !== (op.receipt.kind === 'remove' ? 'bind_remote' : 'bind_local')))
                if (typeof ports.assertAvailable !== 'function') throw missing('W1-R-PREFLIGHT')
                if (typeof ports.checkOperation !== 'function' || typeof ports.effect !== 'function' || typeof ports.lookupEffect !== 'function') throw missing('W1-R-LIFECYCLE')
                await effect(requestId, 'freeze', signal, recovering); await setPhase('admissions_frozen')
                if ((await effect(requestId, 'flush', signal, recovering)).saved !== true) throw refusal('unavailable', 'Open drafts were not saved.')
                await setPhase('drafts_flushed'); await check()
                // Drain/close can partially commit before ACK. Reserve this boundary first.
                op = await edit(requestId, current => { current.receipt.closeAttempted = true; current.receipt.phase = 'old_runtime_closing' })
                await effect(requestId, 'drain', signal, recovering); await setPhase('work_drained')
                if ((await effect(requestId, 'close', signal, recovering)).closed !== true) throw refusal('uncertain', 'The prior connection has not confirmed closure.')
                await setPhase('old_runtime_closed'); await check()
                await setPhase('target_starting')
                const bound = await effect(requestId, op.receipt.kind === 'remove' ? 'bind_local' : 'bind_remote', signal, recovering)
                if (!UUID.test(bound.lifetimeId)) throw refusal('uncertain', 'The new runtime lifetime was not confirmed.')
                const verified = await effect(requestId, 'verify', signal, recovering)
                if (verified.lifetimeId !== bound.lifetimeId || op.receipt.kind !== 'remove' && !sameIdentity(verified.identity, op.target)) throw refusal('identity_changed', 'The target runtime identity did not match this server.')
                await setPhase('identity_verified'); await check()
                const published = await effect(requestId, 'publish', signal, recovering)
                if (published.lifetimeId !== verified.lifetimeId) throw refusal('uncertain', 'The active runtime publication was not confirmed.')
            } else if (op.receipt.kind === 'remove') {
                if (typeof ports.assertAvailable !== 'function') throw missing('W1-R-PREFLIGHT')
                ports.assertAvailable(['close'])
                op = await edit(requestId, current => { current.receipt.closeAttempted = true; current.receipt.phase = 'old_runtime_closing' })
                if ((await effect(requestId, 'close', signal, recovering)).closed !== true) throw refusal('uncertain', 'This saved server connection has not confirmed closure.')
            }
            await check()
            await store.mutate(state => {
                const current = find(state, requestId)
                if (!current || current.fingerprint !== op.fingerprint || current.cancelRequested) throw refusal('stale', 'This server change was cancelled or replaced.')
                if (current.localCommitted && (op.receipt.kind === 'remove' ? state.connection !== null : state.connection?.revision !== current.candidate?.revision)) throw refusal('stale', 'The committed server binding changed before recovery.')
                if (!current.localCommitted && (op.receipt.kind === 'pair' ? state.connection !== null : state.connection?.revision !== op.receipt.expectedRevision)) throw refusal('stale', 'The server changed before publication.')
                if (op.receipt.kind === 'remove') {
                    state.connection = null; state.selected = false; state.activeReceipt = null
                    for (const previous of state.operations) if (previous.candidate?.connectionId === op.receipt.connectionId) previous.candidate.sealedKey = null
                } else {
                    state.connection = structuredClone(current.candidate)
                    if (op.receipt.kind === 'select' || op.receipt.kind === 'replace' && op.selectedBefore) state.selected = true
                }
                current.localCommitted = true
                current.receipt.phase = 'published'; current.receipt.reason = null; current.receipt.updatedAt = stamp(); current.receipt.revision = randomUUID()
                current.receipt.requiresRecovery = transition
                if (transition && op.receipt.kind !== 'remove') state.activeReceipt = publicReceipt(current)
            })
            if (transition) await effect(requestId, 'unfreeze', signal, recovering)
            op = await edit(requestId, (current, state) => {
                current.receipt.requiresRecovery = false; current.receipt.phase = 'published'; current.receipt.reason = null
                if (current.candidate) current.candidate.sealedKey = null
                if (state.activeReceipt?.requestId === requestId) state.activeReceipt = publicReceipt(current)
            })
            return { ok: true, snapshot: store.snapshot(await store.read(), input.actor), receipt: publicReceipt(op) }
        } catch (caught) {
            const error = signal.aborted ? refusal('cancelled', 'The server change was cancelled.') : caught
            op = find(await store.read(), requestId)
            let pending = op.receipt.closeAttempted
            if (!pending && op.effects.freeze) {
                try { await effect(requestId, 'unfreeze', AbortSignal.timeout(LIMITS.cleanupMs), true) }
                catch { pending = true }
            }
            const safe = resultError(error, op)
            op = await edit(requestId, (current, state) => {
                current.receipt.phase = current.receipt.closeAttempted ? 'failed_after_drain' : error?.code === 'cancelled' && !pending ? 'cancelled' : 'failed_before_drain'
                current.receipt.reason = safe.message; current.receipt.requiresRecovery = pending
                if (current.cancelRequested && !pending && current.candidate) current.candidate.sealedKey = null
                if (current.receipt.kind === 'health' && state.connection?.revision === current.receipt.expectedRevision) {
                    state.connection.health = { state: ['auth_needed', 'identity_changed', 'unsupported', 'cancelled'].includes(safe.code) ? safe.code : 'unreachable', checkedAt: stamp(), commit: null, activeAgents: null, reason: safe.message }
                }
            })
            return { ...safe, receipt: publicReceipt(op) }
        }
    }
    async function dispatch(raw, parentSignal = new AbortController().signal) {
        let input
        try {
            input = command(raw)
            const signal = AbortSignal.any([parentSignal, ...(['read', 'reconcile', 'receipt'].includes(input.action) ? [] : [closed.signal]), AbortSignal.timeout(LIMITS.operationMs)])
            await ports.checkActor(input.actor, signal)
            if (['read', 'reconcile', 'receipt'].includes(input.action)) {
                const state = await store.read(); await ports.checkActor(input.actor, signal)
                return { ok: true, snapshot: store.snapshot(state, input.actor), receipt: publicReceipt(find(state, input.requestId)) }
            }
            if (input.action === 'cancel') {
                const running = active?.requestId === input.requestId ? active : null
                running?.controller.abort()
                let op = find(await store.read(), input.requestId)
                if (!op) throw refusal('stale', 'This exact server request was not found.')
                if (op.receipt.phase === 'published' && !op.receipt.requiresRecovery) return { ok: true, snapshot: store.snapshot(await store.read(), input.actor), receipt: publicReceipt(op) }
                op = await edit(input.requestId, current => { current.cancelRequested = true })
                if (running) {
                    const work = running.work
                    await boundedDrain(work ? [work] : [])
                    op = find(await store.read(), input.requestId)
                }
                if (!running && !op.receipt.closeAttempted && !Object.keys(op.effects).length) op = await edit(input.requestId, current => { current.receipt.phase = 'cancelled'; current.receipt.requiresRecovery = false; if (current.candidate) current.candidate.sealedKey = null })
                return resultError(refusal('cancelled', op.receipt.requiresRecovery ? 'The server change still needs explicit recovery. Its prior runtime is not reopened.' : 'The server change was cancelled.'), op)
            }
            if (active) throw refusal('busy', 'Wait for the current server request to settle.')
            const controller = new AbortController(), entry = { requestId: input.requestId, controller, work: null }
            active = entry
            const workSignal = AbortSignal.any([signal, controller.signal])
            const work = (async () => {
                if (input.action === 'recover') {
                    const op = find(await store.read(), input.requestId)
                    if (!op || op.receipt.phase === 'cancelled') throw refusal('stale', 'This server request cannot be resumed.')
                    if (op.receipt.phase === 'published' && !op.receipt.requiresRecovery) return { ok: true, snapshot: store.snapshot(await store.read(), input.actor), receipt: publicReceipt(op) }
                    if (op.receipt.revision !== input.expectedReceiptRevision) throw refusal('stale', 'The server recovery decision changed. Refresh its exact receipt.')
                    await edit(input.requestId, current => { current.cancelRequested = false; current.recoveredBy = input.actor })
                    if (!op.receipt.closeAttempted && op.effects.freeze) {
                        await effect(input.requestId, 'unfreeze', workSignal, true)
                        await edit(input.requestId, current => {
                            if (current.receipt.effectGeneration >= 8) throw refusal('storage_full', 'This request reached its recovery bound. Its effect identities were preserved.')
                            current.history.push({ effectGeneration: current.receipt.effectGeneration, effects: current.effects })
                            current.effects = {}; current.receipt.effectGeneration++; current.proof = null
                        })
                    }
                    return perform(input, true, workSignal)
                }
                const { op, replay } = await reserve(input)
                if (replay) return op.receipt.phase === 'published' && !op.receipt.requiresRecovery
                    ? { ok: true, snapshot: store.snapshot(await store.read(), input.actor), receipt: publicReceipt(op) }
                    : resultError(refusal(op.receipt.requiresRecovery ? 'uncertain' : 'unavailable', op.receipt.reason || 'Read or explicitly recover this same server request.'), op)
                return perform(input, false, workSignal)
            })()
            entry.work = work
            try { return await work } finally { if (active === entry) active = null }
        } catch (error) {
            const op = input ? find(await store.read().catch(() => ({ operations: [] })), input.requestId) : null
            return resultError(error, op)
        }
    }
    async function boundedDrain(jobs) {
        let timer
        try { await Promise.race([Promise.allSettled(jobs), new Promise((_, reject) => { timer = setTimeout(() => reject(refusal('uncertain', 'This server connection has not finished stopping. Retry Stop for this exact request.')), LIMITS.cleanupMs) })]) }
        finally { clearTimeout(timer) }
    }
    return {
        execute: dispatch,
        async withCandidate(ctx, consume, signal) {
            await ports.checkOperation(ctx, signal)
            const state = await store.read(), op = find(state, ctx.requestId)
            const exact = op && context(op, 'bind_remote')
            if (!exact || ['installId', 'workspaceId', 'receiptId', 'effectId', 'connectionId', 'configurationRevision', 'fromLaunchNonce'].some(k => exact[k] !== ctx[k]) || op.cancelRequested) throw refusal('stale', 'The remote credential generation is no longer current.')
            const record = op.candidate?.sealedKey ? op.candidate : state.selected && state.connection?.connectionId === ctx.connectionId
                && state.connection.revision === ctx.configurationRevision ? state.connection : null
            if (!record?.sealedKey || !sameIdentity(record.identity, ctx.target)) throw refusal('stale', 'The selected remote connection was removed or replaced.')
            return custody.use(op.receipt, record, async key => {
                const result = await consume({ address: record.address, apiKey: key, identity: record.identity, tlsPin: record.tlsPin,
                    connectionId: record.connectionId, revision: record.revision })
                await ports.checkOperation(ctx, signal); signal.throwIfAborted()
                const fresh = await store.read(), current = find(fresh, ctx.requestId)
                if (!current || current.cancelRequested || !(current.candidate?.sealedKey && current.candidate.revision === record.revision)
                    && !(fresh.selected && fresh.connection?.revision === record.revision && fresh.connection.connectionId === record.connectionId)) throw refusal('stale', 'The remote credential generation changed during this request.')
                return result
            })
        },
        async close() { closed.abort(); active?.controller.abort(); if (active?.work) await boundedDrain([active.work]) },
    }
}
