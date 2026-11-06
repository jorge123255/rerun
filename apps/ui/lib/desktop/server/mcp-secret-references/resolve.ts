import 'server-only'
import {
    desktopMcpSecretReferenceError,
    desktopMcpSecretReferenceLooksSecret,
    desktopMcpSecretReferencePlan,
    redactDesktopMcpSecretText,
    redactDesktopMcpSecretValue,
    DESKTOP_MCP_SECRET_REFERENCE_LIMITS,
    type DesktopMcpCredentialAuthority,
    type DesktopMcpSecretBinding,
    type DesktopMcpSecretReferenceAuthority,
    type DesktopMcpSecretReferencePhase,
    type DesktopMcpSecretTransport,
} from '../../../../../../packages/contracts/src/desktop-mcp-secret-references'
import type { DesktopMcpSecretGate, DesktopMcpSecretLookup } from './lookup'

export class DesktopMcpSecretReferenceFailure extends Error {
    readonly code: 'missing' | 'rotated' | 'invalid' | 'forbidden'
    constructor(code: 'missing' | 'rotated' | 'invalid' | 'forbidden', message: string) {
        super(message)
        this.name = 'DesktopMcpSecretReferenceFailure'
        this.code = code
    }
}

export type DesktopMcpResolvedMaterial = {
    command?: string
    args: string[]
    url?: string
    env: Record<string, string>
    headers: Record<string, string>
    inheritEnv: false
}

export type DesktopMcpSecretAdmission<T> =
    | {
          ok: true
          authority: DesktopMcpCredentialAuthority
          pending: []
          rotated: []
          invalid: []
          bound: { name: string; version: number }[]
          inheritEnv: false
          value: T
      }
    | {
          ok: false
          code: 'pending' | 'invalid' | 'forbidden' | 'rotated' | 'unsupported'
          pending: string[]
          rotated: string[]
          invalid: string[]
          message: string
      }

const refused = (code: 'pending' | 'invalid' | 'forbidden' | 'rotated' | 'unsupported', message: string, names: { pending?: string[]; rotated?: string[]; invalid?: string[] } = {}): DesktopMcpSecretAdmission<never> => ({
    ok: false,
    code,
    pending: names.pending ?? [],
    rotated: names.rotated ?? [],
    invalid: names.invalid ?? [],
    message,
})

function decodeSecret(bytes: Uint8Array): string | null {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        return null
    }
}

function injectable(value: string): boolean {
    return value.includes('\0') || value.includes('\r') || value.includes('\n')
}

