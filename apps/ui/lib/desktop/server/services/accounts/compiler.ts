import 'server-only'

import { parseServiceRegistryKey, serviceRegistryKey, type DesktopServiceMethodAvailability } from '@rerun/contracts'
import { DESKTOP_SERVICE_ACCOUNT_MESSAGES as M } from '@rerun/contracts'
import { serviceManifestSchema, type AuthMethod, type InputDef, type ServiceManifest } from '@/lib/services/manifest'
import { instanceServerName } from '@/lib/services/instances'
import { compileCatalogOAuth, oauthAccountServerName } from '../oauth/compiler'
import { endpoint, serverName } from '../../mcp/model'

const INPUT_PLACEHOLDER = /\$\{input\.([A-Za-z0-9_]+)\}/g
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/
const HEADER_VALUE = /^[\x20-\x7e]{1,8192}$/
const BEARER_VALUE = /^[\x21-\x7e]{1,8192}$/
const HOSTED_PATH = /\/api\/(?:hub|mcp\/(?:managed|composio|apps))(?:\/|$)/
const HOSTED_HOST = /(?:^|\.)rerun\.build$/i
/** Catalog classifier text. A false availability with this reason is still compiled here. */
export const CATALOG_CUSTOM_HEADER_REASON = 'custom headers are not an exact Authorization Bearer input'

const FORBIDDEN_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
    'content-encoding',
    'content-type',
    'accept',
    'cookie',
    'set-cookie',
    'mcp-protocol-version',
    'mcp-session-id',
])

export type AccountHeaderPlanEntry = {
    name: string
    source: 'fixed' | 'input'
    inputKeys: string[]
    secret: boolean
}

export type AccountCompilePlan = {
    slug: string
    key: string
    instanceId?: string
    label: string
    name: string
    category: string
    icon: string | null
    methodId: string
    serverName: string
    url: string
    secretInput?: string
    skills: { name: string; description: string; body: string }[]
    headerPlan: AccountHeaderPlanEntry[]
    credentialInputs: string[]
    publicInputs: Record<string, string>
    shape: 'anonymous' | 'bearer' | 'headers' | 'oauth'
    oauthFingerprint?: string
    transport?: 'http' | 'sse'
}

export type AccountCompileResult = {
    plan: AccountCompilePlan
    /** Private. Seal this map and drop it. Never persist it on the plan. */
    headers: Record<string, string>
    /** Exact-Bearer mirror for the existing bearer column. Empty for every other shape. */
    bearer: string
}

export type AccountCompileTarget = { instanceId?: string; label: string }

function fail(message: string): never {
    throw new Error(message)
}

function assertNoForeignSubstitution(value: string) {
    if (value.replace(/\$\{input\.[A-Za-z0-9_]+\}/g, '').includes('${')) fail(M.substitution)
}

function shell(manifest: ServiceManifest, method: AuthMethod) {
    if (!['none', 'key'].includes(method.kind) || method.managed !== undefined || method.composio !== undefined || method.app !== undefined || method.mcpServers.length !== 1) {
        fail(M.localMethod)
    }
    const server = method.mcpServers[0]
    if (server.transport !== 'http' || server.oauth !== undefined || server.command !== undefined || server.args.length || Object.keys(server.env).length || !server.url || server.url.includes('${')) {
        fail(M.endpoint)
    }
    const url = endpoint(server.url)
    const parsed = new URL(url)
    if (parsed.href !== server.url || HOSTED_PATH.test(parsed.pathname) || HOSTED_HOST.test(parsed.hostname)) fail(M.hosted)
    return { server, url }
}

function skillsOf(manifest: ServiceManifest) {
    if (manifest.skills.length > 8 || manifest.skills.some(skill => !skill.name || skill.name.length > 128 || Buffer.byteLength(skill.body) > 65536 || skill.body.includes('${') || skill.description.includes('${') || skill.name.includes('${'))) {
        fail(M.skill)
    }
    return manifest.skills.map(skill => ({ name: skill.name, description: skill.description, body: skill.body }))
}

