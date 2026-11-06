import { readCatalog, getWorkspace } from '../workspaces/catalog.mjs'
import { missing, sameIdentity, refusal } from './protocol.mjs'

/** Concrete existing I35 bindings plus required root receipts for effects whose ACK can be lost. */
export function createRemoteSupervisorPorts({ dataRoot, installId, supervisor, draftQuit, currentRenderer, sendDraftFlush, transitions }) {
    if (!supervisor || typeof currentRenderer !== 'function') throw missing('W1-R-ACTOR')
    const requireTransition = method => {
        if (typeof transitions?.[method] !== 'function') throw missing(`W1-R-${method.toUpperCase()}`)
        return transitions[method].bind(transitions)
    }
    return {
        connectionState(owner, connection) {
            const runtime = supervisor.runtime, binding = runtime?.remoteMachine
            if (!runtime || runtime.workspaceId !== owner.workspaceId) return 'not_connected'
            if (!binding) return 'not_connected'
            return connection && binding.connectionId === connection.connectionId && binding.configurationRevision === connection.revision
                && sameIdentity(binding.identity, connection.identity) && binding.lifetimeId === runtime.launchNonce
                && supervisor.status.state === 'ready' ? 'connected' : 'unknown'
        },
        async checkActor(actor, signal) {
            signal.throwIfAborted()
            const { catalog, selection } = await readCatalog(dataRoot, installId)
            const renderer = currentRenderer(), runtime = supervisor.runtime
            if (actor.installId !== installId || selection.workspaceId !== actor.workspaceId || !catalog.workspaces.some(w => w.workspaceId === actor.workspaceId && w.pathStatus === 'ready')
                || runtime && (runtime.workspaceId !== actor.workspaceId || runtime.launchNonce !== actor.launchNonce) || !runtime && renderer?.recovery !== true || renderer?.epoch !== actor.rendererEpoch
                || renderer?.workspaceId !== actor.workspaceId || renderer?.launchNonce !== actor.launchNonce) throw refusal('stale', 'This workspace window is no longer current.')
            signal.throwIfAborted()
        },
        async checkOperation(context, signal) {
            signal.throwIfAborted()
            await requireTransition('checkOperation')(context, signal)
            signal.throwIfAborted()
        },
        lookupEffect: (context, signal) => requireTransition('lookupEffect')(context, signal),
        async effect(name, context, signal) {
            const apply = requireTransition('apply')
            // Root's canonical transition gate reserves/recovers the exact effect identity before
            // these available supervisor callbacks run. No receipt is fabricated here.
            return apply(name, context, async () => {
                if (name === 'freeze') { if (await supervisor.admissions('freeze', context.requestId) !== true) throw refusal('unavailable', 'New work could not be frozen.'); return {} }
                if (name === 'flush') {
                    if (!draftQuit.ready) throw refusal('unavailable', 'Save open drafts before changing servers.')
                    const saved = await draftQuit.request(sendDraftFlush)
                    if (!saved) throw refusal('unavailable', 'Open drafts were not saved.')
                    return { saved: true }
                }
                if (name === 'drain') return requireTransition('drainWork')(context, signal)
                if (name === 'close') { await requireTransition('closeOwnedRuntime')(context, signal); return { closed: true } }
                if (name === 'bind_remote') return requireTransition('bindRemote')(context, signal)
                if (name === 'bind_local') {
                    const { workspace } = await getWorkspace(dataRoot, installId, context.workspaceId)
                    if (!workspace || workspace.pathStatus !== 'ready') throw refusal('stale', 'This local workspace is unavailable.')
                    const runtime = await supervisor.startFor(context.workspaceId, { ...workspace, frozen: true })
                    if (runtime?.workspaceId !== context.workspaceId) throw refusal('identity_changed', 'The local workspace identity changed.')
                    return { lifetimeId: runtime.launchNonce }
                }
                if (name === 'verify') {
                    const result = await requireTransition('verifyTarget')(context, signal)
                    if (context.target && !sameIdentity(result.identity, context.target)) throw refusal('identity_changed', 'The remote workspace identity changed.')
                    return result
                }
                if (name === 'publish') return requireTransition('publishTarget')(context, signal)
                if (name === 'unfreeze') { if (await supervisor.admissions('unfreeze', context.requestId) !== true) throw refusal('uncertain', 'Work admission is not confirmed.'); return {} }
                throw missing('W1-R-LIFECYCLE')
            }, signal)
        },
        assertAvailable(effects) {
            for (const method of ['checkOperation', 'lookupEffect', 'apply']) requireTransition(method)
            const bindings = { drain: 'drainWork', close: 'closeOwnedRuntime', bind_remote: 'bindRemote', verify: 'verifyTarget', publish: 'publishTarget' }
            for (const effect of effects) if (bindings[effect]) requireTransition(bindings[effect])
            if (effects.includes('bind_local') && typeof supervisor.startFor !== 'function') throw missing('W1-A1')
        },
    }
}
