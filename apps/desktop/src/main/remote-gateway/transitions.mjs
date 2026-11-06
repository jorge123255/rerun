import { createHash } from 'node:crypto'
import { actor, identity, UUID, sameIdentity, refusal } from '../remote-machines/protocol.mjs'

const names = new Set(['freeze','flush','drain','close','bind_remote','bind_local','verify','publish','unfreeze'])
const exact = value => JSON.stringify(value)
function canonical(context, name) {
    if (!context || !UUID.test(context.installId) || !Number.isSafeInteger(context.workspaceId) || context.workspaceId < 1 || context.workspaceId > 1000000 || !UUID.test(context.requestId) || !UUID.test(context.receiptId)
        || !UUID.test(context.connectionId) || !UUID.test(context.configurationRevision) || !UUID.test(context.fromLaunchNonce)
        || !Number.isInteger(context.effectGeneration) || context.effectGeneration < 0 || context.effectGeneration > 8 || typeof context.selectedBefore !== 'boolean'
        || !['pair','replace','select','remove','health'].includes(context.kind) || !names.has(name)
        || context.effectId !== `${context.receiptId}:${context.effectGeneration}:${name}`) throw refusal('stale', 'This transition identity changed.')
    if (context.recoveryActor) actor(context.recoveryActor)
    return { installId: context.installId, workspaceId: context.workspaceId, requestId: context.requestId, receiptId: context.receiptId,
        effectId: context.effectId, kind: context.kind, target: context.target ? identity(context.target) : null,
        connectionId: context.connectionId, configurationRevision: context.configurationRevision, selectedBefore: context.selectedBefore,
        fromLaunchNonce: context.fromLaunchNonce, effectGeneration: context.effectGeneration }
}
function digest(context) { return createHash('sha256').update(exact(context)).digest('hex') }
function operation(state, context) {
    const op = state.operations.find(op => op.receipt.requestId === context.requestId)
    const r = op?.receipt
    if (!r || state.installId !== context.installId || state.workspaceId !== context.workspaceId || r.receiptId !== context.receiptId
        || r.connectionId !== context.connectionId || r.configurationRevision !== context.configurationRevision || r.effectGeneration !== context.effectGeneration
        || r.kind !== context.kind || op.acceptedBy.launchNonce !== context.fromLaunchNonce || op.selectedBefore !== context.selectedBefore
        || (op.target || context.target ? !sameIdentity(op.target, context.target) : false) || op.cancelRequested) throw refusal('stale', 'This exact transition is no longer current.')
    if (context.recoveryActor && exact(op.recoveredBy) !== exact(context.recoveryActor)) throw refusal('stale', 'This recovery actor changed.')
    return op
}
function publicValue(name, value, context) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['saved','closed','lifetimeId','identity'].includes(key))) throw refusal('uncertain', 'The lifecycle acknowledgement is not verifiable.')
    if (name === 'flush' && value.saved !== true || name === 'close' && value.closed !== true) throw refusal('uncertain', 'The lifecycle effect is not confirmed.')
    if (['bind_remote','bind_local','verify','publish'].includes(name) && !UUID.test(value.lifetimeId)) throw refusal('uncertain', 'The target lifetime is not confirmed.')
    const result = {}
    if (value.saved !== undefined) { if (value.saved !== true) throw refusal('uncertain', 'Draft flush is not confirmed.'); result.saved = true }
    if (value.closed !== undefined) { if (value.closed !== true) throw refusal('uncertain', 'Owned close is not confirmed.'); result.closed = true }
    if (value.lifetimeId !== undefined) { if (!UUID.test(value.lifetimeId)) throw refusal('uncertain', 'Lifetime is not confirmed.'); result.lifetimeId = value.lifetimeId }
    if (value.identity !== undefined) { result.identity = identity(value.identity); if (context.target && !sameIdentity(context.target, result.identity)) throw refusal('identity_changed', 'Target identity changed.') }
    if (context.target && ['bind_remote','verify','publish'].includes(name) && !result.identity) throw refusal('uncertain', 'Remote identity is not confirmed.')
    return result
}

