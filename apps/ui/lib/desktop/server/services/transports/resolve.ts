import 'server-only'
import { SERVICE_TRANSPORT_LIMITS as L } from '../../../../../../../packages/contracts/src/desktop-service-transports'
import { assertRemoteEndpoint, TransportFailure, type Template } from './compiler'
import type { TransportAuthority, ResolvedTransport, ValuePort, ProgramPort } from './types'
const blockedExecutable = /^(?:sh|bash|zsh|fish|csh|tcsh|ksh|env|sudo|npx|npm|pnpm|yarn|bunx|uvx|uv|pip|pip3|pipx|osascript|open|launchctl)$/
export async function resolveTransportMaterial(a: TransportAuthority, values: ValuePort, programs: ProgramPort, guard: () => Promise<void>, signal: AbortSignal): Promise<ResolvedTransport> {
    const p = a.plan, cache = new Map<string, string>()
    async function value(key: string) {
        if (cache.has(key)) return cache.get(key)!
        const def = p.inputs.find(i => i.key === key)
        if (!def) throw new TransportFailure('unsupported')
        await guard(); const source = await values.read(a.ref, key, signal); await guard()
        if (!source) { if (def.required) throw new TransportFailure('auth-needed'); cache.set(key, ''); return '' }
        if ((source.kind === 'secret') !== Boolean(def.secret)) throw new TransportFailure('changed')
        const resolved = source.kind === 'secret' ? await values.unseal(a.ref, source.reference, signal) : source.value
        await guard()
        if (typeof resolved !== 'string' || Buffer.byteLength(resolved) > L.inputBytes || /[\x00-\x1f\x7f]/.test(resolved) || def.required && !resolved.trim() || resolved.includes('${') || def.secret && /^[•*·.]{3,}$/.test(resolved)) throw new TransportFailure('auth-needed')
        if (def.type === 'select' && resolved && !def.options?.some(option => option.value === resolved)) throw new TransportFailure('invalid')
        cache.set(key, resolved); return resolved
    }
    async function render(t: Template, allowSecrets: boolean) {
        const parts: string[] = []
        for (const part of t) {
            if ('literal' in part) parts.push(part.literal)
            else if ('input' in part) {
                if (!allowSecrets && p.inputs.find(i => i.key === part.input)?.secret) throw new TransportFailure('unsupported')
                parts.push(await value(part.input))
            } else {
                if (!allowSecrets) throw new TransportFailure('unsupported')
                parts.push(Buffer.from(`${await value(part.basic[0])}:${await value(part.basic[1])}`).toString('base64'))
            }
        }
        const output = parts.join('')
        if (Buffer.byteLength(output) > L.templateBytes) throw new TransportFailure('invalid')
        return output
    }
    await guard()
    if (p.transport === 'sse') {
        const url = assertRemoteEndpoint(await render(p.url!, false))
        const bearer = p.requiresOAuth ? await values.oauthBearer?.(a, signal) : p.bearer ? await render(p.bearer, true) : undefined
        if (p.requiresOAuth && !bearer || bearer !== undefined && !/^[\x21-\x7e]{1,8192}$/.test(bearer)) throw new TransportFailure('auth-needed')
        await guard(); return { transport: 'sse', url, ...(bearer ? { bearer } : {}) }
    }
    const binding = await programs.resolve(a.ref, p.command!, p.args, signal)
    await guard()
    if (!binding) throw new TransportFailure('unavailable')
    if (!binding.executable.startsWith('/') || binding.executable.includes('/../') || /[\s\x00-\x1f\x7f]/.test(binding.executable) || blockedExecutable.test(binding.executable.split('/').pop()!) || binding.executable.split('/').some(part => part === '.' || part === '..')) throw new TransportFailure('unsupported')
    if (!binding.supportsEnvironment && Object.keys(p.env).length) throw new TransportFailure('unsupported')
    if (binding.args.length > L.args) throw new TransportFailure('unsupported')
    const args: string[] = []
    for (const template of binding.args) args.push(await render(template, false))
    if (args.some(v => v.length > 4096 || /^(?:-e|-c|--eval|--require|--import|--inspect)(?:=|$)/.test(v))) throw new TransportFailure('unsupported')
    const env: Record<string, string> = Object.create(null)
    for (const [key, template] of Object.entries(p.env)) env[key] = await render(template, true)
    await programs.validateArguments(binding.executable, args, signal)
    const executableIdentity = await programs.validateExecutable(binding.executable, signal)
    await guard()
    return { transport: 'stdio', executable: binding.executable, args, env, executableIdentity }
}