export async function withDesktopMcpSecrets<T>(input: {
    agentId: string
    serverName: string
    phase: DesktopMcpSecretReferencePhase
    transport: DesktopMcpSecretTransport
    config: unknown
    bindings: readonly DesktopMcpSecretBinding[]
    authority: DesktopMcpSecretReferenceAuthority
    lookup: DesktopMcpSecretLookup
    use: (material: DesktopMcpResolvedMaterial) => Promise<T>
}): Promise<DesktopMcpSecretAdmission<T>> {
    if (input.phase !== 'discovery' && input.phase !== 'invocation') return refused('unsupported', 'Credential references are checked only at discovery and invocation.')
    const plan = desktopMcpSecretReferencePlan(input.config)
    if (!plan) return refused('invalid', desktopMcpSecretReferenceError('invalid').message, { invalid: ['config'] })
    if (plan.config.name !== input.serverName || plan.config.transport !== input.transport) return refused('unsupported', 'Credential references belong to a different MCP server.', { invalid: [input.serverName] })
    const owner = await input.authority.currentOwner(input.agentId)
    if (!owner || owner.agentId !== input.agentId || !owner.enabled || owner.deleting) return refused('forbidden', desktopMcpSecretReferenceError('forbidden').message)
    if (plan.references.length > 0 && !owner.selfMcpGranted) return refused('forbidden', desktopMcpSecretReferenceError('forbidden').message)
    if (plan.config.transport === 'stdio' && plan.references.length > 0 && !owner.localMcpStdioGranted) return refused('forbidden', desktopMcpSecretReferenceError('forbidden').message)
    if (input.bindings.some(binding => binding.agentId !== input.agentId || binding.serverName !== input.serverName)) {
        return refused('forbidden', desktopMcpSecretReferenceError('forbidden').message)
    }

    const pending: string[] = []
    const rotated: string[] = []
    const ready = new Map<string, number>()
    let admitted = false
    const gate: DesktopMcpSecretGate = { check() { if (!admitted) throw new Error('Credential use is not admitted.') } }
    for (const reference of plan.references) {
        const binding = input.bindings.find(item => item.field === reference.field && item.fieldKey === reference.key && item.secretName === reference.name)
        if (!binding || binding.status !== 'bound' || binding.secretVersion === null) {
            pending.push(reference.name)
            continue
        }
        const seen = ready.get(reference.name)
        if (seen !== undefined && seen !== binding.secretVersion) {
            rotated.push(reference.name)
            continue
        }
        admitted = true
        const version = await input.lookup.version(input.agentId, reference.name, gate)
        admitted = false
        if (version.state === 'forbidden') return refused('forbidden', desktopMcpSecretReferenceError('forbidden', reference.name).message)
        if (version.state === 'missing') pending.push(reference.name)
        else if (version.version !== binding.secretVersion) rotated.push(reference.name)
        else ready.set(reference.name, version.version)
    }
    if (rotated.length > 0) return refused('rotated', desktopMcpSecretReferenceError('rotated', rotated[0]).message, { rotated: [...new Set(rotated)], pending: [...new Set(pending)] })
    if (pending.length > 0) return refused('pending', desktopMcpSecretReferenceError('missing', pending[0]).message, { pending: [...new Set(pending)] })

    const names = [...ready.keys()]
    const copies: Uint8Array[] = []
    const wipe = () => { for (const copy of copies) copy.fill(0) }
    const assemble = (opened: Map<string, string>): DesktopMcpResolvedMaterial | null => {
        const headers: Record<string, string> = {}
        const env: Record<string, string> = {}
        const args = [...plan.config.args]
        for (const slot of plan.slots) {
            let value: string
            if (slot.kind === 'literal') value = slot.template
            else {
                const secret = opened.get(slot.name)
                if (secret === undefined) return null
                value = `${slot.prefix}${secret}${slot.suffix}`
            }
            if (injectable(value) || new TextEncoder().encode(value).byteLength > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.resolvedValue) return null
            if (slot.field === 'header') headers[slot.key] = value
            else if (slot.field === 'env') env[slot.key] = value
            else args[Number(slot.key)] = value
        }
        const material: DesktopMcpResolvedMaterial = { args, env, headers, inheritEnv: false }
        if (plan.config.command !== undefined) material.command = plan.config.command
        if (plan.config.url !== undefined) material.url = plan.config.url
        return material
    }

    const openAt = async (index: number, opened: Map<string, string>): Promise<DesktopMcpSecretAdmission<T>> => {
        if (index === names.length) {
            for (const slot of plan.slots) {
                if (slot.kind === 'literal' && desktopMcpSecretReferenceLooksSecret(slot.template)) copies.push(new TextEncoder().encode(slot.template))
            }
            const material = assemble(opened)
            if (!material) return refused('invalid', desktopMcpSecretReferenceError('invalid').message, { invalid: names })
            try {
                const value = redactDesktopMcpSecretValue(await input.use(material), copies)
                return {
                    ok: true,
                    authority: plan.authority,
                    pending: [],
                    rotated: [],
                    invalid: [],
                    bound: names.map(name => ({ name, version: ready.get(name)! })),
                    inheritEnv: false,
                    value,
                }
            } catch (error) {
                if (error instanceof DesktopMcpSecretReferenceFailure) throw error
                const message = redactDesktopMcpSecretText(error instanceof Error ? error.message : 'MCP credential use failed.', copies)
                throw new DesktopMcpSecretReferenceFailure('invalid', message)
            }
        }
        const name = names[index]!
        const openedSecret = await input.lookup.open(input.agentId, name, ready.get(name)!, gate, async bytes => {
            if (bytes.byteLength > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.resolvedValue) return refused('invalid', desktopMcpSecretReferenceError('invalid', name).message, { invalid: [name] })
            const copy = new Uint8Array(bytes)
            copies.push(copy)
            const text = decodeSecret(copy)
            if (text === null || injectable(text)) return refused('invalid', desktopMcpSecretReferenceError('invalid', name).message, { invalid: [name] })
            opened.set(name, text)
            return openAt(index + 1, opened)
        })
        if (openedSecret.state === 'present') return openedSecret.produced
        if (openedSecret.state === 'rotated') return refused('rotated', desktopMcpSecretReferenceError('rotated', name).message, { rotated: [name] })
        if (openedSecret.state === 'missing') return refused('pending', desktopMcpSecretReferenceError('missing', name).message, { pending: [name] })
        if (openedSecret.state === 'invalid') return refused('invalid', desktopMcpSecretReferenceError('invalid', name).message, { invalid: [name] })
        return refused('forbidden', desktopMcpSecretReferenceError('forbidden', name).message)
    }

    try {
        admitted = true
        return await openAt(0, new Map())
    } finally {
        admitted = false
        wipe()
    }
}
