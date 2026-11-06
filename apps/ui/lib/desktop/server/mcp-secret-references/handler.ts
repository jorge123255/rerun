import 'server-only'
import { desktopMcpSecretReferenceError, desktopMcpSecretReferenceSaveSchema } from '@rerun/contracts'
import type { DesktopMcpSecretGate, DesktopMcpSecretLookup } from './lookup'
import type { DesktopMcpSecretReferenceStore } from './store'

const unbound = () => Response.json({ error: 'mcp-secret-reference-authority-unbound' }, { status: 503, headers: { 'cache-control': 'no-store' } })
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export type DesktopMcpSecretReferenceActor = { agentId: string; origin: string }

export function createDesktopMcpSecretReferenceHandlers(deps: null | {
    store: Pick<DesktopMcpSecretReferenceStore, 'save' | 'head' | 'bindings' | 'receipt'>
    lookup: Pick<DesktopMcpSecretLookup, 'version'>
    gate: DesktopMcpSecretGate
}) {
    return {
        async get(request: Request, actor: DesktopMcpSecretReferenceActor): Promise<Response> {
            if (!deps) return unbound()
            const url = new URL(request.url)
            const agentId = url.searchParams.get('agentId') ?? ''
            const serverName = url.searchParams.get('serverName') ?? ''
            if (agentId !== actor.agentId) return json({ message: desktopMcpSecretReferenceError('forbidden').message }, 403)
            const saveId = url.searchParams.get('saveId')
            if (saveId) {
                await deps.gate.check()
                const receipt = await deps.store.receipt(actor.agentId, saveId)
                await deps.gate.check()
                return receipt ? json(receipt, 200) : json({ status: 'absent', saveId }, 404)
            }
            const head = await deps.store.head(actor.agentId, serverName)
            if (!head || head.origin !== actor.origin) return json({ message: 'Credential references are not recorded for this server.' }, 404)
            const bindings = await deps.store.bindings(actor.agentId, serverName)
            const requirements = []
            for (const binding of bindings) {
                const version = await deps.lookup.version(actor.agentId, binding.secretName, deps.gate)
                if (version.state === 'forbidden') return json({ message: desktopMcpSecretReferenceError('forbidden').message }, 403)
                requirements.push({
                    name: binding.secretName,
                    field: binding.field,
                    key: binding.fieldKey,
                    status: version.state === 'present' && binding.status === 'bound' && binding.secretVersion === version.version ? 'configured' as const : version.state === 'present' ? 'rotated' as const : 'pending' as const,
                    ...(version.state === 'present' ? { version: version.version } : {}),
                })
            }
            return json({
                agentId: actor.agentId,
                serverName,
                configRevision: head.configRevision,
                bindingRevision: head.bindingRevision,
                authority: head.authority,
                requirements,
            }, 200)
        },

        async post(request: Request, actor: DesktopMcpSecretReferenceActor): Promise<Response> {
            if (!deps) return unbound()
            const length = Number(request.headers.get('content-length') ?? '0')
            if (Number.isFinite(length) && length > 32768) return json({ message: 'The credential reference save is not valid.' }, 400)
            const text = await request.text()
            if (text.length > 32768) return json({ message: 'The credential reference save is not valid.' }, 400)
            let body: unknown
            try { body = JSON.parse(text) } catch { return json({ message: 'The credential reference save is not valid.' }, 400) }
            const parsed = desktopMcpSecretReferenceSaveSchema.safeParse(body)
            if (!parsed.success) return json({ message: 'The credential reference save is not valid.' }, 400)
            if (parsed.data.agentId !== actor.agentId || parsed.data.origin !== actor.origin) {
                return json({ message: desktopMcpSecretReferenceError('forbidden').message }, 403)
            }
            const result = await deps.store.save(parsed.data)
            const status = result.status === 'conflict' ? 409 : result.status === 'not-saved' ? 400 : 200
            return json(result, status)
        },
    }
}
