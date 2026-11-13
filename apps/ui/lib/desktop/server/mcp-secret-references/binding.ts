import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { desktopMcpSecretReferencePlan, type DesktopMcpSecretReferenceOwner, type DesktopMcpSecretReferenceConfig, type DesktopMcpSecretReferenceSave } from '@rerun/contracts'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { createDesktopSecretRequestStore } from '../secret-requests/store'
import { desktopVaultMcpOpener, readDesktopMcpCredentialVersion } from '../vault/mcp-credentials'
import { createDesktopMcpSecretLookup } from './lookup'
import { createDesktopMcpSecretReferenceStore, DesktopMcpSecretReferenceConflict } from './store'
import { withDesktopMcpSecrets } from './resolve'
import { emptyMcpMaterialLease, type DesktopMcpMaterialLease, type DesktopMcpMaterialSource } from './lease'

export function createCanonicalMcpSecretReferences(deps: {
    db: Client
    key(): Buffer
    origin: string
    workspaceId: number
    shutdown: AbortSignal
    owner(agentId: string, signal: AbortSignal): Promise<DesktopMcpSecretReferenceOwner & { remoteMcpGranted: boolean; check(): void }>
    mutate<T>(agentId: string, serverName: string, work: () => Promise<T>): Promise<T>
    configuration(agentId: string, serverName: string): Promise<{ revision: string; config: DesktopMcpSecretReferenceConfig }>
}) {
    const crypto = createDesktopSecretCrypto(deps.key)
    const privateOpener = createDesktopSecretRequestStore(deps.db, crypto)
    const lookup = createDesktopMcpSecretLookup(deps.db, desktopVaultMcpOpener(deps.db, crypto, deps.workspaceId, privateOpener),
        (id, key) => readDesktopMcpCredentialVersion(deps.db, id, key))
    const authority = { currentOwner: async (id: string) => deps.owner(id, AbortSignal.any([deps.shutdown, AbortSignal.timeout(5000)])) }
    const records = createDesktopMcpSecretReferenceStore(deps.db, {
        authority,
        readVersion: readDesktopMcpCredentialVersion,
        captureAuthority: async id => {
            const current = await deps.owner(id, AbortSignal.any([deps.shutdown, AbortSignal.timeout(5000)]))
            return () => { deps.shutdown.throwIfAborted(); current.check() }
        },
        async commitPublicConfig({ agentId, serverName, expectedConfigRevision, config, tx }) {
            const revision = randomUUID()
            const saved = (await tx.execute(config.transport === 'stdio'
                ? { sql: 'SELECT revision,executable FROM desktop_mcp_stdio WHERE owner=? AND name=?', args: [agentId, serverName] }
                : { sql: 'SELECT revision,transport,url,bearer FROM desktop_remote_mcp WHERE agent_id=? AND name=?', args: [agentId, serverName] })).rows[0]
            if (!saved || String(saved.revision) !== expectedConfigRevision || config.transport === 'stdio' && String(saved.executable) !== config.command || config.transport !== 'stdio' && (String(saved.transport) !== config.transport || String(saved.url) !== config.url)) throw new DesktopMcpSecretReferenceConflict()
            if (config.transport !== 'stdio') {
                const oauth = (await tx.execute({ sql: 'SELECT name FROM desktop_remote_mcp_oauth WHERE agent_id=? AND name=?', args: [agentId, serverName] })).rows.length > 0
                if (config.oauth !== oauth || config.literalAuthorization !== !!saved.bearer) throw new DesktopMcpSecretReferenceConflict('Change bearer or OAuth in its authentication settings first.')
            }
            const result = config.transport === 'stdio'
                ? await tx.execute({ sql: 'UPDATE desktop_mcp_stdio SET args=?,revision=? WHERE owner=? AND name=? AND revision=?', args: [JSON.stringify(config.args), revision, agentId, serverName, expectedConfigRevision] })
                : await tx.execute({ sql: 'UPDATE desktop_remote_mcp SET revision=? WHERE agent_id=? AND name=? AND revision=? AND transport=? AND url=?', args: [revision, agentId, serverName, expectedConfigRevision, config.transport, config.url!] })
            if (result.rowsAffected !== 1) throw new DesktopMcpSecretReferenceConflict()
            return { configRevision: revision }
        },
    })
    const material: DesktopMcpMaterialSource = async (agentId, serverName, revision, phase, stop, acquisitionSignal = stop) => {
        const signal = AbortSignal.any([stop, deps.shutdown])
        const owner = await deps.owner(agentId, AbortSignal.any([signal, acquisitionSignal]))
        let settled = false
        const saved = await deps.configuration(agentId, serverName)
        const head = await records.head(agentId, serverName)
        if (saved.revision !== revision) throw new Error('MCP configuration changed')
        if (!head) return emptyMcpMaterialLease()
        if (head.configRevision !== revision || head.origin !== deps.origin) throw new Error('Credential references need review after the MCP configuration changed')
        const plan = desktopMcpSecretReferencePlan(JSON.parse(head.publicJson))
        if (!plan || plan.config.transport !== saved.config.transport || plan.config.url !== saved.config.url || plan.config.command !== saved.config.command) throw new Error('Credential references changed')
        const bindings = await records.bindings(agentId, serverName)
        const check = async () => {
            signal.throwIfAborted(); if (!settled) acquisitionSignal.throwIfAborted(); owner.check()
            const permissions = await deps.owner(agentId, signal)
            if (saved.config.transport === 'stdio' ? !permissions.localMcpStdioGranted : !permissions.remoteMcpGranted) throw new Error('MCP permission is off')
            const current = await deps.configuration(agentId, serverName), currentHead = await records.head(agentId, serverName)
            if (current.revision !== revision || currentHead?.configRevision !== revision || currentHead.bindingRevision !== head.bindingRevision || currentHead.fingerprint !== head.fingerprint) throw new Error('MCP credential configuration changed')
            for (const binding of bindings) {
                if (binding.status !== 'bound' || binding.secretVersion === null) throw new Error('MCP credentials are pending')
                const version = await readDesktopMcpCredentialVersion(deps.db, agentId, binding.secretName)
                if (version !== binding.secretVersion) throw new Error('MCP credentials changed; review the reference again')
            }
            signal.throwIfAborted(); if (!settled) acquisitionSignal.throwIfAborted(); owner.check()
        }
        let resolveReady!: (lease: DesktopMcpMaterialLease) => void
        let rejectReady!: (error: unknown) => void
        const ready = new Promise<DesktopMcpMaterialLease>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
        let finish!: () => void
        const held = new Promise<void>(resolve => { finish = resolve })
        const cancel = () => finish()
        signal.addEventListener('abort', cancel, { once: true })
        const operation = withDesktopMcpSecrets({ agentId, serverName, phase, transport: plan.config.transport, config: plan.config, bindings, head, authority, lookup, check,
            async use(value, guard) {
                const lease: DesktopMcpMaterialLease = { configured: true, material: value, check: async () => { await check(); await guard.check() }, protect: guard.protect, release: async () => { finish(); await operation.catch(() => {}) } }
                settled = true; resolveReady(lease)
                await held
                for (const key of Object.keys(value.headers)) value.headers[key] = ''
                for (const key of Object.keys(value.env)) value.env[key] = ''
                value.args.fill('')
            },
        }).then(result => { if (!result.ok) throw new Error(result.message) }).catch(error => { if (!settled) rejectReady(error) }).finally(() => signal.removeEventListener('abort', cancel))
        if (signal.aborted) cancel()
        return ready
    }
    return {
        records, lookup, material,
        async snapshot(agentId: string, serverName: string, signal: AbortSignal) {
            const owner = await deps.owner(agentId, signal), current = await deps.configuration(agentId, serverName), head = await records.head(agentId, serverName)
            const config = head?.configRevision === current.revision ? JSON.parse(head.publicJson) as DesktopMcpSecretReferenceConfig : current.config
            const bindings = head?.configRevision === current.revision ? await records.bindings(agentId, serverName) : []
            const presence = []
            for (const reference of desktopMcpSecretReferencePlan(config)?.references ?? []) {
                const bound = bindings.find(binding => binding.field === reference.field && binding.fieldKey === reference.key && binding.secretName === reference.name)
                const version = await lookup.version(agentId, reference.name, { check: () => { signal.throwIfAborted(); owner.check() } })
                presence.push({ name: reference.name, configured: bound?.status === 'bound' && version.state === 'present' && bound.secretVersion === version.version })
            }
            signal.throwIfAborted(); owner.check()
            return { agentId, origin: deps.origin, config, expectedConfigRevision: current.revision, expectedBindingRevision: head?.bindingRevision ?? 0, presence }
        },
        async reconcile(input: DesktopMcpSecretReferenceSave, signal: AbortSignal) {
            if (input.origin !== deps.origin) throw new Error('MCP settings belong to another workspace')
            signal.throwIfAborted()
            return deps.mutate(input.agentId, input.serverName, () => records.reconcile(input))
        },
        async save(input: DesktopMcpSecretReferenceSave, signal: AbortSignal) {
            if (input.origin !== deps.origin) throw new Error('MCP settings belong to another workspace')
            signal.throwIfAborted()
            return deps.mutate(input.agentId, input.serverName, async () => { signal.throwIfAborted(); return records.save(input) })
        },
        async credentialChanged(agentId: string, key: string) {
            for (const name of await records.serversForSecret(agentId, key)) await deps.mutate(agentId, name, () => records.markStale(agentId, name, key))
        },
    }
}