function publicInputs(inputs: InputDef[], values: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const input of inputs) {
        if (input.secret) continue
        const value = values[input.key]
        if (value !== undefined) out[input.key] = value
    }
    return out
}

function assertKnownValues(inputs: InputDef[], values: Record<string, string>) {
    const known = new Set(inputs.map(input => input.key))
    for (const key of Object.keys(values)) if (!known.has(key)) fail(M.unknownInput)
    for (const input of inputs) {
        if (input.required && !(values[input.key] ?? '').trim()) fail(input.secret ? M.credential : M.missing)
    }
}

function compileCustomHeaders(method: AuthMethod, values: Record<string, string>) {
    const inputs = new Map(method.inputs.map(input => [input.key, input]))
    assertKnownValues(method.inputs, values)
    if (method.envKeys.length) fail(M.substitution)
    const seen = new Set<string>()
    const headers: Record<string, string> = {}
    const headerPlan: AccountHeaderPlanEntry[] = []
    for (const [name, template] of Object.entries(method.mcpServers[0].headers)) {
        if (!HEADER_NAME.test(name)) fail(M.headerName)
        const lower = name.toLowerCase()
        if (seen.has(lower)) fail(M.headerDuplicate)
        seen.add(lower)
        if (FORBIDDEN_HEADERS.has(lower)) fail(M.headerTransport)
        assertNoForeignSubstitution(template)
        const inputKeys: string[] = []
        const value = template.replace(INPUT_PLACEHOLDER, (_match, key: string) => {
            const input = inputs.get(key)
            if (!input) fail(M.missingInput)
            if (!inputKeys.includes(key)) inputKeys.push(key)
            return values[key] ?? ''
        })
        if (!HEADER_VALUE.test(value)) fail(M.headerValue)
        const secret = lower === 'authorization' || inputKeys.some(key => inputs.get(key)?.secret === true)
        headerPlan.push({ name, source: inputKeys.length ? 'input' : 'fixed', inputKeys, secret })
        headers[name] = value
    }
    if (headerPlan.length === 0) fail(M.header)
    return { headers, headerPlan }
}

function assertNoSecretLeak(plan: AccountCompilePlan, headers: Record<string, string>) {
    const encoded = JSON.stringify(plan)
    for (const entry of plan.headerPlan) {
        if (!entry.secret) continue
        const value = headers[entry.name]
        if (value && value.length >= 12 && encoded.includes(value)) fail(M.leak)
    }
}

