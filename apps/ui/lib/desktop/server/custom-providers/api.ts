import 'server-only'
import { customProviderRequestSchema, customProviderReceiptSchema, customProviderSnapshotSchema, type CustomProviderAuthority } from '@rerun/contracts'
import { createCustomProviderRuntime } from '../../../../../engine/src/desktop/custom-providers/runtime'
import { endpointBase } from '../../../../../engine/src/desktop/custom-providers/network'
import { readDesktopRuntime, type DesktopRuntime } from '../runtime'
import { probeCustomDraft } from '../../../../../engine/src/desktop/custom-providers/draft-probe'

/** Mount only through existing desktopRoute. Authority is the same connection owner used by inference. */
export function createDesktopCustomProviderApi(authority: CustomProviderAuthority) {
    const providers = createCustomProviderRuntime(authority)
    return {
        async request(runtime: DesktopRuntime, request: Request): Promise<Response> {
            if (request.method !== 'POST') return Response.json({ error: 'Use POST.' }, { status: 405 })
            try {
                if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return Response.json({ error: 'Use JSON.' }, { status: 415 })
                const reader = request.body?.getReader()
                if (!reader) throw new Error()
                const chunks: Uint8Array[] = []; let count = 0
                try { for (;;) { const next = await reader.read(); if (next.done) break; count += next.value.length; if (count > 64_000) throw new Error(); chunks.push(next.value) } }
                catch { await reader.cancel().catch(() => {}); throw new Error() } finally { reader.releaseLock() }
                const bytes = new Uint8Array(count); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
                const input = customProviderRequestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
                const workspaceId = input.action === 'probe_draft' ? input.workspaceId : input.action === 'change' ? input.change.action === 'create' ? input.change.workspaceId : input.change.identity.workspaceId : input.identity.workspaceId
                if (workspaceId !== runtime.workspaceId) return Response.json({ error: 'Custom connection belongs to another workspace.' }, { status: 403 })
                request.signal.throwIfAborted()
                if (input.action === 'probe_draft') {
                    const check = async (signal: AbortSignal) => {
                        signal.throwIfAborted()
                        const current = await readDesktopRuntime()
                        signal.throwIfAborted()
                        if (current.workspaceId !== runtime.workspaceId || current.launchNonce !== runtime.launchNonce) throw new Error('Workspace changed.')
                    }
                    return Response.json(await probeCustomDraft(input, check, request.signal))
                }
                if (input.action === 'read') {
                    const snapshot = await authority.read(input.identity, request.signal)
                    await authority.assertCurrent(input.identity, request.signal)
                    return Response.json(customProviderSnapshotSchema.parse(snapshot))
                }
                if (input.action === 'probe') return Response.json(await providers.probe(input.identity, input.manualModel, request.signal))
                const change = input.change
                if (change.action !== 'disconnect') {
                    endpointBase(change.config)
                    if (change.action === 'update' && change.apiKey !== undefined && change.clearSecret) throw new Error()
                }
                const receipt = customProviderReceiptSchema.parse(await authority.change(change, request.signal))
                // A committed receipt survives cancellation. Never report a cancellation as a rollback.
                return Response.json(receipt)
            } catch { return Response.json({ error: 'Custom provider request unavailable, cancelled or changed. Retry the same request to recover its receipt.' }, { status: 409 }) }
        },
        close: () => providers.close(),
    }
}
