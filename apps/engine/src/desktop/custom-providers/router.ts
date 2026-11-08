import { customProviderRequestSchema, customProviderReceiptSchema, customProviderSnapshotSchema, type CustomProviderAuthority } from '@rerun/contracts'
import { endpointBase } from './network.js'
import { probeCustomDraft } from './draft-probe.js'
import type { createCustomProviderRuntime } from './runtime.js'

/** No credential read is reachable through this Settings surface. */
export async function handleCustomProviderRequest(
    authority: CustomProviderAuthority,
    providers: ReturnType<typeof createCustomProviderRuntime>,
    workspaceId: number,
    checkWorkspace: (signal: AbortSignal) => Promise<void>,
    request: Request,
    signal = request.signal,
): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'Use POST.' }, { status: 405 })
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return Response.json({ error: 'Use JSON.' }, { status: 415 })
    try {
        const reader = request.body?.getReader()
        if (!reader) throw new Error('Missing body.')
        const chunks: Uint8Array[] = []
        let count = 0
        const cancel = () => { void reader.cancel().catch(() => {}) }
        signal.addEventListener('abort', cancel, { once: true })
        try {
            for (;;) {
                signal.throwIfAborted()
                const next = await reader.read()
                if (next.done) break
                count += next.value.length
                if (count > 64_000) throw new Error('Body too large.')
                chunks.push(next.value)
            }
        } finally {
            signal.removeEventListener('abort', cancel)
            await reader.cancel().catch(() => {})
            reader.releaseLock()
        }
        const input = customProviderRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        const requestedWorkspace = input.action === 'probe_draft' ? input.workspaceId : input.action === 'change'
            ? input.change.action === 'create' ? input.change.workspaceId : input.change.identity.workspaceId : input.identity.workspaceId
        if (requestedWorkspace !== workspaceId) return Response.json({ error: 'Custom connection belongs to another workspace.' }, { status: 403 })
        await checkWorkspace(signal)
        if (input.action === 'probe_draft') return Response.json(await probeCustomDraft(input, checkWorkspace, signal))
        if (input.action === 'read') {
            const snapshot = await authority.read(input.identity, signal)
            await authority.assertCurrent(input.identity, signal)
            return Response.json(customProviderSnapshotSchema.parse(snapshot))
        }
        if (input.action === 'probe') return Response.json(await providers.probe(input.identity, input.manualModel, signal))
        if (input.change.action !== 'disconnect') endpointBase(input.change.config)
        return Response.json(customProviderReceiptSchema.parse(await authority.change(input.change, signal)))
    } catch { return Response.json({ error: 'Custom provider request unavailable, cancelled or changed. Retry the same request to recover its receipt.' }, { status: 409 }) }
}