export function compileAccountService(
    raw: ServiceManifest,
    methodId: string,
    values: Record<string, string>,
    availability: DesktopServiceMethodAvailability,
    target: AccountCompileTarget,
): AccountCompileResult {
    const manifest = serviceManifestSchema.parse(raw)
    const method = manifest.authMethods.find(item => item.id === methodId)
    if (!method) fail(M.unknownMethod)
    if (availability.id !== methodId) fail(M.method)
    if (!availability.supported && availability.reason !== CATALOG_CUSTOM_HEADER_REASON) fail(M.method)
    if (method.mcpServers[0]?.transport === 'sse') {
        if (method.mcpServers.length !== 1) fail(M.endpoint)
        if (method.kind === 'oauth' || method.mcpServers[0].oauth !== undefined) fail('SSE OAuth is not available on this Mac.')
        const server = method.mcpServers[0]
        const converted = { ...manifest, authMethods: manifest.authMethods.map(row => row.id === methodId ? { ...row, mcpServers: [{ ...server, transport: 'http' as const }] } : row) }
        const compiled = compileAccountService(converted, methodId, values, availability, target)
        if (compiled.plan.shape !== 'anonymous' && compiled.plan.shape !== 'bearer') fail('SSE supports anonymous or one Bearer credential only.')
        return { ...compiled, plan: { ...compiled.plan, transport: 'sse' } }
    }
    if (method.kind === 'oauth') {
        if (Object.keys(values).length) fail(M.unknownInput)
        const oauth = compileCatalogOAuth(manifest, methodId)
        const key = serviceRegistryKey(manifest.slug, target.instanceId), parsedKey = parseServiceRegistryKey(key)
        if (parsedKey.slug !== manifest.slug || manifest.slug.includes('@') || (target.instanceId !== undefined && parsedKey.instanceId !== target.instanceId)) fail(M.instance)
        const plan: AccountCompilePlan = { slug: manifest.slug, key: serviceRegistryKey(manifest.slug, target.instanceId), ...(target.instanceId ? { instanceId: target.instanceId } : {}), label: target.label, name: manifest.name, category: manifest.category, icon: manifest.icon ?? null, methodId, serverName: serverName(oauthAccountServerName(oauth, target.instanceId)), url: oauth.endpoint, skills: oauth.skills, headerPlan: [], credentialInputs: [], publicInputs: {}, shape: 'oauth', oauthFingerprint: oauth.fingerprint }
        return { plan, headers: {}, bearer: '' }
    }
    const { server, url } = shell(manifest, method)
    const inputs = method.inputs
    const headerEntries = Object.entries(server.headers)
    const key = serviceRegistryKey(manifest.slug, target.instanceId)
    const parsedKey = parseServiceRegistryKey(key)
    if (parsedKey.slug !== manifest.slug || manifest.slug.includes('@') || (target.instanceId !== undefined && parsedKey.instanceId !== target.instanceId)) fail(M.instance)
    const resolvedName = target.instanceId ? instanceServerName(serverName(server.name), target.instanceId) : serverName(server.name)
    const base = {
        slug: manifest.slug,
        key,
        ...(target.instanceId ? { instanceId: target.instanceId } : {}),
        label: target.label,
        name: manifest.name,
        category: manifest.category,
        icon: manifest.icon ?? null,
        methodId,
        serverName: resolvedName,
        url,
        skills: skillsOf(manifest),
    }
    const anonymous = method.kind === 'none' || (inputs.length === 0 && headerEntries.length === 0)
    if (anonymous) {
        if (inputs.length || headerEntries.length || method.envKeys.length || Object.keys(values).length) fail(M.anonymous)
        const plan: AccountCompilePlan = { ...base, headerPlan: [], credentialInputs: [], publicInputs: {}, shape: 'anonymous' }
        return { plan, headers: {}, bearer: '' }
    }
    const exact = inputs.length === 1 && inputs[0].secret && headerEntries.length === 1 && headerEntries[0][0] === 'Authorization' && headerEntries[0][1] === `Bearer \${input.${inputs[0].key}}`
    if (exact) {
        const secretInput = inputs[0].key
        if (method.envKeys.some(mapping => mapping.fromInput !== secretInput)) fail(M.substitution)
        if (Object.keys(values).some(item => item !== secretInput)) fail(M.binding)
        const token = values[secretInput] ?? ''
        if (!BEARER_VALUE.test(token)) fail(M.bearer)
        const headerValue = `Bearer ${token}`
        const plan: AccountCompilePlan = {
            ...base,
            secretInput,
            headerPlan: [{ name: 'Authorization', source: 'input', inputKeys: [secretInput], secret: true }],
            credentialInputs: [secretInput],
            publicInputs: {},
            shape: 'bearer',
        }
        assertNoSecretLeak(plan, { Authorization: headerValue })
        return { plan, headers: { Authorization: headerValue }, bearer: token }
    }
    const compiled = compileCustomHeaders(method, values)
    const plan: AccountCompilePlan = {
        ...base,
        headerPlan: compiled.headerPlan,
        credentialInputs: method.inputs.filter(input => input.secret && compiled.headerPlan.some(entry => entry.inputKeys.includes(input.key))).map(input => input.key),
        publicInputs: publicInputs(method.inputs, values),
        shape: 'headers',
    }
    assertNoSecretLeak(plan, compiled.headers)
    return { plan, headers: compiled.headers, bearer: '' }
}
