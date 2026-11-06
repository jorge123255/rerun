import { command, actor, publicFailure, refusal, LIMITS } from './protocol.mjs'
const sameActor = (a, b) => a.installId === b.installId && a.workspaceId === b.workspaceId && a.launchNonce === b.launchNonce && a.rendererEpoch === b.rendererEpoch

/** Root provides trusted frame checks and the current main-owned renderer lease. */
export function createRemoteMachineIpc({ trusted, context }) {
    function current(event) {
        trusted(event)
        const value = context()
        if (!value?.binding) throw refusal('unavailable', 'Servers are unavailable while this workspace is changing.')
        actor(value.actor)
        return value
    }
    return {
        async actor(event) {
            try { return { ...current(event).actor } }
            catch { throw new Error('Servers are unavailable while this workspace is changing.') }
        },
        async execute(event, raw) {
            let input, result, dispatched = false
            try {
                const before = current(event)
                if (Buffer.byteLength(JSON.stringify(raw)) > (LIMITS.requestBytes ?? 16384)) throw refusal('invalid', 'This server request was not understood.')
                input = command(raw)
                if (!sameActor(input.actor, before.actor)) throw refusal('stale', 'This workspace window is no longer current.')
                dispatched = true
                result = await before.binding.execute(input)
                const after = current(event)
                if (before.binding !== after.binding || !sameActor(before.actor, after.actor)) throw refusal('uncertain', 'This workspace changed before its acknowledgement. Read this same request in the current window.')
                return result
            } catch (error) {
                if (dispatched && !['read', 'reconcile', 'receipt'].includes(input.action)) error = refusal('uncertain', 'This workspace changed before its acknowledgement. Read this same request in the current window.')
                return { ok: false, ...publicFailure(error), receipt: result?.receipt ?? null }
            }
        },
    }
}
