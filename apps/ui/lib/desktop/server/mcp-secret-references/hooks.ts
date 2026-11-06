import 'server-only'
import type { DesktopMcpSecretReferenceAuthority, DesktopMcpSecretReferencePhase, DesktopMcpSecretTransport } from '../../../../../../packages/contracts/src/desktop-mcp-secret-references'
import type { DesktopMcpSecretLookup } from './lookup'
import { withDesktopMcpSecrets, type DesktopMcpResolvedMaterial, type DesktopMcpSecretAdmission } from './resolve'
import type { DesktopMcpSecretReferenceStore } from './store'

export type DesktopMcpSecretLifecycle = {
    mutate<T>(agent: string, name: string, write: () => Promise<T>): Promise<T>
    disconnect(agent: string, name?: string): void
}

export type DesktopMcpSecretReferenceHooks = {
    beforeHttp<T>(input: DesktopMcpSecretAdmissionInput, use: (material: DesktopMcpResolvedMaterial) => Promise<T>): Promise<DesktopMcpSecretAdmission<T>>
    beforeSse<T>(input: DesktopMcpSecretAdmissionInput, use: (material: DesktopMcpResolvedMaterial) => Promise<T>): Promise<DesktopMcpSecretAdmission<T>>
    beforeStdio<T>(input: DesktopMcpSecretAdmissionInput, use: (material: DesktopMcpResolvedMaterial) => Promise<T>): Promise<DesktopMcpSecretAdmission<T>>
    onSecretRotated(agentId: string, secretName: string): Promise<{ drained: string[] }>
    onSecretDeleted(agentId: string, secretName: string): Promise<{ drained: string[] }>
}

type DesktopMcpSecretAdmissionInput = {
    agentId: string
    serverName: string
    phase: DesktopMcpSecretReferencePhase
    config: unknown
}

async function drain(lifecycle: DesktopMcpSecretLifecycle, records: Pick<DesktopMcpSecretReferenceStore, 'serversForSecret' | 'markStale'>, authority: DesktopMcpSecretReferenceAuthority, agentId: string, secretName: string) {
    const owner = await authority.currentOwner(agentId)
    if (!owner || owner.agentId !== agentId || !owner.enabled || owner.deleting) return { drained: [] as string[] }
    const servers = await records.serversForSecret(agentId, secretName)
    for (const serverName of servers) {
        await lifecycle.mutate(agentId, serverName, () => records.markStale(agentId, serverName, secretName))
    }
    return { drained: servers }
}

export function bindDesktopMcpSecretReferences(deps: {
    lifecycle: DesktopMcpSecretLifecycle
    lookup: DesktopMcpSecretLookup
    authority: DesktopMcpSecretReferenceAuthority
    records: Pick<DesktopMcpSecretReferenceStore, 'bindings' | 'serversForSecret' | 'markStale'>
}): DesktopMcpSecretReferenceHooks {
    const admit = async <T>(transport: DesktopMcpSecretTransport, input: DesktopMcpSecretAdmissionInput, use: (material: DesktopMcpResolvedMaterial) => Promise<T>) => {
        const bindings = await deps.records.bindings(input.agentId, input.serverName)
        const admission = await withDesktopMcpSecrets({
            agentId: input.agentId,
            serverName: input.serverName,
            phase: input.phase,
            transport,
            config: input.config,
            bindings,
            authority: deps.authority,
            lookup: deps.lookup,
            use,
        })
        if (!admission.ok && admission.code === 'rotated') {
            await deps.lifecycle.mutate(input.agentId, input.serverName, async () => {
                for (const name of admission.rotated) await deps.records.markStale(input.agentId, input.serverName, name)
            })
        }
        return admission
    }
    return {
        beforeHttp: (input, use) => admit('http', input, use),
        beforeSse: (input, use) => admit('sse', input, use),
        beforeStdio: (input, use) => admit('stdio', input, use),
        onSecretRotated: (agentId, secretName) => drain(deps.lifecycle, deps.records, deps.authority, agentId, secretName),
        onSecretDeleted: (agentId, secretName) => drain(deps.lifecycle, deps.records, deps.authority, agentId, secretName),
    }
}