/** Adds effect records to the EXISTING operation journal. No second catalog or credential store. */
export function createRemoteTransitionGate({ store, assertActor }) {
    if (typeof assertActor !== 'function') throw refusal('authority_missing', 'Native actor authority is required.')
    let tail = Promise.resolve(), closing = false
    const active = new Set(), nativeEffects = new Set(), shutdown = new AbortController()
    async function checkOperation(context, signal) {
        signal.throwIfAborted()
        const name = context.effectId?.split(':').at(-1), normalized = canonical(context, name)
        const state = await store.read(), op = operation(state, normalized)
        const expectedActor = op.recoveredBy ?? op.acceptedBy
        await assertActor(actor(expectedActor), context, signal)
        signal.throwIfAborted()
        operation(await store.read(), normalized)
        signal.throwIfAborted()
    }
    async function lookupEffect(context, signal) {
        await checkOperation(context, signal)
        const name = context.effectId.split(':').at(-1), normalized = canonical(context, name)
        const state = await store.read(), op = operation(state, normalized), record = op.lifecycleEffects?.[normalized.effectId]
        if (!record) return { state: 'not_applied' }
        if (record.fingerprint !== digest(normalized)) throw refusal('stale', 'Effect identity was reused with changed parameters.')
        if (record.state !== 'applied') return { state: 'unknown' }
        publicValue(name, record.receipt?.value, normalized)
        if (record.receipt.effectId !== normalized.effectId || record.receipt.requestId !== normalized.requestId || record.receipt.workspaceId !== normalized.workspaceId || record.receipt.installId !== normalized.installId || record.receipt.connectionId !== normalized.connectionId || record.receipt.configurationRevision !== normalized.configurationRevision || record.receipt.applied !== true) throw refusal('uncertain', 'Effect receipt identity changed.')
        return { state: 'applied', receipt: structuredClone(record.receipt) }
    }
    async function perform(name, context, effect, signal) {
        if (closing) throw refusal('cancelled', 'Transition admissions are closed.')
        const normalized = canonical(context, name), fingerprint = digest(normalized)
        await checkOperation(context, signal)
        let reserved = false
        // The canonical store serializes this reservation before any lifecycle callback is invoked.
        await store.mutate(state => {
            const op = operation(state, normalized)
            op.lifecycleEffects ??= {}
            const prior = op.lifecycleEffects[normalized.effectId]
            if (prior) {
                if (prior.fingerprint !== fingerprint) throw refusal('stale', 'Effect identity conflict.')
                if (prior.state !== 'applied') throw refusal('uncertain', 'A reserved lifecycle effect is not replayed.')
                return
            }
            if (Object.keys(op.lifecycleEffects).length >= 81) throw refusal('storage_full', 'Transition history was preserved.')
            op.lifecycleEffects[normalized.effectId] = { fingerprint, state: 'reserved' }; reserved = true
        })
        if (!reserved) { const known = await lookupEffect(context, signal); if (known.state !== 'applied') throw refusal('uncertain', 'Effect receipt unavailable.'); return known.receipt }
        try {
            await checkOperation(context, signal)
            const pendingEffect = Promise.resolve().then(() => { signal.throwIfAborted(); return effect(signal) })
            nativeEffects.add(pendingEffect)
            void pendingEffect.then(() => nativeEffects.delete(pendingEffect), () => nativeEffects.delete(pendingEffect))
            const value = publicValue(name, await abortable(pendingEffect, signal), normalized)
            await checkOperation(context, signal)
            const receipt = { effectId: normalized.effectId, requestId: normalized.requestId, workspaceId: normalized.workspaceId, installId: normalized.installId, connectionId: normalized.connectionId, configurationRevision: normalized.configurationRevision, applied: true, value }
            await store.mutate(state => {
                const op = operation(state, normalized), row = op.lifecycleEffects?.[normalized.effectId]
                if (!row || row.fingerprint !== fingerprint || row.state !== 'reserved') throw refusal('uncertain', 'Transition reservation changed.')
                row.state = 'applied'; row.receipt = receipt
            })
            return receipt
        } catch {
            // Retain the reservation on every ambiguous failure, including a lost durable write ACK.
            throw refusal('uncertain', 'This lifecycle effect needs exact outcome recovery; it was not replayed.')
        }
    }
    return {
        checkOperation, lookupEffect,
        apply(name, context, effect, signal) {
            const pending = tail.then(() => perform(name, structuredClone(context), effect, AbortSignal.any([signal, shutdown.signal, AbortSignal.timeout(60000)])))
            tail = pending.catch(() => {})
            active.add(pending); void pending.then(() => active.delete(pending), () => active.delete(pending))
            return pending
        },
        async close() { closing = true; shutdown.abort(); await abortable(Promise.allSettled([...active, ...nativeEffects]), AbortSignal.timeout(5000)) },
    }
}

function abortable(promise, signal) {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
        const abort = () => reject(refusal('uncertain', 'Owned lifecycle work has not confirmed its outcome or drain.'))
        signal.addEventListener('abort', abort, { once: true })
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
}
