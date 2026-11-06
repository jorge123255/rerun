import 'server-only'
import { serviceManifestSchema, type ServiceManifest, type AuthMethod } from '@/lib/services/manifest'
import { instanceServerName } from '@/lib/services/instances'
import { parseServiceRegistryKey } from '@rerun/contracts'
import { endpoint, serverName } from '../../mcp/model'
import { SERVICE_TRANSPORT_LIMITS as L, serviceTransportRefSchema, type ServiceTransportRef, type ServiceTransportMethod } from '../../../../../../../packages/contracts/src/desktop-service-transports'

export class TransportFailure extends Error {
    constructor(public code: 'unavailable' | 'unsupported' | 'auth-needed' | 'changed' | 'grant' | 'invalid' | 'cancelled' | 'unknown' | 'close-unconfirmed') { super(code) }
}
export type Segment = { literal: string } | { input: string } | { basic: [string, string] }
export type Template = Segment[]
export type TransportPlan = {
    ref: ServiceTransportRef; slug: string; methodId: string; transport: 'sse' | 'stdio'; serverName: string;
    inputs: AuthMethod['inputs']; url?: Template; bearer?: Template; command?: string; args: Template[]; env: Record<string, Template>;
    skills: ServiceManifest['skills']; requiresOAuth: boolean;
}
const inputKey = /^[A-Za-z0-9_]{1,128}$/
const environmentKey = /^[A-Z_][A-Z0-9_]{0,127}$/
const blockedEnv = /^(?:PATH|HOME|SHELL|USER|TMPDIR|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|DYLD_.*|LD_.*|PYTHON.*|RUBY.*|PERL.*)$/
export function parseTemplate(value: string, inputs: AuthMethod['inputs'], basic = false): Template {
    if (Buffer.byteLength(value) > L.templateBytes || /[\x00-\x1f\x7f]/.test(value)) throw new TransportFailure('unsupported')
    const parts: Template = [], known = new Set(inputs.map(i => i.key)); let offset = 0
    for (const match of value.matchAll(/\$\{([^}]*)\}/g)) {
        if (match.index! > offset) parts.push({ literal: value.slice(offset, match.index) })
        const key = /^input\.([A-Za-z0-9_]+)$/.exec(match[1]), pair = /^basic:input\.([A-Za-z0-9_]+):input\.([A-Za-z0-9_]+)$/.exec(match[1])
        if (key && known.has(key[1])) parts.push({ input: key[1] })
        else if (basic && pair && known.has(pair[1]) && known.has(pair[2])) parts.push({ basic: [pair[1], pair[2]] })
        else throw new TransportFailure('unsupported')
        offset = match.index! + match[0].length
    }
    if (offset < value.length) parts.push({ literal: value.slice(offset) })
    if (parts.some(p => 'literal' in p && p.literal.includes('${'))) throw new TransportFailure('unsupported')
    return parts
}
function fixed(template: Template) { return template.every(p => 'literal' in p) }
export function compileServiceTransport(raw: ServiceManifest, methodId: string, ref: ServiceTransportRef): TransportPlan {
    serviceTransportRefSchema.parse(ref)
    const manifest = serviceManifestSchema.parse(raw), method = manifest.authMethods.find(m => m.id === methodId)
    if (!method || method.managed || method.composio || method.app || ['managed', 'composio', 'app'].includes(method.kind) || method.mcpServers.length !== 1) throw new TransportFailure('unsupported')
    const account = parseServiceRegistryKey(ref.key)
    if (account.slug !== manifest.slug || account.instanceId && !manifest.multiInstance) throw new TransportFailure('changed')
    if (method.inputs.length > L.inputs || new Set(method.inputs.map(i => i.key)).size !== method.inputs.length || method.inputs.some(i => !inputKey.test(i.key) || ['__proto__', 'constructor', 'prototype'].includes(i.key))) throw new TransportFailure('unsupported')
    const s = method.mcpServers[0], transport = s.transport ?? (s.command ? 'stdio' : s.url?.replace(/\/+$/, '').endsWith('/sse') ? 'sse' : 'http')
    if (transport !== 'sse' && transport !== 'stdio') throw new TransportFailure('unsupported')
    if (s.oauth !== undefined || method.kind === 'oauth') throw new TransportFailure('unsupported')
    const name = serverName(account.instanceId ? instanceServerName(s.name, account.instanceId) : s.name)
    if (manifest.skills.length > 8 || manifest.skills.some(s => !s.name || s.name.length > 128 || Buffer.byteLength(s.body) > 65536 || Buffer.byteLength(s.description) > 4096 || [s.name, s.description, s.body].some(v => v.includes('${') || v.includes('\0')))) throw new TransportFailure('unsupported')
    const env: Record<string, Template> = Object.create(null)
    for (const [key, value] of Object.entries(s.env)) {
        if (!environmentKey.test(key) || blockedEnv.test(key)) throw new TransportFailure('unsupported')
        env[key] = parseTemplate(value, method.inputs)
    }
    for (const mapping of method.envKeys) {
        if (!environmentKey.test(mapping.key) || blockedEnv.test(mapping.key) || !method.inputs.some(i => i.key === mapping.fromInput)) throw new TransportFailure('unsupported')
        const mapped: Template = [{ input: mapping.fromInput }]
        if (env[mapping.key] && JSON.stringify(env[mapping.key]) !== JSON.stringify(mapped)) throw new TransportFailure('unsupported')
        env[mapping.key] = mapped
    }
    if (Object.keys(env).length > L.env || s.args.length > L.args) throw new TransportFailure('unsupported')
    const plan: TransportPlan = { ref, slug: manifest.slug, methodId, transport, serverName: name, inputs: method.inputs, args: s.args.map(a => parseTemplate(a, method.inputs)), env, skills: manifest.skills, requiresOAuth: false }
    if (transport === 'sse') {
        if (!s.url || s.command || s.args.length || Object.keys(env).length) throw new TransportFailure('unsupported')
        plan.url = parseTemplate(s.url, method.inputs)
        if (plan.url.some(p => 'basic' in p || 'input' in p && method.inputs.find(i => i.key === p.input)?.secret)) throw new TransportFailure('unsupported')
        // Configured URLs keep the existing policy; session queries belong only to the SSE core.
        if (fixed(plan.url)) assertRemoteEndpoint(s.url)
        const headers = Object.entries(s.headers)
        if (headers.length) {
            if (headers.length !== 1 || headers[0][0] !== 'Authorization' || !/^Bearer \$\{input\.[A-Za-z0-9_]+\}$/.test(headers[0][1])) throw new TransportFailure('unsupported')
            const key = headers[0][1].slice(15, -1)
            if (!method.inputs.some(i => i.key === key && i.secret)) throw new TransportFailure('unsupported')
            plan.bearer = [{ input: key }]
        }
    } else {
        if (!s.command || s.command.includes('${') || Object.keys(s.headers).length || s.oauth || s.url) throw new TransportFailure('unsupported')
        if (!/^(?:npx|uvx|\/(?:[^\s\x00-\x1f]+))$/.test(s.command)) throw new TransportFailure('unsupported')
        plan.command = s.command
    }
    return plan
}
export function assertRemoteEndpoint(value: string) {
    const canonical = endpoint(value), url = new URL(canonical)
    if (canonical !== value || url.hostname.endsWith('.rerun.build') || url.hostname === 'rerun.build' || /\/api\/(?:hub|mcp\/(?:managed|composio|apps))(?:\/|$)/.test(url.pathname)) throw new TransportFailure('unsupported')
    return canonical
}
export function serviceTransportMethods(manifest: ServiceManifest, ref: ServiceTransportRef): ServiceTransportMethod[] {
    return serviceManifestSchema.parse(manifest).authMethods.map(m => {
        let availability: ServiceTransportMethod['availability'] = 'supported', reason: ServiceTransportMethod['reason'] = 'ready', transport: 'sse' | 'stdio' | undefined
        try {
            const p = compileServiceTransport(manifest, m.id, ref); transport = p.transport
            if (p.requiresOAuth) { availability = 'dependent'; reason = 'oauth' }
            else if (p.transport === 'stdio') {
                const secretArg = p.args.some(t => t.some(part => 'basic' in part || 'input' in part && p.inputs.find(i => i.key === part.input)?.secret))
                availability = secretArg ? 'unsupported' : 'dependent'; reason = secretArg ? 'secret-argv' : Object.keys(p.env).length ? 'environment' : 'program'
            }
        } catch { availability = 'unsupported'; reason = m.managed || m.composio || m.app ? 'hosted' : 'shape' }
        return { id: m.id, label: m.label, kind: m.kind, recommended: m.recommended, inputs: m.inputs, requiresSecrets: m.inputs.some(i => i.secret && i.required), availability, reason, ...(transport ? { transport } : {}) }
    })
}
